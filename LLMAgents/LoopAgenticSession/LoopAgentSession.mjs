import {
    FINAL_ANSWER_TOOL,
    CANNOT_COMPLETE_TOOL,
    SESSION_STATUS_IDLE,
    CLARIFY_CONTEXT_TOOL,
} from '../constants.mjs';
import {
    cloneSerializable,
} from './utils.mjs';
import {
    getParentContext,
    buildFinalAnswerTool,
    buildCannotCompleteTool,
    buildClarifyContextTool,
    recordToolsRefreshed,
    estimateHistoryTokens,
    hasPendingAwaitingInput,
    isAbortError,
    createPromptAbortController,
    clearPromptAbortController,
    ensureNotCancelled,
    markInterrupted,
    cancel,
    emitToolReason,
    executeTool,
} from './runtime.mjs';
import {
    DEFAULT_HISTORY_COMPRESSION_THRESHOLD_TOKENS,
    DEFAULT_HISTORY_COMPRESSION_KEEP_RECENT,
    DEFAULT_HISTORY_COMPRESSION_MAX_SUMMARY_TOKENS,
    compressHistoryIfNeeded,
} from './historyCompression.mjs';
import {
    newPrompt,
    runLoopForPrompt,
    requestDecision,
} from './execution.mjs';
import {
    runPreparation,
} from './preparation.mjs';

class LoopAgentSession {
    constructor({ agent, tools, options = {} }) {
        if (!agent) {
            throw new Error('LoopAgentSession requires an LLMAgent instance.');
        }
        if (!tools || typeof tools !== 'object') {
            throw new Error('LoopAgentSession requires a tools object.');
        }
        [FINAL_ANSWER_TOOL, CANNOT_COMPLETE_TOOL, CLARIFY_CONTEXT_TOOL].forEach((reserved) => {
            if (Object.prototype.hasOwnProperty.call(tools, reserved)) {
                throw new Error(`Tool name "${reserved}" is reserved by the agent runtime.`);
            }
        });

        if (agent) {
            if (agent.__toolState instanceof Map) {
                agent.__toolState.clear();
            } else {
                agent.__toolState = new Map();
            }
        }

        this.agent = agent;
        this._userTools = { ...tools };
        const parentContext = options.preparationSession === true && options.enableClarifyContextTool
            ? getParentContext(options.parentContext)
            : null;
        this.tools = {
            ...tools,
            [FINAL_ANSWER_TOOL]: this._buildFinalAnswerTool(),
            [CANNOT_COMPLETE_TOOL]: this._buildCannotCompleteTool(),
        };
        if (parentContext) {
            this.tools[CLARIFY_CONTEXT_TOOL] = this._buildClarifyContextTool(parentContext);
        }
        this.options = {
            maxStepsPerTurn: Number.isFinite(options.maxStepsPerTurn)
                ? options.maxStepsPerTurn
                : 8,
            maxErrors: Number.isFinite(options.maxErrors) ? options.maxErrors : 5,
            model: options.model || null,
            tags: options.tags || null,
            reasoningEffort: options.reasoningEffort || null,
            maxRetriesPerTurn: Number.isFinite(options.maxRetriesPerTurn)
                ? options.maxRetriesPerTurn
                : 3,
            historyCompressionEnabled: options.historyCompressionEnabled !== false,
            historyCompressionThresholdTokens: Number.isFinite(options.historyCompressionThresholdTokens)
                ? Math.max(1, Math.floor(options.historyCompressionThresholdTokens))
                : DEFAULT_HISTORY_COMPRESSION_THRESHOLD_TOKENS,
            historyCompressionKeepRecentEntries: Number.isFinite(options.historyCompressionKeepRecentEntries)
                ? Math.max(0, Math.floor(options.historyCompressionKeepRecentEntries))
                : DEFAULT_HISTORY_COMPRESSION_KEEP_RECENT,
            historyCompressionMaxSummaryTokens: Number.isFinite(options.historyCompressionMaxSummaryTokens)
                ? Math.max(200, Math.floor(options.historyCompressionMaxSummaryTokens))
                : DEFAULT_HISTORY_COMPRESSION_MAX_SUMMARY_TOKENS,
            historyCompressionModel: options.historyCompressionModel || null,
        };

        this.supervisor = options.supervisor || null;
        this._alwaysApproveCache = new Map();
        this.turns = [];
        this.history = normalizeInitialHistory(options.initialHistory);
        this.toolCalls = [];
        this.errorCount = 0;
        this.status = SESSION_STATUS_IDLE;
        this.lastAnswer = null;
        const projectRoot = process.cwd();
        const basePrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
        this.systemPrompt = `${basePrompt}\n\nYou are working in the current project: ${projectRoot}`.trim();
        this.baseSystemPrompt = this.systemPrompt;
        this.preparation = options.preparation || null;
        this.failedTurns = [];
        this.toolVars = new Map();
        this.toolVarCounter = 0;
        this.debugLogger = options.logger || null;
        this._currentAbortController = null;
        this._currentAbortSignal = null;
        this._removePromptAbortListener = null;
        this._cancelReason = null;
    }

