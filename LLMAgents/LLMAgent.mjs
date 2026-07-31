import {
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
} from './markdown.mjs';
import { defaultLLMInvokerStrategy, cancelRequests, modelsConfiguration } from '../utils/LLMClient.mjs';
import {
    buildInterpretMessagePrompt,
    buildDetectIntentsPrompt,
    buildResolveConfirmationPrompt,
    extractJson,
} from './prompts.mjs';
import { LoopAgentSession } from './LoopAgenticSession/LoopAgentSession.mjs';
import { SOPAgenticSession } from './SOPAgenticSession/SOPAgenticSession.mjs';
import { stripCodeFence } from './LLMAgentHelpers.mjs';
import {
    parseConfirmationMarkdown,
    parseDetectIntentsMarkdown,
} from './structuredMarkdown.mjs';
import {
    extraComplete,
    extraDoTask,
} from './LLMAgentExtra.mjs';

const DEFAULT_AGENT_NAME = 'DefaultLLMAgent';

/**
 * LLMAgent — the mediation layer between high-level agents and LLM providers.
 *
 * All LLM calls converge through `complete()`, which delegates to `extraComplete()`.
 * Interpretation methods (`interpretMessage`, `resolveConfirmation`, `detectIntents`)
 * and execution methods (`executePrompt`) all route through this hub.
 *
 * Model resolution is delegated low-level to the invoker strategy.
 * Callers pass `model` (concrete name or tag string) and/or `tags` (array).
 * The `modelConfig` maps semantic tags to model names and is passed to the invoker.
 *
 * Traffic counters (_inputCounter, _outputCounter) are updated automatically
 * inside extraComplete() for performance metrics used by the evals suite.
 */
