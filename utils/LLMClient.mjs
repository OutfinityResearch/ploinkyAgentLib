import { loadModelsConfiguration, resolveModelName, parseModelReference } from './LLMProviders/providers/modelsConfigLoader.mjs';
export { loadModelsConfiguration, resolveModelName, parseModelReference, modelsConfiguration };
import { registerProvidersFromConfig } from './LLMProviders/providerBootstrap.mjs';
import { ensureProvider } from './LLMProviders/providers/providerRegistry.mjs';
import {
    assertNoGeneratedLocalProtectedOverrides,
    isVerifiedGeneratedLocalRouterDescriptor,
} from './LLMProviders/transport/generatedLocalRouterDescriptor.mjs';
const debugFlag = (process.env.ACHILLES_DEBUG ?? '').toLowerCase();
const DEBUG_ENABLED = debugFlag === '1' || debugFlag === 'true';

const modelsConfiguration = await loadModelsConfiguration();

await registerProvidersFromConfig(modelsConfiguration);

const llmCalls = [];

// ── Model Registry ──────────────────────────────────────────────────

function createAgentModelRecord(modelDescriptor, providerConfig) {
    if (!modelDescriptor || !providerConfig) {
        return null;
    }
    return {
        name: modelDescriptor.name,
        providerKey: modelDescriptor.providerKey,
        apiKeyEnv: modelDescriptor.apiKeyEnv || providerConfig.apiKeyEnv || null,
        baseURL: modelDescriptor.baseURL || providerConfig.baseURL || null,
        tags: modelDescriptor.tags || [],
        sortOrder: modelDescriptor.sortOrder ?? 100,
        isFree: modelDescriptor.isFree || false,
        billingType: modelDescriptor.billingType || 'api_key',
        generatedLocalDescriptor: providerConfig.generatedLocalDescriptor || null,
    };
}

function buildModelRegistry() {
    const recordMap = new Map();
    const ordered = [];

    const orderedNames = Array.isArray(modelsConfiguration.orderedModels) && modelsConfiguration.orderedModels.length
        ? modelsConfiguration.orderedModels
        : Array.from(modelsConfiguration.models.keys());

    for (const name of orderedNames) {
        if (recordMap.has(name)) continue;
        const descriptor = modelsConfiguration.models.get(name);
        if (!descriptor) continue;
        const providerConfig = modelsConfiguration.providers.get(descriptor.providerKey);
        if (!providerConfig) continue;
        const record = createAgentModelRecord(descriptor, providerConfig);
        if (!record) continue;

        record.qualifiedName = `${record.providerKey}/${record.name}`;
        recordMap.set(name, record);
        ordered.push(name);
    }

    return { recordMap, ordered };
}

let modelRecordMap;
let orderedModelNames;

function ensureRegistryFresh() {
    if (!modelRecordMap) {
        const reg = buildModelRegistry();
        modelRecordMap = reg.recordMap;
        orderedModelNames = reg.ordered;
    }
}

// ── Model Resolution (no cascade) ──────────────────────────────────

/**
 * Select the best model matching the requested tags.
 * Scores each known model by tag overlap count, preferring lower sortOrder on ties.
 * Only considers models whose provider API key is available.
 */
export function selectModelByTags(requestedTags) {
    if (!requestedTags || !requestedTags.length) return null;
    ensureRegistryFresh();

    let bestModel = null;
    let bestScore = -1;
    let bestSortOrder = Infinity;

    for (const [name, record] of modelRecordMap) {
        const modelTags = record.tags || [];
        if (!modelTags.length) continue;

        // Check provider has API key available
        const keyEnv = record.apiKeyEnv;
        if (!isVerifiedGeneratedLocalRouterDescriptor(record.generatedLocalDescriptor)
            && keyEnv
            && !process.env[keyEnv]) continue;

        let score = 0;
        for (const tag of requestedTags) {
            if (modelTags.includes(tag)) score++;
        }
        if (score === 0) continue;

        if (score > bestScore || (score === bestScore && (record.sortOrder ?? 100) < bestSortOrder)) {
            bestScore = score;
            bestModel = name;
            bestSortOrder = record.sortOrder ?? 100;
        }
    }

    return bestModel;
}

function normalizeRequestedTags(tags) {
    if (!Array.isArray(tags)) {
        return [];
    }
    return tags
        .map((tag) => String(tag || '').trim())
        .filter(Boolean);
}

