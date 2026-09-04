import {
    FINAL_ANSWER_TOOL,
    CANNOT_COMPLETE_TOOL,
    SESSION_STATUS_RUNNING,
    SESSION_STATUS_AWAITING_INPUT,
    SESSION_STATUS_ACTIVE,
    SESSION_STATUS_DONE,
    SESSION_STATUS_FAILED,
    SESSION_STATUS_INTERRUPTED,
} from '../constants.mjs';
import {
    buildAgenticSessionPlannerSystemPrompt,
    buildAgenticSessionPlannerHistory,
} from './prompts.mjs';
import { parsePlannerDecisionMarkdown } from './plannerMarkdown.mjs';
import { preparePrompt } from './preparation.mjs';
import {
    coerceStructuredToolResult,
    getPendingAwaitingInputTool,
    buildPendingInputDecision,
    isLikelyFreshInstruction,
    getTimestamp,
} from './utils.mjs';

function debugLog(session, ...args) {
    if (session && session.debugLogger) {
        session.debugLogger.log(...args);
    }
}

async function requestDecision(session, userPrompt, turn, stepIndex) {
    session._ensureNotCancelled();
    const pendingTool = getPendingAwaitingInputTool(session.history);
    if (pendingTool) {
        const explicitDifferentToolMention = Object.keys(session.tools || {}).some((toolName) =>
            toolName !== pendingTool
            && typeof userPrompt === 'string'
            && userPrompt.toLowerCase().includes(toolName.toLowerCase())
        );

        if (!explicitDifferentToolMention) {
            const interpretation = session.agent && typeof session.agent.interpretMessage === 'function'
                ? await session.agent.interpretMessage(userPrompt, {
                    intents: ['accept', 'cancel', 'update'],
                    model: session.options.model || null,
                    tags: session.options.tags || null,
                    signal: session._currentAbortSignal,
                    reasoningEffort: session.options.reasoningEffort || null,
                })
                : { intent: 'unknown', confidence: 0 };
            session._ensureNotCancelled();
            const shouldContinuePending = interpretation?.intent === 'accept'
                || interpretation?.intent === 'cancel'
                || interpretation?.intent === 'update'
                || !isLikelyFreshInstruction(userPrompt);

            if (shouldContinuePending) {
                const decision = buildPendingInputDecision(pendingTool, userPrompt);
                session._debug('[LoopSession]', 'Pending tool decision', {
                    stepIndex,
                    pendingTool,
                    interpretation,
                    decision,
                });
                return decision;
            }
        }
    }

    const plannerSystemPrompt = buildAgenticSessionPlannerSystemPrompt({
        tools: session.tools,
        history: session.history,
        toolCalls: session.toolCalls,
        userPrompt,
        systemPrompt: session.systemPrompt,
        toolVars: session.toolVars,
    });
    const plannerHistory = [
        { role: 'system', message: plannerSystemPrompt },
        ...buildAgenticSessionPlannerHistory({
            history: session.history,
            currentUserEntry: turn.userHistoryEntry,
        }),
    ];

    session._debug('[LoopSession]', 'Planner prompt built', {
        stepIndex,
        promptLength: plannerSystemPrompt.length,
        historyMessages: plannerHistory.length,
    });

    const raw = await session.agent.complete({
        prompt: userPrompt,
        history: plannerHistory,
        model: session.options.model,
        tags: session.options.tags,
        reasoningEffort: session.options.reasoningEffort,
        signal: session._currentAbortSignal,
        context: {
            intent: 'agentic-session-planner',
            stepIndex,
            userPrompt,
        },
    });

    session._debug('[LoopSession]', 'Planner raw response', {
        stepIndex,
        raw: typeof raw === 'string' ? raw.slice(0, 2000) : raw,
    });

    let parsed = null;
    try {
        parsed = parsePlannerDecisionMarkdown(raw);
    } catch (error) {
        parsed = null;
        session._debug('[LoopSession]', 'Planner markdown parse error', {
            stepIndex,
            error: error.message,
        });
    }

    if (!parsed || typeof parsed !== 'object') {
        session._debug('[LoopSession]', 'Planner returned invalid response', {
            stepIndex,
            parsed,
        });
        const responseText = typeof raw === 'string' ? raw.trim() : '';
        let responseShape = 'text';
        if (!responseText) {
            responseShape = 'an empty response';
        } else {
            try {
                JSON.parse(responseText);
                responseShape = 'JSON';
            } catch {
                if (/^\s*(`{3,}|~{3,})json\b/i.test(responseText)) {
                    responseShape = 'JSON';
                } else if (/^\s{0,3}#{1,6}\s+/m.test(responseText)) {
                    responseShape = 'invalid Markdown';
                }
            }
        }
        throw new Error(`The LLM planner returned ${responseShape} instead of a valid planner decision.`);
    }

    session._debug('[LoopSession]', 'Planner parsed response', { stepIndex, parsed });

    return parsed;
}

async function runLoopForPrompt(session, userPrompt, turn) {
    const { maxStepsPerTurn, maxErrors } = session.options;
    session._debug('[LoopSession]', 'Run loop start', {
        prompt: userPrompt,
        maxStepsPerTurn,
        maxErrors,
        model: session.options.model,
    });

    for (let stepIndex = 0; stepIndex < maxStepsPerTurn; stepIndex += 1) {
        session._ensureNotCancelled();
        const decision = await session._requestDecision(userPrompt, turn, stepIndex);
        session._ensureNotCancelled();
        turn.steps.push({ type: 'planner_decision', decision });
        session._debug('[LoopSession]', 'Planner decision', { stepIndex, decision });

        if (decision && typeof decision.tool === 'string') {
            const toolName = decision.tool;
            await session._emitToolReason(decision, stepIndex);
            const rawPrompt = Object.prototype.hasOwnProperty.call(decision, 'prompt')
                ? decision.prompt
                : userPrompt;
            const prompt = typeof rawPrompt === 'string'
                ? rawPrompt
                : (rawPrompt != null ? JSON.stringify(rawPrompt) : userPrompt);

            session.history.push({
                type: 'tool_call',
                tool: toolName,
                prompt,
            });

            try {
                const toolResult = await session._executeTool(toolName, prompt, turn);
                session._ensureNotCancelled();
                const structuredToolResult = coerceStructuredToolResult(toolResult);
                debugLog(session, `[${getTimestamp()}] [LoopSession] Tool "${toolName}" returned: type=${typeof toolResult}, structuredType=${typeof structuredToolResult}, requiresConfirmation=${structuredToolResult?.requiresConfirmation}, requiresInput=${structuredToolResult?.requiresInput}`);
                session._debug('[LoopSession]', 'Tool result', {
                    tool: toolName,
                    prompt,
                    type: typeof toolResult,
                    structuredType: typeof structuredToolResult,
                    requiresConfirmation: structuredToolResult?.requiresConfirmation,
                    requiresInput: structuredToolResult?.requiresInput,
                });
                const displayResult = toolResult && (toolResult.__finalAnswer || toolResult.__cannotComplete)
                    ? toolResult.text
                    : structuredToolResult;
                turn.usedTools = true;
                turn.steps.push({
                    type: 'tool_result',
                    tool: toolName,
                    prompt,
                    result: displayResult,
                });

                if (structuredToolResult && typeof structuredToolResult === 'object'
                    && (structuredToolResult.requiresConfirmation || structuredToolResult.requiresInput)) {
                    let message = structuredToolResult.message;
                    if (!message) {
                        try {
                            message = JSON.stringify(structuredToolResult, null, 2);
                        } catch {
                            message = `Tool returned an object that cannot be displayed. Keys: ${Object.keys(structuredToolResult).join(', ')}`;
                        }
                    }
                    debugLog(session, `[${getTimestamp()}] [LoopSession] Detected requiresConfirmation/Input, returning message (first 100 chars): "${String(message).substring(0, 100)}..."`);
                    session._debug('[LoopSession]', 'Tool requires input/confirmation', { tool: toolName, message });
                    turn.finalAnswer = message;
                    turn.status = SESSION_STATUS_AWAITING_INPUT;
                    session.status = SESSION_STATUS_AWAITING_INPUT;
                    session.lastAnswer = message;
                    session.history.push({
                        type: SESSION_STATUS_AWAITING_INPUT,
                        answer: message,
                        tool: toolName,
                        step: structuredToolResult.step || null,
                    });
                    return message;
                }

                if (structuredToolResult && typeof structuredToolResult === 'object'
                    && structuredToolResult.success === true
                    && (structuredToolResult.records || structuredToolResult.message || structuredToolResult.operation)) {
                    let resultStr;
                    try {
                        resultStr = JSON.stringify(structuredToolResult, null, 2);
                    } catch {
                        resultStr = `Tool returned a successful result that cannot be displayed. Keys: ${Object.keys(structuredToolResult).join(', ')}`;
                    }
                    debugLog(session, `[${getTimestamp()}] [LoopSession] Detected successful skill result, returning as final answer`);
                    session._debug('[LoopSession]', 'Tool success result returned as final answer', { tool: toolName });
                    turn.finalAnswer = resultStr;
                    turn.status = SESSION_STATUS_DONE;
                    session.status = SESSION_STATUS_ACTIVE;
                    session.lastAnswer = resultStr;
                    session.history.push({ type: 'final_answer', answer: resultStr });
                    return resultStr;
                }

                if (structuredToolResult && typeof structuredToolResult === 'object'
                    && structuredToolResult.success === false
                    && (structuredToolResult.message || structuredToolResult.error || structuredToolResult.operation)) {
                    let resultStr;
                    if (structuredToolResult.supervisorDecision) {
                        resultStr = String(
                            structuredToolResult.message
                            || structuredToolResult.error
                            || 'Tool execution was denied by the supervisor.'
                        );
                    } else {
                        try {
                            resultStr = JSON.stringify(structuredToolResult, null, 2);
                        } catch {
                            resultStr = `Tool returned a failed result that cannot be displayed. Keys: ${Object.keys(structuredToolResult).join(', ')}`;
                        }
                    }
                    debugLog(session, `[${getTimestamp()}] [LoopSession] Detected failed skill result, returning as final answer`);
                    session._debug('[LoopSession]', 'Tool failed result returned as final answer', { tool: toolName });
                    turn.finalAnswer = resultStr;
                    turn.status = SESSION_STATUS_FAILED;
                    session.status = SESSION_STATUS_ACTIVE;
                    session.lastAnswer = resultStr;
                    session.history.push({ type: 'final_answer', answer: resultStr, success: false });
                    return resultStr;
                }

                if (turn._lastToolName === toolName
                    && turn._lastPrompt === prompt
                    && String(turn._lastToolResult) === String(displayResult)) {
                    turn._sameToolRepeatCount = (turn._sameToolRepeatCount || 1) + 1;
                } else {
                    turn._lastToolName = toolName;
                    turn._lastPrompt = prompt;
                    turn._lastToolResult = displayResult;
                    turn._sameToolRepeatCount = 1;
                }

                if (toolResult && (toolResult.__finalAnswer || toolResult.__cannotComplete)) {
                    const final = toolResult.text;
                    const expected = turn.expected;
                    const normalize = (v) => String(v ?? '').trim().toLowerCase();
                    const matchesExpected = expected === null
                        ? true
                        : normalize(final) === normalize(expected);

                    if (toolResult.__cannotComplete) {
                        session._debug('[LoopSession]', 'Tool cannot complete', { tool: toolName, final });
                        turn.finalAnswer = final;
                        turn.status = SESSION_STATUS_FAILED;
                        session.status = SESSION_STATUS_FAILED;
                        session.lastAnswer = final;
                        session.failedTurns.push(turn);
                        session.history.push({ type: 'cannot_complete', answer: final });
                        return final;
                    }

                    if (matchesExpected) {
                        session._debug('[LoopSession]', 'Tool final answer accepted', { tool: toolName, final });
                        turn.finalAnswer = final;
                        turn.status = SESSION_STATUS_DONE;
                        session.status = SESSION_STATUS_ACTIVE;
                        session.lastAnswer = final;
                        session.history.push({ type: 'final_answer', answer: final });
                        return final;
                    }

                    session._debug('[LoopSession]', 'Validation failed', {
                        tool: toolName,
                        expected,
                        actual: final,
                        retryCount: turn.retryCount + 1,
                    });
                    turn.retryCount += 1;
                    session.history.push({
                        type: 'validation_failed',
                        expected,
                        actual: final,
                        retryCount: turn.retryCount,
                    });
                    if (turn.retryCount >= turn.maxRetries) {
                        turn.finalAnswer = final;
                        turn.status = SESSION_STATUS_FAILED;
                        session.status = SESSION_STATUS_ACTIVE;
                        session.lastAnswer = final;
                        session.failedTurns.push(turn);
                        session.history.push({ type: 'final_answer', answer: final, validationFailed: true });
                        return final;
                    }
                    continue;
                }

                if (turn._sameToolRepeatCount >= 3) {
                    let final;
                    if (typeof displayResult === 'string') {
                        final = displayResult;
                    } else {
                        try {
                            final = JSON.stringify(displayResult, null, 2);
                        } catch {
                            final = String(displayResult);
                        }
                    }
                    session._debug('[LoopSession]', 'Repeat tool result threshold reached', {
                        tool: toolName,
                        prompt,
                    });
                    turn.finalAnswer = final;
                    turn.status = SESSION_STATUS_DONE;
                    session.status = SESSION_STATUS_ACTIVE;
                    session.history.push({ type: 'final_answer', answer: final });
                    return final;
                }
            } catch (error) {
                if (session._isAbortError(error) || session.status === SESSION_STATUS_INTERRUPTED) {
                    throw error;
                }
                session.errorCount += 1;
                turn.steps.push({
                    type: 'tool_error',
                    tool: toolName,
                    prompt,
                    error: error.message,
                });
                session._debug('[LoopSession]', 'Tool error', {
                    tool: toolName,
                    prompt,
                    error: error.message,
                    errorCount: session.errorCount,
                    maxErrors,
                });

                if (session.errorCount >= maxErrors) {
                    const message = 'The session stopped after reaching the maximum number of tool errors.';
                    session._debug('[LoopSession]', 'Aborting due to tool errors', { message });
                    turn.finalAnswer = message;
                    turn.status = SESSION_STATUS_FAILED;
                    session.status = SESSION_STATUS_FAILED;
                    return message;
                }
            }
            continue;
        }

        session.errorCount += 1;
        turn.steps.push({
            type: 'planner_error',
            error: 'Invalid or missing tool in planner response.',
        });
        session._debug('[LoopSession]', 'Planner error: invalid or missing tool', {
            errorCount: session.errorCount,
        });
        if (session.errorCount >= maxErrors) {
            const message = 'The session stopped after reaching the maximum number of invalid planner decisions.';
            session._debug('[LoopSession]', 'Aborting due to planner errors', { message });
            turn.finalAnswer = message;
            turn.status = SESSION_STATUS_FAILED;
            session.status = SESSION_STATUS_FAILED;
            return message;
        }
    }

    const fallback = 'The session stopped after reaching the maximum number of planning steps.';
    session._debug('[LoopSession]', 'Step limit reached', { message: fallback });
    turn.finalAnswer = fallback;
    turn.status = SESSION_STATUS_FAILED;
    session.status = SESSION_STATUS_FAILED;
    session.history.push({ type: 'timeout', message: fallback });
    session.failedTurns.push(turn);
    return fallback;
}

async function newPrompt(session, SessionClass, userPrompt, options = {}) {
    if (!userPrompt || typeof userPrompt !== 'string') {
        throw new Error('newPrompt requires a prompt string.');
    }

    if (Object.prototype.hasOwnProperty.call(options, 'model')) {
        session.options.model = options.model || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'tags')) {
        session.options.tags = options.tags || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'reasoningEffort')) {
        session.options.reasoningEffort = options.reasoningEffort || null;
    }

    const expected = typeof options.expected === 'string' || typeof options.expected === 'number'
        ? String(options.expected)
        : null;
    const maxRetries = Number.isFinite(options.maxRetries)
        ? options.maxRetries
        : session.options.maxRetriesPerTurn;

    const turn = {
        prompt: userPrompt,
        steps: [],
        finalAnswer: null,
        status: SESSION_STATUS_RUNNING,
        usedTools: false,
        _lastToolName: null,
        _lastPrompt: null,
        _lastToolResult: null,
        _sameToolRepeatCount: 0,
        expected,
        retryCount: 0,
        maxRetries,
        failed: false,
    };
    session.turns.push(turn);
    session.status = SESSION_STATUS_RUNNING;
    const runSignal = options.signal || session.options.signal || null;
    const promptSignal = session._createPromptAbortController(runSignal);

    let answer = null;
    try {
        userPrompt = await preparePrompt(session, SessionClass, userPrompt, promptSignal);
        session._ensureNotCancelled();
        turn.prompt = userPrompt;
        turn.userHistoryEntry = { type: 'user', prompt: userPrompt };
        session.history.push(turn.userHistoryEntry);
        debugLog(session, `[${getTimestamp()}] [LoopSession] New prompt: "${userPrompt}"`);
        session._debug('[LoopSession]', 'New prompt', { prompt: userPrompt, expected });
        answer = await session._runLoopForPrompt(userPrompt, turn);
        session.lastAnswer = answer;
    } catch (error) {
        if (session._isAbortError(error) || session.status === SESSION_STATUS_INTERRUPTED) {
            answer = session._markInterrupted(session._cancelReason || 'cancelled', turn);
        } else {
            throw error;
        }
    } finally {
        session._clearPromptAbortController();
    }

    const invariantAnswer = session.getLastResult();
    if (invariantAnswer !== session.lastAnswer) {
        throw new Error('Internal AchillesAgentLib session error: the stored final answer does not match the session result.');
    }

    return answer;
}

export {
    newPrompt,
    runLoopForPrompt,
    requestDecision,
};
