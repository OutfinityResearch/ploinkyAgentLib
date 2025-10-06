import {
    buildSystemHistory,
    normalizeTaskContext,
} from '../context/contextBuilder.mjs';
import { getAgent } from '../agents/agentRegistry.mjs';
import { invokeAgent } from '../invocation/modelInvoker.mjs';
import { normalizeTaskMode } from '../tasks/taskRunner.mjs';
import { safeJsonParse } from '../utils/json.mjs';

const operatorRegistry = new Map();

function registerOperator(operatorName, description, executionCallback) {
    if (!operatorName || typeof operatorName !== 'string') {
        throw new Error('operatorName must be a non-empty string.');
    }
    if (!/^[a-z][a-zA-Z0-9-]*$/.test(operatorName)) {
        throw new Error('operatorName must start with a lowercase letter and can only contain alphanumeric characters and dashes.');
    }
    if (!description || typeof description !== 'string') {
        throw new Error('description must be a non-empty string.');
    }
    if (typeof executionCallback !== 'function') {
        throw new Error('executionCallback must be a function.');
    }
    if (operatorRegistry.has(operatorName)) {
        throw new Error(`Operator "${operatorName}" is already registered.`);
    }

    operatorRegistry.set(operatorName, {
        name: operatorName,
        description,
        execute: executionCallback,
    });
}

async function callOperator(operatorName, params = {}) {
    if (!operatorRegistry.has(operatorName)) {
        throw new Error(`Operator "${operatorName}" is not registered.`);
    }
    const operator = operatorRegistry.get(operatorName);
    return operator.execute(params || {});
}

async function chooseOperator(agentName, currentTaskDescription, mode = 'fast', threshold = 0.5) {
    if (!operatorRegistry.size) {
        return { suitableOperators: [] };
    }

    const agent = getAgent(agentName);
    const normalizedMode = normalizeTaskMode(mode, null, agent, 'fast');

    const operatorList = Array.from(operatorRegistry.values()).map(op => ({
        operatorName: op.name,
        description: op.description,
    }));

    const contextInfo = normalizeTaskContext(agent, JSON.stringify({ operators: operatorList }, null, 2));
    const history = buildSystemHistory(agent, {
        instruction: normalizedMode === 'deep'
            ? 'Review the operator catalog and select the functions that can help with the task.'
            : 'Quickly select operators that can solve the task.',
        context: contextInfo,
        description: `Task description: ${currentTaskDescription}\nOnly return JSON: {"suitableOperators":[{"operatorName": string, "confidence": number}]}. Discard operators below confidence ${threshold}.`,
        mode: normalizedMode,
    });

    const raw = await invokeAgent(agent, history, { mode: normalizedMode });
    const parsed = safeJsonParse(raw);

    if (parsed?.suitableOperators) {
        const filtered = parsed.suitableOperators.filter(op => typeof op.confidence === 'number' && op.confidence >= threshold);
        return { suitableOperators: filtered };
    }

    if (typeof raw === 'string') {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const robustParsed = safeJsonParse(jsonMatch[0]);
            if (robustParsed?.suitableOperators) {
                const filtered = robustParsed.suitableOperators.filter(op => typeof op.confidence === 'number' && op.confidence >= threshold);
                return { suitableOperators: filtered };
            }
        }
    }

    throw new Error('Operator selection response is invalid.');
}

function hasOperators() {
    return operatorRegistry.size > 0;
}

function resetOperatorRegistry() {
    operatorRegistry.clear();
}

export {
    callOperator,
    chooseOperator,
    hasOperators,
    registerOperator,
    resetOperatorRegistry,
};
