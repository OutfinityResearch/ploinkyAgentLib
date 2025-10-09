import { buildMissingMessage, buildNarrative } from './messages.mjs';
import { extractArgumentsWithLLM, interpretConfirmationWithLLM } from './llm.mjs';

function tryParseManualInput(context, input) {
    if (!input || typeof input !== 'string') {
        return {};
    }

    const trimmed = input.trim();

    const markdownPairs = context.llmAgent && typeof context.llmAgent.parseMarkdownKeyValues === 'function'
        ? context.llmAgent.parseMarkdownKeyValues(trimmed)
        : {};

    const updates = { ...markdownPairs };
    const tokens = trimmed.split(/[,;\n]+/);
    for (const token of tokens) {
        const [maybeName, ...rest] = token.split(/[:=]/);
        if (!maybeName || !rest.length) {
            continue;
        }
        const key = maybeName.trim();
        const value = rest.join(':').trim();
        if (!key || !value) {
            continue;
        }
        if (context.definitionMap.has(key)) {
            updates[key] = value;
        } else {
            const normalized = context.argumentDefinitions.find(def => def.name.toLowerCase() === key.toLowerCase());
            if (normalized) {
                updates[normalized.name] = value;
            }
        }
    }

    return updates;
}

async function applyUpdatesFromMessage(context, message, { taskDescription } = {}) {
    let updates = await extractArgumentsWithLLM(context, message, { taskDescription });
    if (!updates || Object.keys(updates).length === 0) {
        updates = tryParseManualInput(context, message);
    }
    if (updates && Object.keys(updates).length) {
        await context.applyUpdates(updates);
        return true;
    }
    return false;
}

async function mainLoop(context, {
    readUserPrompt,
    taskDescription = '',
} = {}) {
    if (typeof readUserPrompt !== 'function') {
        throw new Error('mainLoop requires a readUserPrompt function.');
    }

    if (taskDescription) {
        await applyUpdatesFromMessage(context, taskDescription, { taskDescription });
    }

    while (true) {
        const validation = context.validationState();
        if (!validation.valid) {
            const prompt = buildMissingMessage(context, validation);
            console.log(`${prompt}\n`);
            const input = await readUserPrompt('> ');
            if (!input || !input.trim()) {
                console.log('I did not receive any details. Let’s try again.');
                continue;
            }
            if (context.isCancellationIntent(input)) {
                throw new Error('Skill execution cancelled by user.');
            }
            const applied = await applyUpdatesFromMessage(context, input, { taskDescription });
            if (!applied) {
                console.log('I could not understand the changes. Please rephrase or provide key/value pairs.');
            }
            continue;
        }

        const summary = buildNarrative(context);
        const confirmation = await readUserPrompt(`${summary}\n> `);
        if (!confirmation || !confirmation.trim()) {
            console.log('I need a response to continue.');
            continue;
        }
        if (context.isCancellationIntent(confirmation)) {
            throw new Error('Skill execution cancelled by user.');
        }

        const classification = context.llmAgent && typeof context.llmAgent.interpretMessage === 'function'
            ? await context.llmAgent.interpretMessage(confirmation, { intents: ['accept', 'cancel', 'update', 'ideas'] })
            : null;

        if (classification) {
            if (classification.intent === 'cancel') {
                throw new Error('Skill execution cancelled by user.');
            }
            if (classification.intent === 'accept') {
                return context.toJSON();
            }
            if (classification.intent === 'update' && classification.updates && Object.keys(classification.updates).length) {
                await context.applyUpdates(classification.updates);
                continue;
            }
        }

        const interpretation = await interpretConfirmationWithLLM(context, confirmation);
        if (interpretation) {
            if (interpretation.action === 'accept') {
                return context.toJSON();
            }
            if (interpretation.action === 'cancel') {
                throw new Error('Skill execution cancelled by user.');
            }
            if (interpretation.action === 'update' && interpretation.updates) {
                await context.applyUpdates(interpretation.updates);
                continue;
            }
        }

        const fallbackApplied = await applyUpdatesFromMessage(context, confirmation, { taskDescription });
        if (!fallbackApplied) {
            console.log('I did not understand that response. Please reply with "accept", "cancel", or describe the changes.');
        }
    }
}

export {
    mainLoop,
};
