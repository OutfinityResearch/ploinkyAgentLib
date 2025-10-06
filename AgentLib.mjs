import readline from 'node:readline';

import { cancelRequests as cancelLLMRequests } from './LLMClient.mjs';
import SkillRegistry from './skills/SkillRegistry.mjs';
import { executeSkill } from './skills/SkillExecutor.mjs';
import { buildSystemHistory } from './context/contextBuilder.mjs';
import {
    commitAgentRecord,
    getAgent,
    listAgents as listRegisteredAgents,
    registerDefaultLLMAgent as registerDefaultAgent,
    resetAgentRegistryForTests,
} from './agents/agentRegistry.mjs';
import {
    buildModelRecordByName,
    categorizeModelsByMode,
    getOrderedModelNames,
    normalizeModelNameList,
    resetModelCatalogForTests,
} from './models/modelCatalog.mjs';
import {
    brainstormQuestion as runBrainstorm,
    executeDeepTask,
    executeFastTask,
    executeIteration,
    generatePlan,
    normalizeTaskMode,
    reviewCandidate,
} from './tasks/taskRunner.mjs';
import { invokeAgent } from './invocation/modelInvoker.mjs';
import { safeJsonParse } from './utils/json.mjs';
import { callOperator, chooseOperator, registerOperator, resetOperatorRegistry } from './operators/operatorRegistry.mjs';

let agentLibraryInstance = null;

function registerLLMAgent(options = {}) {
    return getAgentLibrary().registerLLMAgent(options);
}

function registerDefaultLLMAgent(options = {}) {
    return getAgentLibrary().registerDefaultLLMAgent(options);
}

async function doTask(agentName, context, description, outputSchema = null, mode = 'fast', retries = 3) {
    return getAgentLibrary().doTask(agentName, context, description, outputSchema, mode, retries);
}

async function doTaskWithReview(agentName, context, description, outputSchema = null, mode = 'deep', maxIterations = 5) {
    return getAgentLibrary().doTaskWithReview(agentName, context, description, outputSchema, mode, maxIterations);
}

async function doTaskWithHumanReview(agentName, context, description, outputSchema = null, mode = 'deep') {
    return getAgentLibrary().doTaskWithHumanReview(agentName, context, description, outputSchema, mode);
}

async function brainstorm(agentName, question, generationCount, returnCount, reviewCriteria = null) {
    return getAgentLibrary().brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria);
}

function cancelTasks() {
    getAgentLibrary().cancelTasks();
}

function listAgents() {
    return listRegisteredAgents();
}

function resetForTests() {
    resetOperatorRegistry();
    resetAgentRegistryForTests();
    resetModelCatalogForTests();
    agentLibraryInstance = null;
}

class Agent {
    constructor(options = {}) {
        const providedRegistry = options?.skillRegistry;
        if (providedRegistry && typeof providedRegistry.registerSkill === 'function' && typeof providedRegistry.rankSkill === 'function') {
            this.skillRegistry = providedRegistry;
        } else {
            this.skillRegistry = new SkillRegistry(options?.skillRegistryOptions);
        }
    }

