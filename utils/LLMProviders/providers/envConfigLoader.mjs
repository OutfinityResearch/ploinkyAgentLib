/**
 * envConfigLoader.mjs
 * 
 * Parses environment variables to define LLM providers and models.
 * These are merged with LLMConfig.json, with env vars taking precedence.
 * 
 * Provider format:
 *   OPENAI_<PROVIDER>_URL=<base_url>       - OpenAI-compatible provider
 *   OPENAI_<PROVIDER>_KEY=<api_key>        - Direct API key
 *   OPENAI_<PROVIDER>_KEY_ENV=<env_var>    - Env var name containing key
 *   
 *   ANTHROPIC_<PROVIDER>_URL=<base_url>    - Anthropic-compatible provider
 *   ANTHROPIC_<PROVIDER>_KEY=<api_key>     - Direct API key
 *   ANTHROPIC_<PROVIDER>_KEY_ENV=<env_var> - Env var name containing key
 * 
 * Model format:
 *   LLM_MODEL_<NN>=<provider>/<model>|<inputPrice>|<outputPrice>|<context>|<tags>
 *   
 *   Examples:
 *   LLM_MODEL_01=myproxy/gpt-4-turbo|5|15|128k
 *   LLM_MODEL_02=bedrock/claude-3-sonnet|3|15|200k
 *   LLM_MODEL_03=myproxy/gpt-4o-mini (prices and context optional)
 * 
 * The provider/model format allows disambiguation when the same model name
 * exists across multiple providers.
 */

import {
    GENERATED_LOCAL_CHAT_PATH,
    assertVerifiedGeneratedLocalRouterDescriptor,
    buildGeneratedLocalOperationURL,
    hasGeneratedLocalDescriptorBundle,
    loadGeneratedLocalRouterDescriptor,
} from '../transport/generatedLocalRouterDescriptor.mjs';

const API_TYPE_OPENAI = 'openai';
const API_TYPE_ANTHROPIC = 'anthropic';
const API_TYPE_GOOGLE = 'google';
const API_TYPE_HUGGINGFACE = 'huggingface';
const API_TYPE_COPILOT = 'copilot';
const API_TYPE_KIRO = 'kiro';
const API_TYPE_SOUL_GATEWAY = 'soul_gateway';

const OPENAI_MODULE = './utils/LLMProviders/providers/openai.mjs';
const ANTHROPIC_MODULE = './utils/LLMProviders/providers/anthropic.mjs';
const GOOGLE_MODULE = './utils/LLMProviders/providers/google.mjs';
const HUGGINGFACE_MODULE = './utils/LLMProviders/providers/huggingFace.mjs';
const COPILOT_MODULE = './utils/LLMProviders/providers/copilot.mjs';
const KIRO_MODULE = './utils/LLMProviders/providers/kiro.mjs';

function isGeneratedLocalEndpointAlias(raw, descriptor) {
    if (typeof raw !== 'string' || !raw.trim() || !descriptor) return false;
    try {
        const candidate = new URL(raw);
        return candidate.origin === descriptor.payload.physicalOrigin
            || candidate.host === descriptor.payload.requestAuthority
            || candidate.host === descriptor.payload.publicAuthority;
    } catch {
        return false;
    }
}

function generatedLocalAliasError(description) {
    const error = new Error(`${description} cannot alias the runtime-owned generated-local provider.`);
    error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
    return error;
}

/**
 * Parse a model definition string.
 * Format: provider/model|inputPrice|outputPrice|context|tags
 * 
 * @param {string} value - The model definition string
 * @returns {object|null} Parsed model object or null if invalid
 */
function parseModelDefinition(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const parts = value.split('|').map(p => p.trim());
    if (parts.length < 1) {
        return null;
    }

    const providerModel = parts[0];
    const slashIdx = providerModel.indexOf('/');
    if (slashIdx === -1) {
        // No provider specified - invalid for env-defined models
        return null;
    }

    const provider = providerModel.substring(0, slashIdx).toLowerCase();
    const modelName = providerModel.substring(slashIdx + 1);

    if (!provider || !modelName) {
        return null;
    }

    const maybeTier = parts[1]?.toLowerCase() || '';
    const offset = (maybeTier === 'fast' || maybeTier === 'deep') ? 2 : 1;
    const inputPrice = parts[offset] ? parseFloat(parts[offset]) : 0;
    const outputPrice = parts[offset + 1] ? parseFloat(parts[offset + 1]) : 0;
    const context = parts[offset + 2] || 'N/A';
    const rawTags = parts[offset + 3] || '';
    const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : [];

    return {
        name: modelName,
        provider,
        providerKey: provider,
        tags,
        inputPrice: isNaN(inputPrice) ? 0 : inputPrice,
        outputPrice: isNaN(outputPrice) ? 0 : outputPrice,
        context,
        // Store the qualified name for lookups
        qualifiedName: `${provider}/${modelName}`,
    };
}

