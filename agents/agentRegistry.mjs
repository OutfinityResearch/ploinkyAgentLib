import {
    buildModelRecordByName,
    cloneAgentModelRecord,
    dedupeRecordsByName,
    emitConfigurationDiagnostics,
    getModelsConfiguration,
    getProviderConfig,
    normalizeInvocationRequest,
    normalizeModePreference,
} from '../models/modelCatalog.mjs';

const PROVIDER_PRIORITY = ['openai', 'google', 'anthropic', 'openrouter', 'mistral', 'deepseek', 'huggingface'];

let agentRegistry = null;
let agentRegistrySummary = null;
let defaultAgentName = null;

function ensureAgentSummary() {
    if (!agentRegistrySummary) {
        agentRegistrySummary = { active: [], inactive: [] };
    }
    return agentRegistrySummary;
}

function removeAgentFromSummary(name) {
    if (!agentRegistrySummary) {
        return;
    }
    const filter = (entries) => entries.filter(entry => entry.name !== name);
    agentRegistrySummary.active = filter(agentRegistrySummary.active);
    agentRegistrySummary.inactive = filter(agentRegistrySummary.inactive);
}

function createAgentRuntime(record) {
    const runtime = { ...record };

    const recordsByMode = new Map();
    for (const modelRecord of runtime.availableModelRecords) {
        const mode = normalizeModePreference(modelRecord.mode) || 'fast';
        if (!recordsByMode.has(mode)) {
            recordsByMode.set(mode, []);
        }
        recordsByMode.get(mode).push(modelRecord);
    }

    const getRecordForMode = (mode) => {
        const normalized = normalizeModePreference(mode);
        if (normalized && recordsByMode.has(normalized)) {
            return recordsByMode.get(normalized)[0];
        }
        if (normalized === 'deep' && recordsByMode.has('fast')) {
            return recordsByMode.get('fast')[0];
        }
        if (normalized === 'fast' && recordsByMode.has('deep')) {
            return recordsByMode.get('deep')[0];
        }
        if (runtime.model) {
            const configured = runtime.availableModelRecords.find(modelRecord => modelRecord.name === runtime.model);
            if (configured) {
                return configured;
            }
        }
        return runtime.availableModelRecords[0] || null;
    };

    runtime.supportedModes = Array.from(recordsByMode.keys());

    runtime.supportsMode = function supportsMode(mode) {
        const normalized = normalizeModePreference(mode);
        return normalized ? recordsByMode.has(normalized) : false;
    };

    const findRecordByName = (modelName) => {
        if (!modelName) {
            return null;
        }
        return runtime.availableModelRecords.find(modelRecord => modelRecord.name === modelName) || null;
    };

    const resolveRecord = (request) => {
        const recordByName = findRecordByName(request.modelName);
        if (recordByName) {
            return recordByName;
        }
        return getRecordForMode(request.mode);
    };

    runtime.selectModelRecord = function selectModelRecord(request) {
        const normalizedRequest = normalizeInvocationRequest(request);
        return resolveRecord(normalizedRequest);
    };

    runtime.getInvocationConfig = function getInvocationConfig(request) {
        const normalizedRequest = normalizeInvocationRequest(request);
        const record = resolveRecord(normalizedRequest);
        if (!record) {
            throw new Error(`Agent "${runtime.name}" has no available models.`);
        }

        const providerKey = record.providerKey || runtime.providerKey || null;
        const apiKeyEnv = record.apiKeyEnv || runtime.apiKeyEnv || null;
        const baseURL = record.baseURL
            || runtime.baseURL
            || (providerKey ? getProviderConfig(providerKey)?.baseURL : null);

        return {
            record,
            providerKey,
            apiKeyEnv,
            baseURL,
        };
    };

    return runtime;
}

function hasAvailableKey(record) {
    if (!record) {
        return false;
    }
    if (!record.apiKeyEnv) {
        return true;
    }
    if ((record.providerKey || '').toLowerCase() === 'huggingface') {
        return true;
    }
    return Boolean(process.env[record.apiKeyEnv]);
}

