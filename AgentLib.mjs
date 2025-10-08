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
import { startTyping, stopTyping } from './utils/typingIndicator.mjs';

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
        // Support both single role and array of roles
        let roles = [];
        
        if (Array.isArray(options.roles) && options.roles.length > 0) {
            roles = options.roles;
        } else {
            const providedRole = typeof options.role === 'string' && options.role.trim()
                ? options.role.trim()
                : (typeof options.callerRole === 'string' && options.callerRole.trim()
                    ? options.callerRole.trim()
                    : '');
            
            if (providedRole) {
                roles = [providedRole];
            }
        }

        if (!roles.length) {
            throw new Error('Agent rankSkill requires a role for access control.');
        }

        const verboseMode = options.verbose === true;
        const startTime = options.startTime || Date.now();
        
        // Show typing indicator during search
        if (verboseMode) {
            startTyping();
        }
        
        const flexSearchStart = Date.now();
        const registryOptions = { ...options, roles, includeScores: true };
        const rawMatches = this.skillRegistry.rankSkill(taskDescription, registryOptions);

        const matches = Array.isArray(rawMatches)
            ? rawMatches.map((entry) => {
                if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
                    return { name: entry.name, score: typeof entry.score === 'number' ? entry.score : null };
                }
                if (typeof entry === 'string') {
                    return { name: entry, score: null };
                }
                return null;
            }).filter(Boolean)
            : [];

        if (!matches.length) {
            if (verboseMode) {
                stopTyping();
            }
            throw new Error('No skills matched the provided task description.');
        }

        if (matches.length === 1) {
            if (verboseMode) {
                stopTyping();
            }
            return matches[0].name;
        }

        const normalizeName = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

        const candidates = matches.map(entry => {
            const skill = this.getSkill(entry.name);
            if (!skill) {
                return null;
            }
            const canonical = normalizeName(skill.name || entry.name);
            return {
                canonical,
                name: skill.name || entry.name,
                spec: skill,
                score: entry.score,
            };
        }).filter(Boolean);

        if (!candidates.length) {
            if (verboseMode) {
                stopTyping();
            }
            throw new Error('Unable to load candidate skill specifications for selection.');
        }

        let selectorAgent;
        try {
            selectorAgent = getAgent(options?.agentName);
        } catch (error) {
            if (verboseMode) {
                stopTyping();
            }
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
            score: entry.score,
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
            stopTyping();
        }

        const candidateMap = new Map();
        for (const candidate of candidates) {
            candidateMap.set(candidate.canonical, candidate);
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
                    selected = candidateMap.get(normalized)?.name;
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

        const finalSkill = candidateMap.get(normalizedSelected).name;

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

// Export feedback control utilities
export { 
    AgentConfig,
    createSilentAgent,
    createVerboseAgent,
    createConfiguredAgent,
    setGlobalFeedback,
} from './AgentConfig.mjs';