class LLMAgent {
    /**
     * Create a new LLMAgent.
     *
     * @param {Object} options
     * @param {string} [options.name='DefaultLLMAgent'] - Agent identifier
     * @param {Function} [options.invokerStrategy] - Function that makes the actual LLM call.
     *   Defaults to `defaultLLMInvokerStrategy` from LLMClient.
     * @param {Object} [options.modelConfig] - Maps semantic tags to model names.
     *   Defaults are loaded from LLMConfig.json `defaults` key.
     */
    constructor(options = {}) {
        const {
            name = DEFAULT_AGENT_NAME,
            invokerStrategy = null,
            modelConfig = null,
            reasoningEffort = null,
            logger = null,
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
        this.modelConfig = modelConfig || this._buildDefaultModelConfig();
        this.reasoningEffort = reasoningEffort || null;
        this.logger = logger;
        this._inputCounter = 0;
        this._outputCounter = 0;
        this._callLog = [];
    }

    /**
     * Build default modelConfig from LLMConfig.json `defaults`.
     * Returns an empty object if no defaults are configured.
     */
    _buildDefaultModelConfig() {
        const config = {};
        if (modelsConfiguration?.defaults) {
            for (const [tag, modelRef] of modelsConfiguration.defaults) {
                config[tag] = modelRef;
            }
        }
        return config;
    }

    /**
     * Replace the current modelConfig entirely.
     * Pass null to reset to defaults from LLMConfig.json.
     *
     * @param {Object|null} modelConfig - New tag-to-model mapping
     */
    setModelConfig(modelConfig) {
        this.modelConfig = modelConfig || this._buildDefaultModelConfig();
    }

    /**
     * Classify a short user message into a bounded operational signal.
     *
     * Determines whether the user wants to accept, cancel, update, or
     * something else. Uses heuristic matching first (fast), falls back
     * to LLM classification for ambiguous input.
     *
     * Used by AgenticSession and SOPAgenticSession when a tool is awaiting
     * user input — decides whether to continue the pending tool or start
     * a fresh instruction.
     *
     * @param {string} message - The user's reply
     * @param {Object} options
     * @param {string[]} [options.intents=['accept','cancel','update']] - Allowed intents
     * @param {string|null} [options.instructions] - Extra guidance for LLM fallback
     * @param {string|null} [options.model] - Override model for LLM fallback
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @returns {Object} { intent, confidence, updates?, ideas?, raw }
     */
    async interpretMessage(message, { intents = ['accept', 'cancel', 'update'], instructions = null, model = null, tags = null, signal = null } = {}) {
        // Stage 1: fast heuristic matching
        const heuristic = classifyIntent(message, { intents });
        if (heuristic.intent !== 'unknown' && (!intents.length || intents.includes(heuristic.intent))) {
            const hasMeaningfulUpdates = heuristic.updates && Object.keys(heuristic.updates).length;
            if (heuristic.intent !== 'update' || hasMeaningfulUpdates) {
                return heuristic;
            }
        }

        // Stage 2: LLM fallback for ambiguous input
        const prompt = buildInterpretMessagePrompt(intents, instructions);

        const raw = await this.complete({
            prompt,
            history: [{ role: 'user', message }],
            model,
            tags,
            signal,
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

    /**
     * Determine if user input means yes, no, or is unclear.
     *
     * Uses pattern matching for common responses (yes/y/ok/sure, no/n/cancel),
     * falls back to LLM for ambiguous cases (maybe/I think so).
     *
     * Used by ConfirmationUtils, which is called by DBTableSkills flow handlers
     * when confirming create/update/delete operations with the user.
     *
     * @param {string} userInput - The user's reply
     * @param {Object} options
     * @param {string|null} [options.actionContext] - Context for LLM fallback prompt
     * @param {string|null} [options.model] - Override model for LLM fallback
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @returns {Object} { decision: 'yes'|'no'|'unclear', confidence: number }
     */
    async resolveConfirmation(userInput, { actionContext = null, model = null, tags = null, signal = null } = {}) {
        if (!userInput || typeof userInput !== 'string') {
            return { decision: 'unclear', confidence: 0 };
        }

        const trimmed = userInput.trim().toLowerCase();
        if (!trimmed) {
            return { decision: 'unclear', confidence: 0 };
        }

        // Fast path: pattern matching for common explicit responses
        const yesPatterns = ['yes', 'y', 'ok', 'sure', 'confirm', 'accept', 'proceed'];
        const noPatterns = ['no', 'n', 'cancel', 'stop', 'abort', 'reject'];

        if (yesPatterns.includes(trimmed)) {
            return { decision: 'yes', confidence: 1.0 };
        }
        if (noPatterns.includes(trimmed)) {
            return { decision: 'no', confidence: 1.0 };
        }

        // LLM fallback for ambiguous input
        const prompt = buildResolveConfirmationPrompt(userInput, actionContext);

        try {
            const response = await this.complete({
                prompt,
                model,
                tags,
                signal,
                context: { intent: 'resolve-confirmation' },
            });

            const parsed = parseConfirmationMarkdown(response);
            if (parsed) {
                return parsed;
            }
        } catch (error) {
            // Fall through to unclear on error
        }

        return { decision: 'unclear', confidence: 0 };
    }

    /**
     * Get total input characters sent across all LLM calls.
     * Used by evals suite for performance metrics.
     */
    getInputCounter() {
        return this._inputCounter;
    }

    /**
     * Get total output characters received across all LLM calls.
     * Used by evals suite for performance metrics.
     */
    getOutputCounter() {
        return this._outputCounter;
    }

    /**
     * Accumulate input character count. Called automatically by extraComplete().
     * @private
     */
    _recordInputChars(count = 0) {
        const safe = Number.isFinite(count) ? count : 0;
        this._inputCounter += Math.max(0, safe);
    }

    /**
     * Accumulate output character count. Called automatically by extraComplete().
     * @private
     */
    _recordOutputChars(count = 0) {
        const safe = Number.isFinite(count) ? count : 0;
        this._outputCounter += Math.max(0, safe);
    }

    /**
     * Central hub for all LLM calls.
     *
     * Delegates to `extraComplete()` which:
     * 1. Records input character count
     * 2. Calls the invoker strategy with the resolved model
     * 3. Records output character count
     * 4. Logs the interaction (model, tags, duration)
     * 5. Pushes entry to the per-call log
     *
     * Called by: interpretMessage, resolveConfirmation, detectIntents,
     * and extraDoTask (which backs executePrompt).
     *
     * @param {Object} options
     * @param {string} options.prompt - The prompt text
     * @param {Array} [options.history=[]] - Conversation history
     * @param {string|null} [options.model] - Model name or tag
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @param {Object} [options.context={}] - Context metadata for logging
     * @returns {string} Raw LLM response text
     */
    async complete(options = {}) {
        return await extraComplete(this, options);
    }

    _resolveReasoningEffort(options) {
        const perCall = options && typeof options === 'object' ? options.reasoningEffort : null;
        if (perCall) return perCall;
        return this.reasoningEffort;
    }

    /**
     * Abort all in-flight LLM requests.
     *
     * Safety mechanism for timeouts or shutdown scenarios.
     * Catches errors silently so callers don't need to handle them.
     */
    cancel() {
        try {
            cancelRequests();
        } catch {
            // ignore cancellation failures
        }
    }

    /**
     * Execute a prompt with memory context injection.
     *
     * Prepends memory segments (global, user, session, skill) to the prompt,
     * then routes through `extraDoTask()` → `complete()`.
     *
     * Supports response shape coercion via `responseShape`:
     * - `'json'` — extracts and parses JSON, throws on failure
     * - `'code'` — strips markdown code fences
     * - `'json-code'` — extracts JSON object requiring a `code` field
     *
     * Used by: All subsystems (CodeSkills, DCG, PloinkyAgent, DBTable, Orchestrator),
     * evals suite, and any code that needs to send a prompt with context.
     *
     * @param {string} promptText - The user prompt
     * @param {Object} options
     * @param {string|null} [options.model] - Model name or tag
     * @param {Array|null} [options.tags] - Semantic tags
     * @param {string|null} [options.responseShape] - 'json', 'code', or 'json-code'
     * @param {string|null} [options.globalMemory] - Global memory context
     * @param {string|null} [options.userMemory] - User-scoped memory
     * @param {string|null} [options.sessionMemory] - Session-scoped memory
     * @param {string|null} [options.skillShortMemory] - Skill-scoped memory
     * @returns {string|Object} Raw text or coerced response
     */
    async executePrompt(promptText, options = {}) {
        if (!promptText || typeof promptText !== 'string') {
            throw new Error('executePrompt requires a promptText string.');
        }

        const {
            model = null,
            tags = null,
            responseShape = null,
            globalMemory = null,
            userMemory = null,
            sessionMemory = null,
            skillShortMemory = null,
            ...rest
        } = options || {};

        // Build context string from memory segments
        const segments = [];
        const pushSegment = (label, value) => {
            if (value === null || value === undefined) {
                return;
            }
            try {
                const rendered = typeof value === 'string' ? value : value.toString();
                if (rendered && rendered.trim()) {
                    segments.push(`${label}:
${rendered.trim()}`);
                }
            } catch (error) {
                // ignore serialization issues
            }
        };

        pushSegment('Global Memory', globalMemory);
        pushSegment('User Memory', userMemory);
        pushSegment('Session Memory', sessionMemory);
        pushSegment('Skill Memory', skillShortMemory);

        const agentContext = segments.length
            ? `${segments.join('\n\n')}

Prompt:
${promptText}`
            : '';

        const result = await extraDoTask(this, agentContext, promptText, {
            model,
            tags,
            ...rest,
        });

        // Coerce response to requested shape
        if (!responseShape) {
            return result;
        }

        if (responseShape === 'json') {
            const parsed = extractJson(result);
            if (parsed === null) {
                throw new Error('The LLM response could not be parsed as the required JSON value.');
            }
            return parsed;
        }

        if (responseShape === 'code') {
            return stripCodeFence(result);
        }

        if (responseShape === 'json-code') {
            const payload = extractJson(result);
            if (!payload || typeof payload !== 'object') {
                throw new Error('The LLM response could not be parsed as the required JSON object containing a code field.');
            }
            if (typeof payload.code !== 'string') {
                throw new Error('The LLM response JSON is missing the required string "code" field.');
            }
            payload.code = payload.code.trim();
            return payload;
        }

        return result;
    }

    /**
     * Analyze a user prompt against a described skill space.
     *
     * Determines which skills are relevant and what intents are present.
     * Returns an object parsed from markdown sections in the LLM response.
     *
     * Used by: evalsSuite/evalDetectIntents.mjs — evaluates intent detection accuracy.
     *
     * @param {Object|string} skillsDescription - Description of available skills
     * @param {string} userPrompt - The user's request
     * @param {Object} options
     * @param {string|null} [options.model] - Model name or tag
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @returns {Object} Parsed JSON with skill/intent analysis
     */
    async detectIntents(skillsDescription, userPrompt, options = {}) {
        const {
            model = null,
            tags = null,
            signal = null,
            ...rest
        } = options;

        const prompt = buildDetectIntentsPrompt(skillsDescription, userPrompt);

        const result = await this.complete({
            prompt,
            model,
            tags,
            signal,
            context: { intent: 'detect-intents' },
            ...rest,
        });

        const parsed = parseDetectIntentsMarkdown(result);
        if (parsed === null) {
            throw new Error('The LLM response does not contain the required Markdown intent sections.');
        }
        return parsed;
    }

    /**
     * Create a LoopAgentSession — a bounded multi-step execution where the
     * LLM planner decides which tool to call at each step.
     *
     * The session runs until a final answer is reached, the user provides
     * input, or execution limits (max steps, max errors) are hit.
     *
     * Used by: MainAgent.executePrompt().
     *
     * @param {Object} tools - Map of tool name → { handler, description }
     * @param {string} initialPrompt - Starting user request
     * @param {Object} options
     * @param {string|null} [options.initialExpected] - Expected initial response
     * @param {number} [options.maxStepsPerTurn] - Max tool calls per turn (default 8)
     * @param {number} [options.maxErrors] - Max errors before abort (default 5)
     * @param {string} [options.model] - Model for planner decisions
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @param {boolean} [options.historyCompressionEnabled=true] - Compress old history before planning turns
     * @param {number} [options.historyCompressionThresholdTokens=6000] - Estimated-token threshold for compression
     * @param {number} [options.historyCompressionKeepRecentEntries=8] - Number of most recent history entries to retain
     * @param {number} [options.historyCompressionMaxSummaryTokens=1200] - Target summary budget for compression prompt
     * @param {string|null} [options.historyCompressionModel] - Model override for compression (defaults to planner model)
     * @param {Object} [options.supervisor] - Tool approval controller
     * @param {Array} [options.initialHistory] - Ordered prior user/assistant messages used to hydrate a new session
     * @returns {LoopAgentSession} Started session
     */
    async startLoopAgentSession(tools, initialPrompt, options = {}) {
        if (!tools || typeof tools !== 'object') {
            throw new Error('startLoopAgentSession requires a tools object.');
        }
        if (!initialPrompt || typeof initialPrompt !== 'string') {
            throw new Error('startLoopAgentSession requires an initial prompt string.');
        }

        const { initialExpected = null, signal = null, reasoningEffort = null, ...sessionOptions } = options || {};

        const session = new LoopAgentSession({
            agent: this,
            tools,
            options: { ...sessionOptions, logger: this.logger },
        });
        session.options.reasoningEffort = reasoningEffort || null;
        await session.newPrompt(initialPrompt, { expected: initialExpected, signal });
        return session;
    }

    /**
     * Create a SOPAgenticSession — a structured plan-then-execute workflow
     * using LightSOPLang.
     *
     * The LLM generates a plan of tool invocations with dependencies,
     * then executes them (potentially in parallel based on the dependency graph).
     *
     * Used by: OrchestratorSkillsSubsystem.
     *
     * @param {Object} skillsDescription - Description of available skills
     * @param {string} initialPrompt - Starting user request
     * @param {Object} options
     * @param {boolean} [options.generatePlanOnly=false] - Only generate plan, don't execute
     * @param {boolean} [options.planOnly=false] - Alias for generatePlanOnly
     * @param {Array|null} [options.tags] - Semantic tags for model selection
     * @returns {SOPAgenticSession} Started session
     */
    async startSOPLangAgentSession(skillsDescription, initialPrompt, options = {}) {
        if (!skillsDescription || typeof skillsDescription !== 'object') {
            throw new Error('startSOPLangAgentSession requires a skillsDescription object.');
        }
        if (!initialPrompt || typeof initialPrompt !== 'string') {
            throw new Error('startSOPLangAgentSession requires an initial prompt string.');
        }

        const {
            generatePlanOnly = false,
            planOnly = false,
            signal = null,
            reasoningEffort = null,
            ...rest
        } = options || {};

        const sessionOptions = {
            ...rest,
            planOnly: planOnly || generatePlanOnly,
            reasoningEffort: reasoningEffort || null,
        };

        const session = new SOPAgenticSession({
            agent: this,
            skillsDescription,
            options: { ...sessionOptions, logger: this.logger },
        });
        await session.newPrompt(initialPrompt, { signal });
        return session;
    }

}

export {
    LLMAgent,
    DEFAULT_AGENT_NAME,
};