    replaceTools(tools, metadata = {}) {
        if (!tools || typeof tools !== 'object') {
            throw new Error('replaceTools requires a tools object.');
        }
        [FINAL_ANSWER_TOOL, CANNOT_COMPLETE_TOOL, CLARIFY_CONTEXT_TOOL].forEach((reserved) => {
            if (Object.prototype.hasOwnProperty.call(tools, reserved)) {
                throw new Error(`Tool name "${reserved}" is reserved by the agent runtime.`);
            }
        });

        this._userTools = { ...tools };
        this.tools = {
            ...tools,
            [FINAL_ANSWER_TOOL]: this._buildFinalAnswerTool(),
            [CANNOT_COMPLETE_TOOL]: this._buildCannotCompleteTool(),
        };
        this._recordToolsRefreshed(metadata);
        return this.tools;
    }

    async newPrompt(userPrompt, options = {}) {
        return newPrompt(this, LoopAgentSession, userPrompt, options);
    }

    getLastResult() {
        return this.lastAnswer;
    }

    getConversationSnapshot() {
        return {
            type: 'loop',
            status: this.status,
            lastAnswer: this.lastAnswer,
            history: cloneSerializable(this.history),
        };
    }

    async getVariables() {
        return {
            lastAnswer: this.getLastResult(),
            status: this.status,
            failedTurns: this.failedTurns.length,
        };
    }

    hasFailedTurns() {
        return this.failedTurns.length > 0;
    }

    async finalizeFailures() {
        if (!this.hasFailedTurns()) {
            return null;
        }
        try {
            return await this._executeTool(CANNOT_COMPLETE_TOOL, 'One or more steps failed validation.');
        } catch {
            return null;
        }
    }

    static async runPreparation(args) {
        return runPreparation({ ...args, SessionClass: LoopAgentSession });
    }

    _recordToolsRefreshed(metadata = {}) {
        return recordToolsRefreshed(this, metadata);
    }

    _debug(...args) {
        if (this.debugLogger) {
            this.debugLogger.log(...args);
        }
    }

    _estimateHistoryTokens(entries = this.history) {
        return estimateHistoryTokens(this, entries);
    }

    _hasPendingAwaitingInput() {
        return hasPendingAwaitingInput(this);
    }

    _isAbortError(error) {
        return isAbortError(error);
    }

    _createPromptAbortController(externalSignal = null) {
        return createPromptAbortController(this, externalSignal);
    }

    _clearPromptAbortController() {
        return clearPromptAbortController(this);
    }

    _ensureNotCancelled() {
        return ensureNotCancelled(this);
    }

    _markInterrupted(reason = 'cancelled', turn = null) {
        return markInterrupted(this, reason, turn);
    }

    cancel(reason = 'cancelled') {
        return cancel(this, reason);
    }

    _compressHistoryIfNeeded(userPrompt) {
        return compressHistoryIfNeeded(this, userPrompt);
    }

    _runLoopForPrompt(userPrompt, turn) {
        return runLoopForPrompt(this, userPrompt, turn);
    }

    _emitToolReason(decision, stepIndex) {
        return emitToolReason(this, decision, stepIndex);
    }

    _requestDecision(userPrompt, turn, stepIndex) {
        return requestDecision(this, userPrompt, turn, stepIndex);
    }

    _executeTool(toolName, prompt) {
        return executeTool(this, toolName, prompt);
    }

    _buildFinalAnswerTool() {
        return buildFinalAnswerTool(this);
    }

    _buildCannotCompleteTool() {
        return buildCannotCompleteTool(this);
    }

    _buildClarifyContextTool(parentContext) {
        return buildClarifyContextTool(this, parentContext);
    }
}

function normalizeInitialHistory(initialHistory) {
    if (initialHistory === null || initialHistory === undefined) return [];
    if (!Array.isArray(initialHistory)) {
        throw new TypeError('initialHistory must be an array of { role, message } records.');
    }
    return initialHistory.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new TypeError(`initialHistory[${index}] must be an object.`);
        }
        if (typeof entry.message !== 'string' || !entry.message.trim()) {
            throw new TypeError(`initialHistory[${index}].message must be a non-empty string.`);
        }
        if (entry.role === 'user') {
            return { type: 'user', prompt: entry.message };
        }
        if (entry.role === 'assistant') {
            return { type: 'final_answer', answer: entry.message };
        }
        throw new TypeError(`initialHistory[${index}].role must be "user" or "assistant".`);
    });
}

export {
    LoopAgentSession,
};