/**
 * Extract provider definitions from environment variables.
 * Looks for patterns like OPENAI_<NAME>_URL or ANTHROPIC_<NAME>_URL
 * 
 * @returns {Map<string, object>} Map of provider name to provider config
 */
function parseProvidersFromEnv({ generatedLocalDescriptor = null } = {}) {
    const providers = new Map();
    const providerData = new Map(); // Collect partial data before building providers

    if (generatedLocalDescriptor) {
        assertVerifiedGeneratedLocalRouterDescriptor(generatedLocalDescriptor);
        for (const name of ['SOUL_GATEWAY_API_KEY', 'SOUL_GATEWAY_BASE_URL', 'SOUL_GATEWAY_URL']) {
            if (Object.hasOwn(process.env, name)) {
                const error = new Error(`Generated-local provider cannot accept protected environment override "${name}".`);
                error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
                throw error;
            }
        }
        for (const name of Object.keys(process.env)) {
            if (/^OPENAI_SOUL_GATEWAY_(?:URL|KEY|TOKEN|KEY_ENV)$/.test(name)) {
                const error = new Error(`Generated-local provider cannot accept protected environment override "${name}".`);
                error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
                throw error;
            }
        }
    }

    // Patterns to match
    const urlPattern = /^(OPENAI|ANTHROPIC|GOOGLE|HUGGINGFACE|COPILOT|KIRO)_([A-Z][A-Z0-9_]*)_URL$/;
    const keyPattern = /^(OPENAI|ANTHROPIC|GOOGLE|HUGGINGFACE|COPILOT|KIRO)_([A-Z][A-Z0-9_]*)_(KEY|TOKEN)$/;
    const keyEnvPattern = /^(OPENAI|ANTHROPIC|GOOGLE|HUGGINGFACE|COPILOT|KIRO)_([A-Z][A-Z0-9_]*)_KEY_ENV$/;

    // Match names before reading values. In generated mode this is essential:
    // enumerating Object.entries(process.env) would read the runtime API key
    // during provider construction.
    for (const envKey of Object.keys(process.env)) {
        let match;

        // Check for URL
        match = envKey.match(urlPattern);
        if (match) {
            const envValue = process.env[envKey];
            if (!envValue) continue;
            const [, apiType, providerName] = match;
            const key = `${apiType}_${providerName}`;
            if (!providerData.has(key)) {
                providerData.set(key, { apiType, providerName });
            }
            providerData.get(key).baseURL = envValue;
            continue;
        }

        // Check for KEY_ENV (must check before KEY)
        match = envKey.match(keyEnvPattern);
        if (match) {
            const envValue = process.env[envKey];
            if (!envValue) continue;
            const [, apiType, providerName] = match;
            const key = `${apiType}_${providerName}`;
            if (!providerData.has(key)) {
                providerData.set(key, { apiType, providerName });
            }
            providerData.get(key).apiKeyEnv = envValue;
            continue;
        }

        // Check for KEY (direct key value)
        match = envKey.match(keyPattern);
        if (match) {
            const envValue = process.env[envKey];
            if (!envValue) continue;
            const [, apiType, providerName] = match;
            const key = `${apiType}_${providerName}`;
            if (!providerData.has(key)) {
                providerData.set(key, { apiType, providerName });
            }
            // Store the direct key/token - we'll create a synthetic env var for it
            providerData.get(key).directKey = envValue;
            continue;
        }
    }

    // Build provider configs from collected data
    for (const [key, data] of providerData.entries()) {
        if (!data.baseURL) {
            // Provider must have a URL
            continue;
        }

        const providerKey = data.providerName.toLowerCase();
        const apiType = data.apiType.toLowerCase();

        if (generatedLocalDescriptor && providerKey === 'soul_gateway') {
            const error = new Error('Generated-local provider cannot accept OPENAI_SOUL_GATEWAY_* environment overrides.');
            error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
            throw error;
        }
        if (generatedLocalDescriptor
            && (data.apiKeyEnv === 'PLOINKY_AGENT_API_KEY'
                || isGeneratedLocalEndpointAlias(data.baseURL, generatedLocalDescriptor))) {
            throw generatedLocalAliasError(`Environment provider "${providerKey}"`);
        }

        // Determine the module based on API type
        const module = resolveModuleForApiType(apiType);

        // Determine API key env var
        let apiKeyEnv = data.apiKeyEnv;
        if (!apiKeyEnv && data.directKey) {
            // Create a synthetic env var name and set it
            apiKeyEnv = `${data.apiType}_${data.providerName}_API_KEY`;
            process.env[apiKeyEnv] = data.directKey;
        }
        if (!apiKeyEnv) {
            // Default to <PROVIDER>_API_KEY
            apiKeyEnv = `${data.providerName}_API_KEY`;
        }

        providers.set(providerKey, {
            name: providerKey,
            providerKey,
            baseURL: data.baseURL,
            apiKeyEnv,
            module,
            apiType,
            fromEnv: true,
        });
    }

    addDirectProvider(providers, {
        providerKey: 'openai',
        apiType: API_TYPE_OPENAI,
        envNames: ['OPENAI_API_KEY'],
        baseURL: process.env.OPENAI_BASE_URL || process.env.OPENAI_URL || 'https://api.openai.com/v1',
    });

    addDirectProvider(providers, {
        providerKey: 'anthropic',
        apiType: API_TYPE_ANTHROPIC,
        envNames: ['ANTHROPIC_API_KEY'],
        baseURL: process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_URL || 'https://api.anthropic.com',
    });

    addDirectProvider(providers, {
        providerKey: 'google',
        apiType: API_TYPE_GOOGLE,
        envNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
        baseURL: process.env.GOOGLE_BASE_URL || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
    });

    addDirectProvider(providers, {
        providerKey: 'huggingface',
        apiType: API_TYPE_HUGGINGFACE,
        envNames: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
        baseURL: process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/v1/chat/completions',
    });

    addDirectProvider(providers, {
        providerKey: 'copilot',
        apiType: API_TYPE_COPILOT,
        envNames: ['COPILOT_API_KEY', 'COPILOT_TOKEN'],
        baseURL: process.env.COPILOT_BASE_URL || 'https://api.githubcopilot.com',
    });

    addDirectProvider(providers, {
        providerKey: 'kiro',
        apiType: API_TYPE_KIRO,
        envNames: ['KIRO_API_KEY', 'KIRO_ACCESS_TOKEN'],
        baseURL: process.env.KIRO_BASE_URL || 'https://api.kiro.dev',
    });

    if (generatedLocalDescriptor) {
        providers.set('soul_gateway', {
            name: 'soul_gateway',
            providerKey: 'soul_gateway',
            apiKeyEnv: 'PLOINKY_AGENT_API_KEY',
            baseURL: buildGeneratedLocalOperationURL(
                generatedLocalDescriptor,
                GENERATED_LOCAL_CHAT_PATH
            ).href,
            module: OPENAI_MODULE,
            apiType: API_TYPE_SOUL_GATEWAY,
            fromEnv: true,
            generatedLocalDescriptor,
        });
    } else {
        addDirectProvider(providers, {
            providerKey: 'soul_gateway',
            apiType: API_TYPE_SOUL_GATEWAY,
            envNames: resolveSoulGatewayEnvNames(),
            baseURL: resolveSoulGatewayBaseURL(),
        });
    }

    return providers;
}

