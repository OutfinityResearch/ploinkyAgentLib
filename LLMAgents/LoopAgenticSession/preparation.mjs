import { buildPreparationPrompt } from './prompts.mjs';
import { getParentContext } from './runtime.mjs';
import {
    coerceResultToText,
    getTimestamp,
    runWithRetry,
    injectContextIntoPrompt,
} from './utils.mjs';
import {
    SESSION_STATUS_AWAITING_INPUT,
    SESSION_STATUS_INTERRUPTED,
} from '../constants.mjs';

const PREPARATION_CONTEXT_PREFIX = '@context_';

function debugLog(logger, ...args) {
    if (logger) {
        logger.log(...args);
    }
}

function parseContextVariables(text = '', prefix = PREPARATION_CONTEXT_PREFIX) {
    if (!text) {
        return [];
    }
    const lines = text.split(/\r?\n/);
    const entries = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith(prefix)) {
            continue;
        }
        const match = line.match(/^(@context_[A-Za-z0-9_-]+)\s*(?::=|:|=)\s*(.+)$/);
        if (!match) {
            continue;
        }
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        entries.push({
            name: match[1],
            value,
        });
    }
    return entries;
}

function buildContextPieceLines(entries = []) {
    return entries.map((entry, index) => {
        const safeValue = String(entry.value ?? '').replace(/"/g, '\\"');
        return `@context-piece-${index + 1} := "${safeValue}"`;
    });
}

async function runPreparation({
    SessionClass,
    agent,
    tools,
    options = {},
    preparationText,
    userPrompt,
    contextPrefix = PREPARATION_CONTEXT_PREFIX,
    retries = 1,
}) {
    const preparationPrompt = buildPreparationPrompt(preparationText, userPrompt, options.preparationContext);
    if (!preparationPrompt) {
        return { contextEntries: [], contextLines: [] };
    }

    const logger = options.logger || null;
    debugLog(logger, `[${getTimestamp()}] [LoopSession] Preparation start`, {
        preparationLength: String(preparationText || '').length,
        userPromptLength: String(userPrompt || '').length,
        retries,
    });

    const attemptRun = async () => {
        const sessionOptions = {
            ...options,
            systemPrompt: 'Execute skills to prepare context for the user request.',
            preparationSession: true,
            enableClarifyContextTool: Boolean(getParentContext(options.parentContext)),
            parentContext: getParentContext(options.parentContext),
        };
        const session = new SessionClass({
            agent,
            tools,
            options: sessionOptions,
        });
        debugLog(logger, `[${getTimestamp()}] [LoopSession] Preparation session start`, {
            promptLength: String(preparationPrompt || '').length,
        });
        await session.newPrompt(preparationPrompt, { signal: options.signal });
        if (session.status === SESSION_STATUS_AWAITING_INPUT) {
            debugLog(logger, `[${getTimestamp()}] [LoopSession] Preparation awaiting input`, {
                status: session.status,
            });
            throw new Error('Preparation cannot continue because a preparation tool requested user input.');
        }
        if (session.status === SESSION_STATUS_INTERRUPTED) {
            const error = new Error('Preparation loop interrupted.');
            error.name = 'AbortError';
            throw error;
        }
        const resultText = coerceResultToText(session.getLastResult());
        const contextEntries = parseContextVariables(resultText, contextPrefix);
        const contextLines = buildContextPieceLines(contextEntries);
        debugLog(logger, `[${getTimestamp()}] [LoopSession] Preparation result parsed`, {
            rawTextLength: String(resultText || '').length,
            contextEntries: contextEntries.length,
            contextLines: contextLines.length,
        });
        return { contextEntries, contextLines, rawText: resultText };
    };

    return runWithRetry(attemptRun, retries);
}

async function preparePrompt(session, SessionClass, userPrompt, promptSignal) {
    session._ensureNotCancelled();
    try {
        await session._compressHistoryIfNeeded(userPrompt);
    } catch (error) {
        if (session._isAbortError(error) || session.status === SESSION_STATUS_INTERRUPTED) {
            throw error;
        }
        session._debug('[LoopSession]', 'History compression failed; continuing without compression', {
            error: error?.message || String(error),
        });
    }
    session._ensureNotCancelled();

    if (!session.preparation?.text) return userPrompt;
    const preparationTools = session.preparation?.tools && typeof session.preparation.tools === 'object'
        ? session.preparation.tools
        : session._userTools;
    const prepResult = await SessionClass.runPreparation({
        agent: session.agent,
        tools: preparationTools,
        options: {
            model: session.options.model,
            tags: session.options.tags,
            reasoningEffort: session.options.reasoningEffort,
            maxStepsPerTurn: session.options.maxStepsPerTurn,
            supervisor: session.supervisor,
            signal: promptSignal,
            parentContext: session.preparation.parentContext || null,
            preparationContext: session.preparation.context || '',
        },
        preparationText: session.preparation.text,
        userPrompt,
        retries: session.preparation.retries ?? 1,
    });
    session._ensureNotCancelled();
    const contextLines = prepResult?.contextLines || [];
    session.systemPrompt = injectContextIntoPrompt(session.baseSystemPrompt, contextLines);
    return injectContextIntoPrompt(userPrompt, contextLines);
}

export {
    PREPARATION_CONTEXT_PREFIX,
    parseContextVariables,
    buildContextPieceLines,
    runPreparation,
    preparePrompt,
};
