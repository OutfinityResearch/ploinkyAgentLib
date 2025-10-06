import { callLLMWithModel } from '../LLMClient.mjs';
import {
    getProviderConfig,
    normalizeInvocationRequest,
} from '../models/modelCatalog.mjs';

function buildLegacyInvocationConfig(agent) {
    const providerKey = agent.providerKey || null;
    const apiKeyEnv = agent.apiKeyEnv || null;
    const baseURL = agent.baseURL || (providerKey ? getProviderConfig(providerKey)?.baseURL : null);
    return {
        record: {
            name: agent.model,
            providerKey,
            apiKeyEnv,
            baseURL,
            mode: agent.modelMode || 'fast',
        },
        providerKey,
        apiKeyEnv,
        baseURL,
    };
}

async function invokeAgent(agent, history, options = {}) {
    const request = normalizeInvocationRequest(options);

    const {
        record,
        providerKey,
        apiKeyEnv,
        baseURL,
    } = typeof agent.getInvocationConfig === 'function'
            ? agent.getInvocationConfig(request)
            : buildLegacyInvocationConfig(agent);

    if (!record?.name) {
        throw new Error(`Agent "${agent.name}" does not have a usable model.`);
    }

    const effectiveProviderKey = providerKey || record.providerKey;
    const effectiveBaseURL = baseURL || getProviderConfig(effectiveProviderKey)?.baseURL;
    if (!effectiveBaseURL) {
        throw new Error(`Missing base URL for agent "${agent.name}" (${effectiveProviderKey || 'unknown provider'}).`);
    }

    const apiKeyName = apiKeyEnv || record.apiKeyEnv || agent.apiKeyEnv || null;
    const apiKey = apiKeyName ? process.env[apiKeyName] : null;
    if (!apiKey && effectiveProviderKey !== 'huggingface') {
        throw new Error(`Missing API key for agent "${agent.name}" (${apiKeyName || 'unspecified env var'}).`);
    }

    return callLLMWithModel(record.name, [...history], null, {
        apiKey,
        baseURL: effectiveBaseURL,
        providerKey: effectiveProviderKey,
    });
}

export {
    buildLegacyInvocationConfig,
    invokeAgent,
};
