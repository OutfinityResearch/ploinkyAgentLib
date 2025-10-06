import {
    buildSuggestionBlock,
    buildSystemHistory,
    limitPreview,
    normalizeTaskContext,
} from '../context/contextBuilder.mjs';
import { invokeAgent } from '../invocation/modelInvoker.mjs';
import { ensureAgentRegistry, getAgent } from '../agents/agentRegistry.mjs';
import { safeJsonParse } from '../utils/json.mjs';

function normalizeTaskMode(mode, outputSchema, agent, fallback = 'fast') {
    const normalized = (mode || '').toLowerCase();
    const agentModes = Array.isArray(agent?.supportedModes) ? agent.supportedModes.slice() : [];
    if (!agentModes.length && agent?.modelMode) {
        agentModes.push(agent.modelMode);
    }

    const supportsMode = (candidate) => {
        if (!candidate) {
            return false;
        }
        if (typeof agent?.supportsMode === 'function') {
            return agent.supportsMode(candidate);
        }
        return agentModes.includes(candidate);
    };

    if (normalized === 'deep' || normalized === 'fast') {
        return supportsMode(normalized) ? normalized : (supportsMode(fallback) ? fallback : (agentModes[0] || fallback));
    }

    if (normalized === 'any' || normalized === '') {
        if (outputSchema && supportsMode('deep')) {
            return 'deep';
        }
        if (supportsMode('fast')) {
            return 'fast';
        }
        if (supportsMode('deep')) {
            return 'deep';
        }
    }

    if (supportsMode(fallback)) {
        return fallback;
    }

    return agentModes[0] || fallback;
}

async function executeFastTask(agent, context, description, outputSchema) {
    const contextInfo = normalizeTaskContext(agent, context);
    const history = buildSystemHistory(agent, {
        instruction: 'Complete the task in a single response.',
        context: contextInfo,
        description,
        outputSchema,
        mode: 'fast',
    });
    const raw = await invokeAgent(agent, history, { mode: 'fast' });
    return buildTaskResult(raw, outputSchema);
}

async function generatePlan(agent, context, description, options = {}) {
    const contextInfo = normalizeTaskContext(agent, context);
    const hints = Array.isArray(options.hints) ? options.hints : [];
    const extraParts = [];
    if (hints.length) {
        const lines = hints.slice(0, 3).map((hint, index) => {
            const steps = Array.isArray(hint?.steps) ? hint.steps.slice(0, 3).map((step, stepIndex) => `${stepIndex + 1}. ${typeof step === 'string' ? step : JSON.stringify(step)}`).join(' | ') : limitPreview(hint, 200);
            return `Plan #${index + 1}: ${steps}`;
        });
        const block = buildSuggestionBlock('Candidate plans for reuse', lines);
        if (block) {
            extraParts.push(block);
        }
    }

    const history = buildSystemHistory(agent, {
        instruction: 'Create a concise step-by-step plan for the task before solving it.',
        context: contextInfo,
        description,
        outputSchema: { type: 'object', properties: { steps: { type: 'array' } }, required: ['steps'] },
        mode: 'deep',
        extraContextParts: extraParts,
    });

    const raw = await invokeAgent(agent, history, { mode: 'deep' });
    const parsed = safeJsonParse(raw);

    if (parsed?.steps && Array.isArray(parsed.steps)) {
        return parsed;
    }

    return { steps: Array.from(String(raw).split('\n').filter(Boolean)).map((line, index) => ({ id: index + 1, action: line.trim() })) };
}

async function executeDeepTask(agent, context, description, outputSchema) {
    const contextInfo = normalizeTaskContext(agent, context);
    const plan = await generatePlan(agent, context, description);

    const extraParts = [`Plan:\n${JSON.stringify(plan)}`];

    const executionHistory = buildSystemHistory(agent, {
        instruction: 'Follow the plan and produce a final answer. Iterate internally as needed.',
        context: contextInfo,
        extraContextParts: extraParts,
        description,
        outputSchema,
        mode: 'deep',
    });
    const raw = await invokeAgent(agent, executionHistory, { mode: 'deep' });
    return buildTaskResult(raw, outputSchema);
}

async function executeIteration(agent, context, description, outputSchema, iteration, feedback, plan, mode, options = {}) {
    const contextInfo = normalizeTaskContext(agent, context);
    const extraParts = [`Task:\n${description}`, `Iteration: ${iteration}`];
    if (plan) {
        extraParts.push(`Plan:\n${JSON.stringify(plan)}`);
    }
    if (feedback) {
        extraParts.push(`Prior feedback:\n${feedback}`);
    }
    const hints = Array.isArray(options.hints) ? options.hints : [];
    if (hints.length) {
        const block = buildSuggestionBlock('Retrieved guidance', hints.map((hint, index) => `${index + 1}. ${limitPreview(hint, 200)}`));
        if (block) {
            extraParts.push(block);
        }
    }

    const history = buildSystemHistory(agent, {
        instruction: 'Work step-by-step, applying the plan and feedback to improve the solution.',
        context: contextInfo,
        extraContextParts: extraParts,
        description: 'Return only the updated solution, no commentary unless necessary.',
        outputSchema,
        mode,
    });
    const raw = await invokeAgent(agent, history, { mode });
    const parsed = buildTaskResult(raw, outputSchema);
    return { raw, parsed };
}

