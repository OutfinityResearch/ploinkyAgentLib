import {
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
    responseToJSON,
} from './markdown.mjs';

const DEFAULT_AGENT_NAME = 'DefaultLLMAgent';

class LLMAgent {
    constructor(options = {}) {
        const {
            name = DEFAULT_AGENT_NAME,
            fastModel = null,
            deepModel = null,
            invoker,
            metadata = {},
        } = options;

        if (!name || typeof name !== 'string') {
            throw new Error('LLMAgent requires a non-empty name.');
        }
        if (typeof invoker !== 'function') {
            throw new Error(`LLMAgent "${name}" requires an invoker function.`);
        }

        this.name = name;
        this.fastModel = fastModel;
        this.deepModel = deepModel || fastModel;
        this.invoker = invoker;
        this.metadata = { ...metadata };
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
        const modes = [];
        if (this.fastModel) {
            modes.push('fast');
        }
        if (this.deepModel) {
            modes.push('deep');
        }
        return modes.length ? modes : ['fast'];
    }

    resolveModel(mode = 'fast') {
        const normalized = typeof mode === 'string' ? mode.toLowerCase() : 'fast';
        if (normalized === 'deep' && this.deepModel) {
            return this.deepModel;
        }
        if (this.fastModel) {
            return this.fastModel;
        }
        if (this.deepModel) {
            return this.deepModel;
        }
        throw new Error(`LLMAgent "${this.name}" has no models configured.`);
    }

    async complete({ prompt, history = [], mode = 'fast', context = {} } = {}) {
        if (!prompt || typeof prompt !== 'string') {
            throw new Error('complete requires a prompt string.');
        }
        const conversation = Array.isArray(history) ? history.slice() : [];
        const model = this.resolveModel(mode);
        const response = await this.invoker({
            prompt,
            history: conversation,
            mode,
            model,
            agent: this,
            context,
        });
        if (typeof response === 'string') {
            return response;
        }
        if (response && typeof response === 'object' && typeof response.output === 'string') {
            return response.output;
        }
        throw new Error('LLMAgent invoker must return a string response.');
    }
}

export {
    LLMAgent,
    DEFAULT_AGENT_NAME,
};
