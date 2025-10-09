import {
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
    responseToJSON,
} from './markdown.mjs';
import { defaultLLMInvokerStrategy } from '../utils/LLMClient.mjs';

const DEFAULT_AGENT_NAME = 'DefaultLLMAgent';

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

class LLMAgent {
    constructor(options = {}) {
        const {
            name = DEFAULT_AGENT_NAME,
            invokerStrategy = null,
        } = options;

        if (!name || typeof name !== 'string') {
            throw new Error('LLMAgent requires a non-empty name.');
        }

        const resolvedStrategy = invokerStrategy || defaultLLMInvokerStrategy;
        if (typeof resolvedStrategy !== 'function') {
            throw new Error(`LLMAgent "${name}" requires an invokerStrategy function.`);
        }

        this.name = name;
        this.invokerStrategy = resolvedStrategy;
    }

    parseMarkdownKeyValues(markdown) {
        return extractKeyValuePairs(markdown);
    }

    parseMarkdownIdeas(markdown) {
        return extractIdeaList(markdown);
    }

    classifyMessage(message, options = {}) {
        return classifyIntent(message, options);
    }

    responseToJSON(markdown) {
        return responseToJSON(markdown);
    }

    async interpretMessage(message, { intents = ['accept', 'cancel', 'update'], instructions = null } = {}) {
        const heuristic = classifyIntent(message, { intents });
        if (heuristic.intent !== 'unknown' && (!intents.length || intents.includes(heuristic.intent))) {
            const hasMeaningfulUpdates = heuristic.updates && Object.keys(heuristic.updates).length;
            if (heuristic.intent !== 'update' || hasMeaningfulUpdates) {
                return heuristic;
            }
        }

        const promptSections = [
            instructions || 'Interpret the user response and summarise the intent.',
            `Expected intents: ${intents.join(', ') || 'accept, cancel, update'}.`,
            'Respond using Markdown bullet points, for example:',
            '- intent: accept|cancel|update|ideas',
            '- updates: field=value; other=value (if relevant)',
            '- ideas: item one; item two (optional)',
        ];

        const raw = await this.complete({
            prompt: promptSections.join('\n\n'),
            history: [{ role: 'user', message }],
            mode: 'fast',
            context: { intent: 'classify-message', expectedIntents: intents },
        });

        const keyValues = extractKeyValuePairs(raw);
        const ideas = extractIdeaList(raw);

        const primaryIntent = (keyValues.intent || keyValues.action || '').toLowerCase();
        const intent = primaryIntent && intents.includes(primaryIntent)
            ? primaryIntent
            : (ideas.length ? 'ideas' : 'unknown');

        const updatesRaw = keyValues.updates || keyValues.values;
        const updates = typeof updatesRaw === 'string'
            ? extractKeyValuePairs(updatesRaw)
            : updatesRaw || {};

        const fallbackUpdates = { ...keyValues };
        delete fallbackUpdates.intent;
        delete fallbackUpdates.action;
        delete fallbackUpdates.updates;
        delete fallbackUpdates.values;

        const mergedUpdates = { ...fallbackUpdates, ...updates };

        return {
            intent,
            confidence: intent === 'unknown' ? 0 : 0.6,
            updates: Object.keys(mergedUpdates).length ? mergedUpdates : undefined,
            ideas: ideas.length ? ideas : undefined,
            raw,
        };
    }

    getSupportedModes() {
        if (this.invokerStrategy && typeof this.invokerStrategy.getSupportedModes === 'function') {
            const modes = this.invokerStrategy.getSupportedModes();
            if (Array.isArray(modes) && modes.length) {
                return modes;
            }
        }
        return ['fast'];
    }

    async complete(options = {}) {
        const {
            prompt,
            history = [],
            mode = 'fast',
            model = null,
            context = {},
            ...invokerExtras
        } = options;

        if (!prompt || typeof prompt !== 'string') {
            throw new Error('complete requires a prompt string.');
        }

        const conversation = Array.isArray(history) ? history.slice() : [];
        const response = await this.invokerStrategy({
            prompt,
            history: conversation,
            mode,
            model,
            agent: this,
            context,
            ...invokerExtras,
        });
        if (typeof response === 'string') {
            return response;
        }
        if (response && typeof response === 'object' && typeof response.output === 'string') {
            return response.output;
        }
        throw new Error('LLMAgent invokerStrategy must return a string response.');
    }

    async doTask(agentContext, description, options = {}) {
        const {
            mode = 'fast',
            model = null,
            outputSchema = null,
            ...rest
        } = options;

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

        return this.complete({
            prompt,
            mode,
            model,
            context: { intent: 'task-execution' },
            ...rest,
        });
    }

    async doTaskWithReview(agentContext, description, options = {}) {
        const {
            mode = 'deep',
            maxIterations = 3,
            model = null,
            ...rest
        } = options;

        const prompt = [
            'Agent context:',
            serializeContext(agentContext),
            'Task description:',
            description,
            `Create a plan with at most ${maxIterations} steps and provide a reviewed answer.`,
            'Response:',
        ].filter(Boolean).join('\n\n');

        return this.complete({
            prompt,
            mode,
            model,
            context: { intent: 'task-review', maxIterations },
            ...rest,
        });
    }

    async doTaskWithHumanReview(agentContext, description, options = {}) {
        const draft = await this.doTask(agentContext, description, options);
        return {
            draft,
            humanReviewRequired: true,
        };
    }
}

export {
    LLMAgent,
    DEFAULT_AGENT_NAME,
};