function commitAgentRecord({
    name,
    role = '',
    job = '',
    expertise = '',
    instructions = '',
    kind = 'task',
    configuredRecords = [],
    fastModelNames = [],
    deepModelNames = [],
    origin = 'config',
}) {
    if (!name || typeof name !== 'string') {
        throw new Error('commitAgentRecord requires a non-empty name.');
    }

    if (!agentRegistry) {
        agentRegistry = new Map();
    }

    const normalizedKind = kind === 'task' ? 'task' : 'chat';
    const summaryState = ensureAgentSummary();
    removeAgentFromSummary(name);

    const orderedRecords = dedupeRecordsByName(configuredRecords || []);
    const primaryProviderKey = orderedRecords[0]?.providerKey || null;

    if (!orderedRecords.length) {
        summaryState.inactive.push({
            name,
            kind: normalizedKind,
            role,
            job,
            expertise,
            instructions,
            providerKey: primaryProviderKey,
            reason: 'no models configured',
            origin,
        });
        agentRegistry.delete(name.toLowerCase());
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.warn(`LLMAgentClient: Agent "${name}" could not be registered because no models were supplied.`);
        }
        return { status: 'inactive', reason: 'no models configured' };
    }

    const availableRecords = orderedRecords.filter(hasAvailableKey);
    if (!availableRecords.length) {
        summaryState.inactive.push({
            name,
            kind: normalizedKind,
            role,
            job,
            expertise,
            instructions,
            providerKey: primaryProviderKey,
            reason: 'missing API keys',
            origin,
        });
        agentRegistry.delete(name.toLowerCase());
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.warn(`LLMAgentClient: Agent "${name}" has no models with available API keys.`);
        }
        return { status: 'inactive', reason: 'missing API keys' };
    }

    const defaultRecord = availableRecords[0];
    const fastSet = new Set((fastModelNames || []).map(value => value?.toString().trim()).filter(Boolean));
    const deepSet = new Set((deepModelNames || []).map(value => value?.toString().trim()).filter(Boolean));

    const fastRecords = availableRecords.filter(record => fastSet.has(record.name) || (fastSet.size === 0 && record.mode === 'fast'));
    const deepRecords = availableRecords.filter(record => deepSet.has(record.name) || (deepSet.size === 0 && record.mode === 'deep'));

    const agentRecord = {
        name,
        canonicalName: name,
        role,
        job,
        expertise,
        instructions,
        kind: normalizedKind,
        origin,
        model: defaultRecord.name,
        modelMode: defaultRecord.mode,
        apiKeyEnv: defaultRecord.apiKeyEnv || null,
        providerKey: defaultRecord.providerKey || null,
        baseURL: defaultRecord.baseURL || null,
        availableModels: availableRecords.map(record => record.name),
        availableModelRecords: availableRecords.map(cloneAgentModelRecord),
        configuredModels: orderedRecords.map(record => record.name),
        fastModels: fastRecords.map(record => record.name),
        deepModels: deepRecords.map(record => record.name),
        supportedModes: Array.from(new Set(availableRecords.map(record => record.mode).filter(Boolean))),
    };

    const runtimeAgent = createAgentRuntime(agentRecord);

    agentRegistry.set(name.toLowerCase(), runtimeAgent);

    summaryState.active.push({
        name,
        kind: normalizedKind,
        role,
        job,
        expertise,
        instructions,
        origin,
        providerKey: runtimeAgent.providerKey,
        defaultModel: runtimeAgent.model,
        availableModels: runtimeAgent.availableModels.slice(),
        fastModels: runtimeAgent.fastModels.slice(),
        deepModels: runtimeAgent.deepModels.slice(),
    });

    return { status: 'active', agent: runtimeAgent };
}

function autoRegisterProviders() {
    const modelsConfiguration = getModelsConfiguration();
    for (const providerConfig of modelsConfiguration.providers.values()) {
        const providerKey = providerConfig.providerKey;
        const descriptors = modelsConfiguration.providerModels.get(providerKey) || [];

        if (!descriptors.length) {
            if (process.env.LLMAgentClient_DEBUG === 'true') {
                console.warn(`LLMAgentClient: No models configured in models.json for provider "${providerKey}".`);
            }
            commitAgentRecord({
                name: providerKey,
                role: `${providerKey} agent`,
                job: `Handle requests using ${providerKey} models.`,
                expertise: 'General',
                instructions: '',
                kind: 'task',
                configuredRecords: [],
                origin: 'provider',
            });
            continue;
        }

        const orderedNames = Array.isArray(modelsConfiguration.orderedModels)
            ? modelsConfiguration.orderedModels.filter(name => descriptors.some(descriptor => descriptor.name === name))
            : descriptors.map(descriptor => descriptor.name);

        const configuredRecords = [];
        for (const modelName of orderedNames) {
            const record = buildModelRecordByName(modelName);
            if (record && record.providerKey === providerKey) {
                configuredRecords.push(record);
            }
        }

        const fastNames = descriptors.filter(descriptor => descriptor.mode === 'fast').map(descriptor => descriptor.name);
        const deepNames = descriptors.filter(descriptor => descriptor.mode === 'deep').map(descriptor => descriptor.name);

        commitAgentRecord({
            name: providerKey,
            role: providerConfig.extra?.role || `${providerKey} agent`,
            job: providerConfig.extra?.job || `Handle requests routed to ${providerKey}.`,
            expertise: providerConfig.extra?.expertise || 'Provider specialist',
            instructions: providerConfig.extra?.instructions || '',
            kind: providerConfig.extra?.kind || providerConfig.extra?.type || 'task',
            configuredRecords,
            fastModelNames: fastNames,
            deepModelNames: deepNames,
            origin: 'provider',
        });
    }
}