function resolveModuleForApiType(apiType) {
    switch (apiType) {
        case API_TYPE_ANTHROPIC:
            return ANTHROPIC_MODULE;
        case API_TYPE_GOOGLE:
            return GOOGLE_MODULE;
        case API_TYPE_HUGGINGFACE:
            return HUGGINGFACE_MODULE;
        case API_TYPE_COPILOT:
            return COPILOT_MODULE;
        case API_TYPE_KIRO:
            return KIRO_MODULE;
        case API_TYPE_SOUL_GATEWAY:
        case API_TYPE_OPENAI:
        default:
            return OPENAI_MODULE;
    }
}

function addDirectProvider(providers, { providerKey, apiType, envNames, baseURL }) {
    if (providers.has(providerKey)) {
        return;
    }

    const envName = envNames.find((name) => process.env[name]);
    if (!envName) {
        return;
    }

    const providerRecord = {
        name: providerKey,
        providerKey,
        apiKeyEnv: envName,
        module: resolveModuleForApiType(apiType),
        apiType,
        fromEnv: true,
    };
    if (typeof baseURL === 'string' && baseURL.trim()) {
        providerRecord.baseURL = baseURL;
    }

    providers.set(providerKey, providerRecord);
}

function resolveSoulGatewayEnvNames() {
    return ['SOUL_GATEWAY_API_KEY'];
}

