import { loadModelsConfiguration } from './providers/modelsConfigLoader.mjs';

const modelsConfiguration = loadModelsConfiguration();
let configurationDiagnosticsEmitted = false;

function emitConfigurationDiagnostics() {
    if (configurationDiagnosticsEmitted) {
        return;
    }
    configurationDiagnosticsEmitted = true;

    for (const error of modelsConfiguration.issues.errors) {
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.error(`LLMAgentClient: ${error}`);
        }
    }
    for (const warning of modelsConfiguration.issues.warnings) {
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.warn(`LLMAgentClient: ${warning}`);
        }
    }
}

function getModelsConfiguration() {
    return modelsConfiguration;
}

function getProviderConfig(providerKey) {
    return modelsConfiguration.providers.get(providerKey) || null;
}

function getModelDescriptor(modelName) {
    return modelsConfiguration.models.get(modelName) || null;
}

function createAgentModelRecord(providerConfig, modelDescriptor) {
    if (!providerConfig || !modelDescriptor) {
        return null;
    }

    const apiKeyEnv = modelDescriptor.apiKeyEnv || providerConfig.apiKeyEnv || null;
    const baseURL = modelDescriptor.baseURL || providerConfig.baseURL || null;
    const mode = modelDescriptor.mode || 'fast';

    return {
        name: modelDescriptor.name,
        providerKey: modelDescriptor.providerKey,
        apiKeyEnv,
        baseURL,
        mode,
    };
}

function cloneAgentModelRecord(record) {
    return {
        name: record.name,
        providerKey: record.providerKey,
        apiKeyEnv: record.apiKeyEnv,
        baseURL: record.baseURL,
        mode: record.mode || 'fast',
    };
}

function normalizeModePreference(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === 'deep' || normalized === 'fast' ? normalized : null;
}

function normalizeInvocationRequest(input) {
    if (typeof input === 'string') {
        return { mode: normalizeModePreference(input), modelName: null };
    }

    if (!input || typeof input !== 'object') {
        return { mode: null, modelName: null };
    }

    const mode = normalizeModePreference(input.mode || input.preferredMode || input.modePreference);
    const modelRaw = input.modelName || input.model || input.preferredModel;
    const modelName = typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : null;

    return { mode, modelName };
}

function getOrderedModelNames() {
    if (Array.isArray(modelsConfiguration.orderedModels) && modelsConfiguration.orderedModels.length) {
        return modelsConfiguration.orderedModels.slice();
    }
    return Array.from(modelsConfiguration.models.keys());
}

function categorizeModelsByMode(modelNames) {
    const fast = [];
    const deep = [];
    for (const name of modelNames) {
        const descriptor = getModelDescriptor(name);
        if (!descriptor) {
            continue;
        }
        if (descriptor.mode === 'deep') {
            deep.push(name);
        } else {
            fast.push(name);
        }
    }
    return { fast, deep };
}

function buildModelRecordByName(modelName) {
    const descriptor = getModelDescriptor(modelName);
    if (!descriptor) {
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.warn(`LLMAgentClient: models.json does not define model "${modelName}".`);
        }
        return null;
    }
    const providerConfig = getProviderConfig(descriptor.providerKey);
    if (!providerConfig) {
        if (process.env.LLMAgentClient_DEBUG === 'true') {
            console.warn(`LLMAgentClient: Model "${modelName}" references unknown provider "${descriptor.providerKey}".`);
        }
        return null;
    }
    return createAgentModelRecord(providerConfig, descriptor);
}

function dedupeRecordsByName(records) {
    const seen = new Set();
    const result = [];
    for (const record of records) {
        if (!record || !record.name) {
            continue;
        }
        if (seen.has(record.name)) {
            continue;
        }
        seen.add(record.name);
        result.push(record);
    }
    return result;
}

function normalizeModelNameList(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    return list
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);
}

function resetModelCatalogForTests() {
    configurationDiagnosticsEmitted = false;
}

export {
    buildModelRecordByName,
    categorizeModelsByMode,
    cloneAgentModelRecord,
    createAgentModelRecord,
    dedupeRecordsByName,
    emitConfigurationDiagnostics,
    getModelDescriptor,
    getModelsConfiguration,
    getOrderedModelNames,
    getProviderConfig,
    normalizeInvocationRequest,
    normalizeModePreference,
    normalizeModelNameList,
    resetModelCatalogForTests,
};
