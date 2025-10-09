import readline from 'node:readline';

import SkillRegistry from './SkillRegistry.mjs';
import { executeSkill } from './SkillExecutor.mjs';

function defaultPromptReader(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(message, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

const serializeContext = (context) => {
    if (!context || typeof context !== 'object') {
        return '';
    }
    try {
        return JSON.stringify(context, null, 2);
    } catch (error) {
        return String(context);
    }
};

class SkilledAgent {
    constructor({ llmAgent, skillRegistry = null, promptReader = null } = {}) {
        if (!llmAgent) {
            throw new Error('SkilledAgent requires an LLMAgent instance.');
        }
        this.llmAgent = llmAgent;
        this.skillRegistry = skillRegistry instanceof SkillRegistry ? skillRegistry : new SkillRegistry();
        this.promptReader = typeof promptReader === 'function' ? promptReader : defaultPromptReader;
    }

    async readUserPrompt(prompt) {
        return this.promptReader(prompt);
    }

    registerSkill(config) {
        return this.skillRegistry.registerSkill(config);
    }

    rankSkill(taskDescription, options = {}) {
        return this.skillRegistry.rankSkill(taskDescription, options);
    }

    async useSkill(skillName, { args = {}, taskDescription = '' } = {}) {
        return executeSkill({
            skillName,
            providedArgs: args,
            getSkill: (name) => this.skillRegistry.getSkill(name),
            getSkillAction: (name) => this.skillRegistry.getSkillAction(name),
            readUserPrompt: (prompt) => this.readUserPrompt(prompt),
            taskDescription,
            llmAgent: this.llmAgent,
        });
    }

    listSkillsForRole(role) {
        return this.skillRegistry.listSkillsForRole(role);
    }

    getSkill(name) {
        return this.skillRegistry.getSkill(name);
    }

    getSkillAction(name) {
        return this.skillRegistry.getSkillAction(name);
    }

    clearSkills() {
        this.skillRegistry.clear();
    }

    async doTask(agentContext, description, { mode = 'fast', outputSchema = null } = {}) {
        if (!description || typeof description !== 'string') {
            throw new Error('doTask requires a task description string.');
        }
        const prompt = [
            'Agent context:',
            serializeContext(agentContext),
            'Task description:',
            description,
            outputSchema ? `Use the following output schema:\n${JSON.stringify(outputSchema, null, 2)}` : '',
            'Response:',
        ].filter(Boolean).join('\n\n');

        return this.llmAgent.complete({ prompt, mode, context: { intent: 'task-execution' } });
    }

    async doTaskWithReview(agentContext, description, { mode = 'deep', maxIterations = 3 } = {}) {
        const prompt = [
            'Agent context:',
            serializeContext(agentContext),
            'Task description:',
            description,
            `Create a plan with at most ${maxIterations} steps and provide a reviewed answer.`,
            'Response:',
        ].filter(Boolean).join('\n\n');

        return this.llmAgent.complete({ prompt, mode, context: { intent: 'task-review' } });
    }

    async doTaskWithHumanReview(agentContext, description, options = {}) {
        const draft = await this.doTask(agentContext, description, options);
        return {
            draft,
            humanReviewRequired: true,
        };
    }

    cancelTasks() {
        if (typeof this.llmAgent.cancel === 'function') {
            this.llmAgent.cancel();
        }
    }

    async brainstormQuestion(question, { generationCount = 5, mode = 'fast' } = {}) {
        const prompt = [
            'Generate concise ideas for the following question.',
            `Question: ${question}`,
            `List ${generationCount} distinct ideas as a numbered list.`,
            'Response:',
        ].join('\n\n');

        return this.llmAgent.complete({ prompt, mode, context: { intent: 'brainstorm' } });
    }
}

export {
    SkilledAgent,
};