function resolveSoulGatewayBaseURL() {
    const raw = process.env.SOUL_GATEWAY_BASE_URL || process.env.SOUL_GATEWAY_URL;
    if (!raw || !String(raw).trim()) {
        return null;
    }
    const trimmed = raw.replace(/\/+$/, '');

    if (trimmed.endsWith('/chat/completions')) {
        return trimmed;
    }
    if (trimmed.endsWith('/v1')) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
}

/**
 * Extract model definitions from environment variables.
 * Looks for patterns like LLM_MODEL_<NN>=provider/model|...
 * 
 * @returns {Array<object>} Array of model definitions in order
 */
function parseModelsFromEnv() {
    const models = [];
    const modelEntries = [];

    // Pattern: LLM_MODEL_<anything> (typically numbered like LLM_MODEL_01)
    const modelPattern = /^LLM_MODEL_(.+)$/;

    for (const envKey of Object.keys(process.env)) {
        const match = envKey.match(modelPattern);
        if (match) {
            const envValue = process.env[envKey];
            if (!envValue) continue;
            const suffix = match[1];
            const parsed = parseModelDefinition(envValue);
            if (parsed) {
                parsed.envKey = envKey;
                parsed.fromEnv = true;
                modelEntries.push({ suffix, model: parsed });
            }
        }
    }

    // Sort by suffix to maintain ordering (e.g., 01, 02, 03)
    modelEntries.sort((a, b) => a.suffix.localeCompare(b.suffix, undefined, { numeric: true }));

    for (const entry of modelEntries) {
        models.push(entry.model);
    }

    return models;
}

/**
 * Parse a provider/model reference string.
 * 
 * @param {string} ref - Reference like "provider/model" or just "model"
 * @returns {object} { provider: string|null, model: string }
 */
export function parseModelReference(ref) {
    if (!ref || typeof ref !== 'string') {
        return { provider: null, model: ref || '' };
    }

    const trimmed = ref.trim();
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx === -1) {
        return { provider: null, model: trimmed };
    }

    return {
        provider: trimmed.substring(0, slashIdx).toLowerCase(),
        model: trimmed.substring(slashIdx + 1),
    };
}

/**
 * Parse a comma/semicolon-separated list of model references.
 * Supports provider/model format.
 * 
 * @param {string} value - Comma or semicolon separated list
 * @returns {Array<{provider: string|null, model: string, qualified: string}>}
 */
export function parseModelList(value) {
    if (!value || typeof value !== 'string') {
        return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }

    // Try JSON array first
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed
                .filter(item => typeof item === 'string' && item.trim())
                .map(item => {
                    const ref = parseModelReference(item);
                    return {
                        ...ref,
                        qualified: ref.provider ? `${ref.provider}/${ref.model}` : ref.model,
                    };
                });
        }
    } catch {
        // Not JSON, continue with delimiter parsing
    }

    // Split by comma or semicolon
    return trimmed.split(/[;,]/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const ref = parseModelReference(item);
            return {
                ...ref,
                qualified: ref.provider ? `${ref.provider}/${ref.model}` : ref.model,
            };
        });
}

/**
 * Load provider and model configurations from environment variables.
 * 
 * @returns {object} { providers: Map, models: Array, issues: { errors: [], warnings: [] } }
 */
export function loadEnvConfig(options = {}) {
    const issues = { errors: [], warnings: [] };

    const generatedLocalDescriptor = Object.hasOwn(options, 'generatedLocalDescriptor')
        ? options.generatedLocalDescriptor
        : hasGeneratedLocalDescriptorBundle(process.env)
            ? loadGeneratedLocalRouterDescriptor()
            : null;

    const providers = parseProvidersFromEnv({ generatedLocalDescriptor });
    const models = parseModelsFromEnv();

    // Validate that models reference known providers
    for (const model of models) {
        if (!providers.has(model.provider)) {
            issues.warnings.push(
                `Env model "${model.qualifiedName}" references provider "${model.provider}" which is not defined in env. ` +
                `It may exist in LLMConfig.json.`
            );
        }
    }

    return {
        providers,
        models,
        issues,
    };
}

// Named export for parseModelDefinition
export { parseModelDefinition };

export default {
    loadEnvConfig,
    parseModelReference,
    parseModelList,
    parseModelDefinition,
};