function determineDefaultAgent() {
    defaultAgentName = null;
    if (!agentRegistry || agentRegistry.size === 0) {
        return;
    }

    if (agentRegistry.has('default')) {
        defaultAgentName = 'default';
        return;
    }

    for (const name of PROVIDER_PRIORITY) {
        if (agentRegistry.has(name)) {
            defaultAgentName = name;
            return;
        }
    }

    const firstAgent = agentRegistry.keys().next();
    if (!firstAgent.done) {
        defaultAgentName = firstAgent.value;
    }
}

function ensureAgentRegistry() {
    if (agentRegistry) {
        return agentRegistry;
    }

    emitConfigurationDiagnostics();

    agentRegistry = new Map();
    agentRegistrySummary = { active: [], inactive: [] };

    autoRegisterProviders();
    registerDefaultLLMAgent({});

    determineDefaultAgent();
    return agentRegistry;
}

function getAgent(agentName) {
    const registry = ensureAgentRegistry();
    if (!registry || registry.size === 0) {
        throw new Error('No agents are configured. Set provider API keys in the environment.');
    }

    if (agentName) {
        const normalized = agentName.toLowerCase();
        if (registry.has(normalized)) {
            return registry.get(normalized);
        }
    }

    if (defaultAgentName && registry.has(defaultAgentName)) {
        return registry.get(defaultAgentName);
    }

    throw new Error('Default agent is not configured.');
}

function cloneAgentSummary(summary) {
    return {
        name: summary.name,
        kind: summary.kind,
        role: summary.role,
        job: summary.job,
        expertise: summary.expertise,
        instructions: summary.instructions,
        origin: summary.origin,
        providerKey: summary.providerKey || null,
        defaultModel: summary.defaultModel,
        availableModels: Array.isArray(summary.availableModels) ? summary.availableModels.slice() : [],
        fastModels: Array.isArray(summary.fastModels) ? summary.fastModels.slice() : [],
        deepModels: Array.isArray(summary.deepModels) ? summary.deepModels.slice() : [],
        reason: summary.reason,
    };
}

function listAgents() {
    ensureAgentRegistry();

    const summaries = agentRegistrySummary || { active: [], inactive: [] };

    return {
        defaultAgent: defaultAgentName,
        agents: {
            active: summaries.active.map(cloneAgentSummary),
            inactive: summaries.inactive.map(cloneAgentSummary),
        },
    };
}

function registerDefaultLLMAgent(options = {}) {
    const {
        role = 'General-purpose assistant',
        job = 'Plan and execute tasks accurately and reliably.',
        expertise = 'Generalist',
        instructions = 'Select the most capable model for each request.',
        kind = 'task',
    } = options;

    const modelsConfiguration = getModelsConfiguration();
    const orderedNames = Array.isArray(modelsConfiguration.orderedModels)
        ? modelsConfiguration.orderedModels.slice()
        : Array.from(modelsConfiguration.models.keys());

    const configuredRecords = [];
    const fastNames = [];
    const deepNames = [];

    for (const modelName of orderedNames) {
        const record = buildModelRecordByName(modelName);
        if (!record) {
            continue;
        }
        configuredRecords.push(record);
        if (record.mode === 'fast') {
            fastNames.push(record.name);
        }
        if (record.mode === 'deep') {
            deepNames.push(record.name);
        }
    }

    commitAgentRecord({
        name: 'default',
        role,
        job,
        expertise,
        instructions,
        kind,
        configuredRecords,
        fastModelNames: fastNames,
        deepModelNames: deepNames,
        origin: 'default',
    });
}

function resetAgentRegistryForTests() {
    agentRegistry = null;
    agentRegistrySummary = null;
    defaultAgentName = null;
}

export {
    commitAgentRecord,
    createAgentRuntime,
    determineDefaultAgent,
    ensureAgentRegistry,
    getAgent,
    listAgents,
    registerDefaultLLMAgent,
    resetAgentRegistryForTests,
};