async function reviewCandidate(agent, context, description, candidate, outputSchema, iteration, mode) {
    const contextInfo = normalizeTaskContext(agent, context || 'N/A');
    const reviewHistory = buildSystemHistory(agent, {
        instruction: 'Review the candidate solution for quality, correctness, and alignment with the task.',
        context: contextInfo,
        extraContextParts: [
            `Task:\n${description}`,
            `Iteration: ${iteration}`,
            `Candidate:\n${candidate}`,
        ],
        description: 'Return JSON:{"approved":boolean,"feedback":string}.',
        outputSchema: null,
        mode,
    });

    const reviewRaw = await invokeAgent(agent, reviewHistory, { mode });
    const review = safeJsonParse(reviewRaw);

    if (typeof review?.approved !== 'boolean') {
        return { approved: false, feedback: 'Review response invalid; improve the solution with more rigor.' };
    }

    return { approved: review.approved, feedback: review.feedback };
}

function buildTaskResult(raw, outputSchema) {
    if (!outputSchema) {
        return { result: raw };
    }

    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') {
        return { result: raw };
    }
    return parsed;
}

function buildEvaluationContext(question, generationResults, reviewCriteria) {
    return JSON.stringify({
        question,
        reviewCriteria: reviewCriteria || 'Use balanced judgement for quality and relevance.',
        alternatives: generationResults.map(entry => ({ index: entry.index, agent: entry.agent, content: entry.content })),
    }, null, 2);
}

async function brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria = null) {
    if (!question) {
        throw new Error('question is required for brainstorm.');
    }
    if (!Number.isInteger(generationCount) || generationCount < 1) {
        throw new Error('generationCount must be a positive integer.');
    }
    if (!Number.isInteger(returnCount) || returnCount < 1) {
        throw new Error('returnCount must be a positive integer.');
    }

    const registry = ensureAgentRegistry();
    const agents = Array.from(registry.values());
    if (!agents.length) {
        throw new Error('No agents available for brainstorming.');
    }

    const generationResults = [];
    let nextIndex = 1;

    let generatedCount = 0;
    while (generationResults.length < generationCount) {
        const agent = agents[generatedCount % agents.length];
        const history = buildSystemHistory(agent, {
            instruction: 'Generate one creative, self-contained answer option.',
            context: '',
            description: `Question: ${question}\nYou are variant #${nextIndex}.`,
            mode: 'fast',
        });
        const raw = await invokeAgent(agent, history, { mode: 'fast' });
        generationResults.push({ index: nextIndex, agent: agent.name, content: raw });
        nextIndex += 1;
        generatedCount += 1;
    }

    const evaluator = getAgent(agentName);
    const evaluationMode = evaluator.supportsMode && evaluator.supportsMode('deep') ? 'deep' : 'fast';
    const evaluationHistory = buildSystemHistory(evaluator, {
        instruction: 'Evaluate brainstormed alternatives and return the top choices ranked by quality.',
        context: buildEvaluationContext(question, generationResults, reviewCriteria),
        description: 'Return JSON with property "ranked" listing objects {"index": number, "score": number, "rationale": string}.',
        mode: evaluationMode,
    });
    const evaluationRaw = await invokeAgent(evaluator, evaluationHistory, { mode: evaluationMode });
    const evaluation = safeJsonParse(evaluationRaw);

    if (!evaluation?.ranked || !Array.isArray(evaluation.ranked)) {
        throw new Error('Brainstorm evaluation response did not include ranked results.');
    }

    const ranked = evaluation.ranked
        .filter(entry => typeof entry.index === 'number')
        .slice(0, returnCount);

    return ranked.map(entry => {
        const match = generationResults.find(option => option.index === entry.index);
        if (!match) {
            return null;
        }
        return {
            choice: match.content,
            metadata: {
                agent: match.agent,
                index: match.index,
                score: entry.score,
                rationale: entry.rationale,
            }
        };
    }).filter(Boolean);
}

export {
    brainstormQuestion,
    buildEvaluationContext,
    buildTaskResult,
    executeDeepTask,
    executeFastTask,
    executeIteration,
    generatePlan,
    normalizeTaskMode,
    reviewCandidate,
};
