import { loadModelsConfiguration } from './models/providers/modelsConfigLoader.mjs';
import { registerBuiltInProviders } from './models/providers/index.mjs';
import { registerProvidersFromConfig } from './models/providerBootstrap.mjs';
import { ensureProvider } from './models/providerRegistry.mjs';

const modelsConfiguration = loadModelsConfiguration();

registerBuiltInProviders();
await registerProvidersFromConfig(modelsConfiguration);

const llmCalls = [];

function getModelMetadata(modelName) {
    const modelDescriptor = modelsConfiguration.models.get(modelName);
    if (!modelDescriptor) {
        return null;
    }
    const providerConfig = modelsConfiguration.providers.get(modelDescriptor.providerKey) || null;
    return {
        model: modelDescriptor,
        provider: providerConfig,
    };
}

function resolveProviderKey(modelName, invocationOptions, metadata) {
    if (invocationOptions.providerKey) {
        return invocationOptions.providerKey;
    }
    if (metadata?.model?.providerKey) {
        return metadata.model.providerKey;
    }
    if (metadata?.provider?.providerKey) {
        return metadata.provider.providerKey;
    }
    throw new Error(`Model "${modelName}" is not configured with a provider.`);
}

export async function callLLM(historyArray, prompt, options = {}) {
    const modelName = options?.model;
    if (!modelName || typeof modelName !== 'string') {
        throw new Error('callLLM requires options.model to be specified.');
    }
    return callLLMWithModel(modelName, historyArray, prompt, options);
}

async function callLLMWithModelInternal(modelName, historyArray, prompt, invocationOptions = {}) {
    const controller = new AbortController();
    llmCalls.push(controller);

    const history = Array.isArray(historyArray) ? historyArray.slice() : [];
    if (prompt) {
        history.push({ role: 'human', message: prompt });
    }

    const externalSignal = invocationOptions.signal;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        const abortHandler = () => controller.abort();
        externalSignal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
        const metadata = getModelMetadata(modelName);
        const providerKey = resolveProviderKey(modelName, invocationOptions, metadata);
        const provider = ensureProvider(providerKey);

        const baseURL = invocationOptions.baseURL
            || metadata?.model?.baseURL
            || metadata?.provider?.baseURL;

        if (!baseURL) {
            throw new Error(`Missing base URL for provider "${providerKey}" and model "${modelName}".`);
        }

        const apiKey = invocationOptions.apiKey || process.env.LLM_API_KEY;
        if (!apiKey && providerKey !== 'huggingface') {
            throw new Error(`Missing API key for provider "${providerKey}".`);
        }

        return await provider.callLLM(history, {
            model: modelName,
            providerKey,
            apiKey,
            baseURL,
            signal: controller.signal,
            params: invocationOptions.params || {},
            headers: invocationOptions.headers || {},
        });
    } catch (error) {
        throw error;
    } finally {
        const index = llmCalls.indexOf(controller);
        if (index > -1) {
            llmCalls.splice(index, 1);
        }
    }
}

let callLLMWithModelImpl = callLLMWithModelInternal;

export async function callLLMWithModel(modelName, historyArray, prompt, invocationOptions = {}) {
    return callLLMWithModelImpl(modelName, historyArray, prompt, invocationOptions);
}

export function cancelRequests() {
    llmCalls.forEach(controller => controller.abort());
    llmCalls.length = 0;
}

export function __setCallLLMWithModelForTests(fn) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected function when overriding callLLMWithModel implementation.');
    }
    callLLMWithModelImpl = fn;
}

export function __resetCallLLMWithModelForTests() {
    callLLMWithModelImpl = callLLMWithModelInternal;
}