    async readUserPrompt(query) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise(resolve => {
            rl.question(query, answer => {
                rl.close();
                resolve(answer);
            });
        });
    }

    registerSkill(skillObj) {
        return this.skillRegistry.registerSkill(skillObj);
    }

    async rankSkill(taskDescription, options = {}) {
        const providedRole = typeof options.role === 'string' && options.role.trim()
            ? options.role.trim()
            : (typeof options.callerRole === 'string' && options.callerRole.trim()
                ? options.callerRole.trim()
                : '');

        if (!providedRole) {
            throw new Error('Agent rankSkill requires a role for access control.');
        }

        const verboseMode = options.verbose === true;
        const startTime = options.startTime || Date.now();
        
        // Progressive display delay (configurable via env var, default 150ms)
        const progressiveDelay = process.env.LLMAgentClient_VERBOSE_DELAY 
            ? parseInt(process.env.LLMAgentClient_VERBOSE_DELAY, 10)
            : 150;
        const useProgressiveDisplay = verboseMode && progressiveDelay > 0;
        
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        
        const flexSearchStart = Date.now();
        const registryOptions = { ...options, role: providedRole };
        const matches = this.skillRegistry.rankSkill(taskDescription, registryOptions);

        if (!Array.isArray(matches) || matches.length === 0) {
            if (verboseMode) {
                const flexSearchTime = Date.now() - flexSearchStart;
                console.log(`[FlexSearch] No matches found (${flexSearchTime}ms)`);
            }
            throw new Error('No skills matched the provided task description.');
        }

        if (verboseMode) {
            const flexSearchTime = Date.now() - flexSearchStart;
            console.log(`\n[FlexSearch] Found ${matches.length} candidate${matches.length > 1 ? 's' : ''} (${flexSearchTime}ms):\n`);
            
            if (useProgressiveDisplay) {
                // Display candidates progressively with delays
                for (let index = 0; index < matches.length; index++) {
                    const name = matches[index];
                    const skill = this.getSkill(name);
                    const desc = skill?.description || skill?.what || 'No description';
                    const truncated = desc.length > 70 ? desc.slice(0, 67) + '...' : desc;
                    console.log(`  ${name}`);
                    console.log(`  ${truncated}\n`);
                    
                    // Add delay between candidates (but not after the last one)
                    if (index < matches.length - 1) {
                        await delay(progressiveDelay);
                    }
                }
            } else {
                // Display all at once (instant)
                matches.forEach((name, index) => {
                    const skill = this.getSkill(name);
                    const desc = skill?.description || skill?.what || 'No description';
                    const truncated = desc.length > 70 ? desc.slice(0, 67) + '...' : desc;
                    console.log(`  ${name}`);
                    console.log(`  ${truncated}\n`);
                });
            }
        }

        if (matches.length === 1) {
            if (verboseMode) {
                console.log(`[Result] Single match found, using: ${matches[0]}`);
            }
            return matches[0];
        }

        const normalizeName = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

        const candidates = matches.map(name => {
            const skill = this.getSkill(name);
            if (!skill) {
                return null;
            }
            const canonical = normalizeName(skill.name || name);
            return {
                canonical,
                name: skill.name || name,
                spec: skill,
            };
        }).filter(Boolean);

        if (!candidates.length) {
            throw new Error('Unable to load candidate skill specifications for selection.');
        }

        if (verboseMode) {
            console.log(`\n[LLM] Analyzing context to select best match...`);
            console.log(`[LLM] Evaluating ${candidates.length} candidates`);
        }

        let selectorAgent;
        try {
            selectorAgent = getAgent(options?.agentName);
        } catch (error) {
            throw new Error(`Unable to obtain language model for skill selection: ${error.message}`);
        }

        const selectionMode = normalizeTaskMode(options?.mode || 'fast', null, selectorAgent, 'fast');

        const candidateSummaries = candidates.map(entry => ({
            name: entry.name,
            description: entry.spec.description,
            what: entry.spec.what,
            why: entry.spec.why,
            arguments: entry.spec.arguments,
            requiredArguments: entry.spec.requiredArguments,
            roles: entry.spec.roles,
        }));

        const contextPayload = {
            taskDescription,
            candidates: candidateSummaries,
        };

        const history = buildSystemHistory(selectorAgent, {
            instruction: 'Review the candidate skills and choose the single best match for the task.',
            context: JSON.stringify(contextPayload, null, 2),
            description: 'Return JSON like {"skill": "<skill name>"}. If no skills are suitable, return {"skill": null}.',
            mode: selectionMode,
        });

        const llmStart = Date.now();
        const raw = await invokeAgent(selectorAgent, history, { mode: selectionMode });
        
        if (verboseMode) {
            const llmTime = Date.now() - llmStart;
            console.log(`[LLM] Selection completed (${llmTime}ms)`);
        }

        const candidateMap = new Map();
        for (const candidate of candidates) {
            candidateMap.set(candidate.canonical, candidate.name);
        }

        const parseSelection = (value) => {
            const parsed = safeJsonParse(typeof value === 'string' ? value : '');
            if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'skill')) {
                return parsed.skill;
            }
            return null;
        };

        let selected = parseSelection(raw);

        if (selected === null || selected === undefined) {
            if (typeof raw === 'string') {
                const trimmed = raw.trim();
                const normalized = normalizeName(trimmed);
                if (candidateMap.has(normalized)) {
                    selected = candidateMap.get(normalized);
                }
            }
        }

        if (selected === null || normalizeName(selected) === 'none' || normalizeName(selected) === 'no skill') {
            throw new Error('No suitable skill was selected for the task description.');
        }

        if (typeof selected !== 'string' || !selected.trim()) {
            throw new Error('Skill selection response was invalid.');
        }

        const normalizedSelected = normalizeName(selected);
        if (!candidateMap.has(normalizedSelected)) {
            throw new Error(`Selected skill "${selected}" was not among the matched candidates.`);
        }

        const finalSkill = candidateMap.get(normalizedSelected);
        
        if (verboseMode) {
            console.log(`[Result] LLM selected: ${finalSkill}`);
        }

        return finalSkill;
    }

    async useSkill(skillName, providedArgs = {}, options = {}) {
        const taskDescription = typeof options.taskDescription === 'string' ? options.taskDescription : '';
        const skipConfirmation = options.skipConfirmation === true;
        return executeSkill({
            skillName,
            providedArgs,
            getSkill: this.getSkill.bind(this),
            getSkillAction: this.getSkillAction.bind(this),
            readUserPrompt: this.readUserPrompt.bind(this),
            taskDescription,
            skipConfirmation,
        });
    }

    listSkillsForRole(role) {
        return this.skillRegistry.listSkillsForRole(role);
    }

    getSkill(skillName) {
        return this.skillRegistry.getSkill(skillName);
    }

    getSkillAction(skillName) {
        return this.skillRegistry.getSkillAction(skillName);
    }

    clearSkills() {
        this.skillRegistry.clear();
    }

    registerLLMAgent(options = {}) {
        const {
            name,
            role = '',
            job = '',
            expertise = '',
            instructions = '',
            fastModels = [],
            deepModels = [],
            kind = 'task',
            modelOrder = [],
            origin = 'registerLLMAgent',
        } = options;

        if (!name || typeof name !== 'string') {
            throw new Error('registerLLMAgent requires a non-empty "name".');
        }

        let normalizedFast = normalizeModelNameList(fastModels);
        let normalizedDeep = normalizeModelNameList(deepModels);

        if (!normalizedFast.length && !normalizedDeep.length) {
            const fallbackNames = getOrderedModelNames();
            const categorized = categorizeModelsByMode(fallbackNames);
            normalizedFast = categorized.fast;
            normalizedDeep = categorized.deep;
        }

        const explicitOrder = normalizeModelNameList(modelOrder);
        const combinedOrder = [];
        const seen = new Set();

        const pushInOrder = (list) => {
            for (const value of list) {
                if (!seen.has(value)) {
                    seen.add(value);
                    combinedOrder.push(value);
                }
            }
        };

        if (explicitOrder.length) {
            pushInOrder(explicitOrder);
        }
        pushInOrder(normalizedFast);
        pushInOrder(normalizedDeep);

        const configuredRecords = [];
        for (const modelName of combinedOrder) {
            const record = buildModelRecordByName(modelName);
            if (record) {
                configuredRecords.push(record);
            }
        }

        return commitAgentRecord({
            name,
            role,
            job,
            expertise,
            instructions,
            kind,
            configuredRecords,
            fastModelNames: normalizedFast,
            deepModelNames: normalizedDeep,
            origin,
        });
    }

    registerDefaultLLMAgent(options = {}) {
        registerDefaultAgent(options);
    }

    async doTask(agentName, context, description, outputSchema = null, mode = 'fast', retries = 3) {
        const agent = getAgent(agentName);
        const normalizedMode = normalizeTaskMode(mode, outputSchema, agent);

        let attempt = 0;
        let lastError = null;

        while (attempt < Math.max(retries, 1)) {
            try {
                if (normalizedMode === 'deep') {
                    return await executeDeepTask(agent, context, description, outputSchema);
                }
                return await executeFastTask(agent, context, description, outputSchema);
            } catch (error) {
                lastError = error;
                attempt += 1;
            }
        }

        throw new Error(`Task failed after ${retries} retries: ${lastError?.message || 'unknown error'}`);
    }

    async doTaskWithReview(agentName, context, description, outputSchema = null, mode = 'deep', maxIterations = 5) {
        const agent = getAgent(agentName);
        const normalizedMode = normalizeTaskMode(mode, outputSchema, agent, 'deep');

        const plan = normalizedMode === 'deep' ? await generatePlan(agent, context, description) : null;

        let iteration = 0;
        let feedback = '';

        while (iteration < Math.max(maxIterations, 1)) {
            iteration += 1;
            const candidate = await executeIteration(agent, context, description, outputSchema, iteration, feedback, plan, normalizedMode);

            const review = await reviewCandidate(agent, context, description, candidate.raw, outputSchema, iteration, normalizedMode);

            if (review.approved) {
                return candidate.parsed ?? { result: candidate.raw };
            }

            feedback = review.feedback || 'Improve and correct the prior answer.';
        }

        throw new Error('Maximum review iterations exceeded without an approved result.');
    }

    async doTaskWithHumanReview(agentName, context, description, outputSchema = null, mode = 'deep') {
        const agent = getAgent(agentName);
        const normalizedMode = normalizeTaskMode(mode, outputSchema, agent, 'deep');
        const plan = normalizedMode === 'deep' ? await generatePlan(agent, context, description) : null;
        let feedback = '';
        let iteration = 0;

        /* eslint-disable no-constant-condition */
        while (true) {
            iteration += 1;
            const candidate = await executeIteration(agent, context, description, outputSchema, iteration, feedback || '', plan, normalizedMode);
            const finalResult = candidate.parsed ?? { result: candidate.raw };

            console.log('----- Agent Result -----');
            console.log(typeof candidate.raw === 'string' ? candidate.raw : JSON.stringify(candidate.raw, null, 2));

            const approval = await this.readUserPrompt('Is the result okay? [Y/n/cancel]: ');
            const normalized = (approval || '').trim().toLowerCase();

            if (normalized === '' || normalized === 'y' || normalized === 'yes') {
                return finalResult;
            }
            if (normalized === 'cancel') {
                throw new Error('Task cancelled by user.');
            }

            feedback = await this.readUserPrompt('Please provide feedback for the agent: ');
        }
        /* eslint-enable no-constant-condition */
    }

    cancelTasks() {
        cancelLLMRequests();
    }

    async brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria = null) {
        return runBrainstorm(agentName, question, generationCount, returnCount, reviewCriteria);
    }
}

function getAgentLibrary() {
    if (!agentLibraryInstance) {
        agentLibraryInstance = new Agent();
    }
    return agentLibraryInstance;
}

export {
    Agent,
    brainstorm,
    callOperator,
    cancelTasks,
    chooseOperator,
    doTask,
    doTaskWithHumanReview,
    doTaskWithReview,
    listAgents,
    registerDefaultLLMAgent,
    registerLLMAgent,
    registerOperator,
};

export const __resetForTests = resetForTests;