function collectMatchedTags(requestedTags, modelRecord, resolvedModelName) {
    if (!requestedTags.length) {
        return [];
    }

    const modelTags = Array.isArray(modelRecord?.tags)
        ? modelRecord.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
        : [];
    if (modelTags.length) {
        const matched = [];
        for (const tag of requestedTags) {
            if (modelTags.includes(tag) && !matched.includes(tag)) {
                matched.push(tag);
            }
        }
        return matched;
    }

    if (requestedTags.includes(resolvedModelName)) {
        return [resolvedModelName];
    }
    return [];
}

function inferProviderKeyFromModelName(modelName) {
    if (!modelName || typeof modelName !== 'string' || !modelName.includes('/')) {
        return null;
    }
    const { provider } = parseModelReference(modelName);
    if (provider && modelsConfiguration.providers.has(provider)) {
        return provider;
    }
    return null;
}

function resolveModelString(candidate) {
    if (!candidate || typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;

    const defaultsKey = trimmed.toLowerCase();
    const defaultMapped = modelsConfiguration.defaults?.get(defaultsKey);
    if (typeof defaultMapped === 'string' && defaultMapped.trim()) {
        return defaultMapped.trim();
    }

    const resolved = resolveModelName(trimmed, modelsConfiguration.models, modelsConfiguration.qualifiedModels);
    return resolved || trimmed;
}

/**
 * Resolve invocation parameters to a single model string.
 * Model input can be a concrete model name or a gateway tag.
 *
 * Resolution order:
 * 1. Explicit model string (resolved via config mapping)
 * 2. modelConfig[tag] for the first requested tag
 * 3. Tag-based registry scoring (selectModelByTags)
 * 4. Config defaults (plan)
 * 5. Last-resort fallback ('plan')
 */
export function resolveModelForInvocation({ model, tags, modelConfig } = {}) {
    // 1. Explicit model input (model or tag)
    const explicitModel = resolveModelString(model);
    if (explicitModel) {
        return explicitModel;
    }

    // 2. modelConfig[tag] direct lookup for first requested tag
    if (tags && Array.isArray(tags) && tags.length > 0) {
        const firstTag = String(tags[0] || '').trim().toLowerCase();
        if (firstTag && modelConfig && typeof modelConfig === 'object') {
            const mapped = modelConfig[firstTag];
            if (typeof mapped === 'string' && mapped.trim()) {
                return mapped.trim();
            }
        }
    }

    // 3. Tags array: choose best known model via registry scoring, otherwise pass-through first tag
    if (tags && Array.isArray(tags) && tags.length > 0) {
        const selected = selectModelByTags(tags);
        if (selected) return selected;
        const firstTag = String(tags[0] || '').trim();
        if (firstTag) return firstTag;
    }

    // 4. Config defaults
    const defaultModel = modelsConfiguration.defaults?.get('plan');
    if (defaultModel) {
        const resolved = resolveModelName(defaultModel, modelsConfiguration.models, modelsConfiguration.qualifiedModels);
        return resolved || defaultModel;
    }

    // 5. Last-resort model input
    return 'plan';
}

// ── Convenience exports ─────────────────────────────────────────

export function getPrioritizedModels(requestedModel = null) {
    ensureRegistryFresh();
    const candidate = typeof requestedModel === 'string' ? requestedModel : null;
    const model = resolveModelForInvocation({ model: candidate || null });
    return model ? [model] : [];
}

export function listModelsFromCache() {
    ensureRegistryFresh();
    const clone = (names) => names.map((name) => {
        const record = modelRecordMap.get(name);
        return record ? { ...record } : null;
    }).filter(Boolean);

    return {
        models: clone(orderedModelNames),
    };
}


// ── Core LLM Call Infrastructure ────────────────────────────────────

function getModelMetadata(modelName) {
    let resolvedName = modelName;
    if (modelName) {
        const resolved = resolveModelName(
            modelName,
            modelsConfiguration.models,
            modelsConfiguration.qualifiedModels
        );
        if (resolved) {
            resolvedName = resolved;
        }
    }

    const modelDescriptor = modelsConfiguration.models.get(resolvedName);
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

function resolveApiKey(invocationOptions, metadata) {
    if (invocationOptions.apiKey) {
        return invocationOptions.apiKey;
    }

    const configuredEnv = invocationOptions.apiKeyEnv
        || metadata?.model?.apiKeyEnv
        || metadata?.provider?.apiKeyEnv;

    if (configuredEnv && process.env[configuredEnv]) {
        return process.env[configuredEnv];
    }

    return process.env.LLM_API_KEY || null;
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
        history.push({ role: 'user', message: prompt });
    }

    const externalSignal = invocationOptions.signal;
    let externalAbortHandler = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        externalAbortHandler = () => controller.abort();
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
    }

    try {
        let metadata = getModelMetadata(modelName);

        // For unregistered qualified names, extract provider prefix and continue.
        let inferredProviderKey = null;
        let inferredModelName = modelName;
        if (!metadata && modelName.includes('/')) {
            const { provider: prefix, model: suffix } = parseModelReference(modelName);
            if (prefix && modelsConfiguration.providers.has(prefix)) {
                inferredProviderKey = prefix;
                inferredModelName = suffix;
                const providerConfig = modelsConfiguration.providers.get(prefix);
                metadata = { model: null, provider: providerConfig };
            }
        }

        const configuredLocalProvider = isVerifiedGeneratedLocalRouterDescriptor(
            metadata?.provider?.generatedLocalDescriptor
        );
        const requestedProvider = Object.hasOwn(invocationOptions, 'providerKey')
            ? modelsConfiguration.providers.get(invocationOptions.providerKey)
            : null;
        if (configuredLocalProvider
            || isVerifiedGeneratedLocalRouterDescriptor(requestedProvider?.generatedLocalDescriptor)) {
            assertNoGeneratedLocalProtectedOverrides(
                invocationOptions,
                'Generated-local invocation arguments'
            );
        }

        const providerKey = resolveProviderKey(modelName, invocationOptions, metadata)
            || inferredProviderKey;
        const provider = ensureProvider(providerKey);
        const providerConfig = metadata?.provider || modelsConfiguration.providers.get(providerKey) || null;

        if (isVerifiedGeneratedLocalRouterDescriptor(providerConfig?.generatedLocalDescriptor)) {
            const actualModelName = metadata?.model?.name || inferredModelName;
            return await provider.callLLM(history, {
                model: actualModelName,
                signal: controller.signal,
                params: invocationOptions.params || {},
                generatedLocalDescriptor: providerConfig.generatedLocalDescriptor,
            });
        }

        const baseURL = invocationOptions.baseURL
            || metadata?.model?.baseURL
            || providerConfig?.baseURL;

        if (!baseURL) {
            throw new Error(`Missing base URL for provider "${providerKey}" and model "${modelName}".`);
        }

        const apiKey = resolveApiKey(invocationOptions, metadata || { provider: providerConfig });
        if (!apiKey && providerKey !== 'huggingface') {
            throw new Error(`Missing API key for provider "${providerKey}".`);
        }

        const actualModelName = metadata?.model?.name || inferredModelName;

        const agentHeaders = invocationOptions.headers || {};

        return await provider.callLLM(history, {
            model: actualModelName,
            providerKey,
            apiKey,
            baseURL,
            signal: controller.signal,
            params: invocationOptions.params || {},
            headers: agentHeaders,
        });
    } catch (error) {
        throw error;
    } finally {
        if (externalAbortHandler) {
            externalSignal.removeEventListener?.('abort', externalAbortHandler);
        }
        const index = llmCalls.indexOf(controller);
        if (index > -1) {
            llmCalls.splice(index, 1);
        }
    }
}

