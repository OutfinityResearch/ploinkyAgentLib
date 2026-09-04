import { extractJson } from './prompts.mjs';

function estimateTokens(text = '') {
    return Math.ceil(String(text || '').length / 4);
}

function injectContextIntoPrompt(promptText, contextLines = []) {
    if (!contextLines.length) {
        return promptText;
    }
    const block = contextLines.join('\n');
    if (!promptText) {
        return block;
    }
    return `${promptText}\n\n${block}`;
}

const getTimestamp = () => {
    const now = new Date();
    return now.toISOString().slice(11, 23);
};

function coerceResultToText(result) {
    if (result == null) {
        return '';
    }
    if (typeof result === 'string') {
        return result;
    }
    if (typeof result === 'object') {
        if (typeof result.text === 'string') {
            return result.text;
        }
        if (typeof result.output === 'string') {
            return result.output;
        }
        if (typeof result.result === 'string') {
            return result.result;
        }
        try {
            return JSON.stringify(result);
        } catch (error) {
            return String(result);
        }
    }
    return String(result);
}

function formatLogValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
}

function cloneSerializable(value) {
    if (value === null || value === undefined) {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function coerceStructuredToolResult(value) {
    if (!value || typeof value !== 'string') {
        return value;
    }
    const parsed = extractJson(value);
    if (parsed && typeof parsed === 'object') {
        return parsed;
    }
    return value;
}

function formatInterruptionMessage(reason = 'cancelled') {
    const normalized = String(reason || 'cancelled').trim().toLowerCase();
    if (!normalized || normalized === 'cancelled') {
        return 'Interrupted by user';
    }
    if (normalized === 'esc' || normalized === 'escape' || normalized === 'external-signal' || normalized === 'user') {
        return 'Interrupted by user';
    }
    return `Interrupted: ${reason}`;
}

function getPendingAwaitingInputTool(history = []) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i];
        if (entry?.type === 'awaiting_input' && typeof entry.tool === 'string' && entry.tool.trim()) {
            return entry.tool.trim();
        }
        if (entry?.type === 'final_answer' || entry?.type === 'cannot_complete') {
            break;
        }
    }
    return null;
}

function buildPendingInputDecision(toolName, userPrompt) {
    return {
        tool: toolName,
        prompt: userPrompt,
        routeReason: 'pending_awaiting_input',
    };
}

function isLikelyFreshInstruction(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) return false;
    return /^(list|show|display|view|get|find|search|add|create|new|update|edit|change|delete|remove|import|wipe|help|exit|quit|start|stop)\b/i.test(text);
}

async function runWithRetry(fn, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            lastError = error;
        }
    }
    throw lastError;
}

export {
    estimateTokens,
    injectContextIntoPrompt,
    getTimestamp,
    coerceResultToText,
    formatLogValue,
    cloneSerializable,
    coerceStructuredToolResult,
    formatInterruptionMessage,
    getPendingAwaitingInputTool,
    buildPendingInputDecision,
    isLikelyFreshInstruction,
    runWithRetry,
};