let callLLMWithModelImpl = callLLMWithModelInternal;

export async function callLLMWithModel(modelName, historyArray, prompt, invocationOptions = {}) {
    const resolvedModel = resolveModelForInvocation({ model: modelName });
    return callLLMWithModelImpl(resolvedModel, historyArray, prompt, invocationOptions);
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

// ── Invoker Strategy (single-call, no cascade) ─────────────────────

export function createDefaultLLMInvokerStrategy() {
    ensureRegistryFresh();
    const cachedModels = listModelsFromCache();
    let lastInvocationDetails = { model: null, requestedTags: [], matchedTags: [] };

    const invokerStrategy = async function defaultLLMInvokerStrategy(invocation = {}) {
        const {
            prompt,
            history = [],
            model = null,
            tags = null,
            params = {},
            headers = {},
            signal = null,
            invocationOptions = {},
            responseValidator = null,
            reasoningEffort = null,
        } = invocation;

        if (!prompt || typeof prompt !== 'string') {
            throw new Error('defaultLLMInvokerStrategy requires a prompt string.');
        }

        const hasConfiguredModels = Boolean(modelsConfiguration.models && modelsConfiguration.models.size > 0);
        const hasDefaults = Boolean(modelsConfiguration.defaults && modelsConfiguration.defaults.size > 0);
        const hasProviders = Boolean(modelsConfiguration.providers && modelsConfiguration.providers.size > 0);
        if (!hasConfiguredModels && !hasDefaults && !hasProviders) {
            throw new Error(`No LLM models are configured in ${modelsConfiguration.path || 'the LLM configuration file'}.`);
        }

        // Resolve to a single model name — no cascade
        const modelName = resolveModelForInvocation({ model, tags, modelConfig: invocation.modelConfig });

        const record = modelRecordMap?.get(modelName) || null;
        const requestedTags = normalizeRequestedTags(tags);
        const matchedTags = collectMatchedTags(requestedTags, record, modelName);
        lastInvocationDetails = { model: null, requestedTags, matchedTags };

        const qualifiedProvider = inferProviderKeyFromModelName(modelName);
        const localRecord = isVerifiedGeneratedLocalRouterDescriptor(
            record?.generatedLocalDescriptor
        ) || isVerifiedGeneratedLocalRouterDescriptor(
            modelsConfiguration.providers.get(qualifiedProvider)?.generatedLocalDescriptor
        );

        if (localRecord) {
            assertNoGeneratedLocalProtectedOverrides(
                invocationOptions,
                'Generated-local invocationOptions'
            );
            const explicitOverrides = {};
            for (const name of ['providerKey', 'apiKey', 'apiKeyEnv', 'baseURL', 'headers', 'transport']) {
                if (Object.hasOwn(invocation, name)) explicitOverrides[name] = invocation[name];
            }
            assertNoGeneratedLocalProtectedOverrides(
                explicitOverrides,
                'Generated-local invocation'
            );
        }

        const mergedHeaders = { ...(invocationOptions.headers || {}), ...headers };

        // Merge reasoningEffort into params if specified
        const mergedParams = { ...(invocationOptions.params || {}), ...params };
        if (reasoningEffort && typeof reasoningEffort === 'string') {
            mergedParams.reasoning_effort = reasoningEffort.toLowerCase();
        }

        const invocationConfig = {
            ...invocationOptions,
            params: mergedParams,
            ...(!localRecord ? { headers: mergedHeaders } : {}),
        };

        if (!localRecord && invocation.providerKey) invocationConfig.providerKey = invocation.providerKey;
        if (!localRecord && invocation.apiKey) invocationConfig.apiKey = invocation.apiKey;
        if (!localRecord && invocation.apiKeyEnv) invocationConfig.apiKeyEnv = invocation.apiKeyEnv;
        if (!localRecord && invocation.baseURL) invocationConfig.baseURL = invocation.baseURL;
        if (signal) invocationConfig.signal = signal;

        // Fill from record if not already set
        if (!localRecord && !invocationConfig.providerKey && record?.providerKey) {
            invocationConfig.providerKey = record.providerKey;
        }
        if (!localRecord && !invocationConfig.baseURL && record?.baseURL) {
            invocationConfig.baseURL = record.baseURL;
        }
        if (!localRecord && !invocationConfig.apiKeyEnv && record?.apiKeyEnv) {
            invocationConfig.apiKeyEnv = record.apiKeyEnv;
        }

        const inferredProviderKey = inferProviderKeyFromModelName(modelName);
        const resolvedProviderKey = invocationConfig.providerKey
            || record?.providerKey
            || inferredProviderKey
            || null;
        if (!localRecord && !invocationConfig.providerKey && resolvedProviderKey) {
            invocationConfig.providerKey = resolvedProviderKey;
        }

        if (DEBUG_ENABLED) {
            console.info(`[AchillesAgentsLib] LLM call -> provider: ${resolvedProviderKey || 'unknown'}, model: ${modelName}, requestedTags: ${JSON.stringify(requestedTags)}, matchedTags: ${JSON.stringify(matchedTags)}`);
        }

        const attemptHistory = Array.isArray(history) ? history.slice() : [];
        const output = await callLLMWithModel(modelName, attemptHistory, prompt, invocationConfig);

        if (typeof responseValidator === 'function') {
            responseValidator(output);
        }

        lastInvocationDetails = { model: modelName, requestedTags, matchedTags };
        return {
            output,
            model: modelName,
            requestedTags,
            matchedTags,
        };
    };

    // Helper methods
    const defaultsList = modelsConfiguration.defaults ? [...modelsConfiguration.defaults.keys()] : [];
    invokerStrategy.getSupportedModels = () => defaultsList.slice();
    invokerStrategy.listAvailableModels = () => ({
        models: cachedModels.models.map(record => ({ ...record })),
    });
    invokerStrategy.getLastInvocationDetails = () => ({ ...lastInvocationDetails });
    invokerStrategy.describe = () => ({
        configPath: modelsConfiguration.path || null,
        defaults: defaultsList,
        models: cachedModels.models.map((record) => ({
            name: record.name,
            apiKeyEnv: record.apiKeyEnv || null,
        })),
    });

    return invokerStrategy;
}

export const defaultLLMInvokerStrategy = createDefaultLLMInvokerStrategy();
