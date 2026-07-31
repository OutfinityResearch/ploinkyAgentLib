import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvConfig, parseModelReference } from './envConfigLoader.mjs';
import { discoverModels } from './gatewayDiscovery.mjs';
import {
    assertNoGeneratedLocalProtectedOverrides,
    hasGeneratedLocalDescriptorBundle,
    isGeneratedLocalRuntimeName,
    isVerifiedGeneratedLocalRouterDescriptor,
    loadGeneratedLocalRouterDescriptor,
} from '../transport/generatedLocalRouterDescriptor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function envSourceMetadataName(name) {
    return `PLOINKY_ENV_SOURCE_${String(name || '').replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function shouldSetEnvFromDotEnv(key, env = process.env) {
    if (!key) {
        return false;
    }
    if (!env[key]) {
        return true;
    }
    return env[envSourceMetadataName(key)] === 'generated';
}

export class DotEnvProvenanceError extends Error {
    constructor(key) {
        super(`Project .env cannot define runtime-owned generated-local name "${key}".`);
        this.name = 'DotEnvProvenanceError';
        this.code = 'PLOINKY_DOTENV_RUNTIME_NAME_REJECTED';
        this.key = key;
    }
}

export function parseDotEnvEntries(content) {
    const entries = [];
    for (const rawLine of String(content).split('\n')) {
        let trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        entries.push([key, value]);
    }
    return entries;
}

export function applyDotEnvEntries(entries, env = process.env) {
    for (const [key] of entries) {
        if (isGeneratedLocalRuntimeName(key)) throw new DotEnvProvenanceError(key);
    }
    for (const [key, value] of entries) {
        if (shouldSetEnvFromDotEnv(key, env)) {
            env[key] = value;
            markDotEnvSource(key, env);
        }
    }
}

function markDotEnvSource(key, env = process.env) {
    if (!key || key.startsWith('PLOINKY_')) {
        return;
    }
    const sourceName = envSourceMetadataName(key);
    if (!env[sourceName] || env[sourceName] === 'generated') {
        env[sourceName] = 'explicit';
    }
}

function resolveArgValue(argv, names) {
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--') {
            continue;
        }
        for (const name of names) {
            if (arg === name && index + 1 < argv.length) {
                return argv[index + 1];
            }
            const prefix = `${name}=`;
            if (arg.startsWith(prefix)) {
                return arg.slice(prefix.length);
            }
        }
    }
    return null;
}

function resolveDotEnvStartDir() {
    const raw = process.env.ACHILLES_ENV_START_DIR
        || resolveArgValue(process.argv, ['--dir', '-d'])
        || process.env.PLOINKY_CWD
        || process.cwd();
    return path.resolve(raw);
}

/**
 * Walk up from startDir to filesystem root looking for a .env file.
 * When found, parse KEY=VALUE lines and populate process.env. Existing
 * operator values are preserved. Runtime-owned generated-local names reject
 * the whole file before any entry is applied.
 */
function loadDotEnvWalkUp(startDir) {
    let dir = path.resolve(startDir);
    const { root } = path.parse(dir);

    while (true) {
        const candidate = path.join(dir, '.env');
        if (fs.existsSync(candidate)) {
            try {
                const content = fs.readFileSync(candidate, 'utf8');
                const entries = parseDotEnvEntries(content);
                applyDotEnvEntries(entries);
            } catch (error) {
                if (error instanceof DotEnvProvenanceError) throw error;
                // silently ignore read errors
            }
            return;
        }
        if (dir === root) return;
        dir = path.dirname(dir);
    }
}

// Auto-load .env on module initialization so API keys are available
// before any configuration loading happens.
loadDotEnvWalkUp(resolveDotEnvStartDir());

const DEFAULT_CONFIG_FILENAME = 'LLMConfig.json';
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../../', DEFAULT_CONFIG_FILENAME);
const GENERATED_LOCAL_PROVIDER_MODULE = './utils/LLMProviders/providers/openai.mjs';

function generatedLocalAliasError(description) {
    const error = new Error(`${description} cannot alias the runtime-owned generated-local provider.`);
    error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
    return error;
}

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

// Re-export for use by other modules
export { parseModelReference } from './envConfigLoader.mjs';

export function loadRawConfig(configPath = DEFAULT_CONFIG_PATH) {
    if (!fs.existsSync(configPath)) {
        return {
            raw: { providers: {}, models: {} },
            issues: { errors: [`${DEFAULT_CONFIG_FILENAME} not found at ${configPath}`], warnings: [] },
        };
    }

    try {
        const rawContent = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(rawContent);
        return { raw: parsed || {}, issues: { errors: [], warnings: [] } };
    } catch (error) {
        return {
            raw: { providers: {}, models: {} },
            issues: { errors: [`Failed to read ${DEFAULT_CONFIG_FILENAME}: ${error.message}`], warnings: [] },
        };
    }
}

export function normalizeConfig(rawConfig, options = {}) {
    const issues = { errors: [], warnings: [] };
    const providers = new Map();
    const models = new Map();
    const providerModels = new Map();
    const qualifiedModels = new Map();
    const orderedModelNames = [];
    const promotedNames = new Set();

    const rawProviders = rawConfig?.providers && typeof rawConfig.providers === 'object' ? rawConfig.providers : {};
    const rawModels = Array.isArray(rawConfig?.models) ? rawConfig.models : [];

    for (const [providerKey, entry] of Object.entries(rawProviders)) {
        const normalized = normalizeProvider(providerKey, entry, issues, options);
        providers.set(providerKey, normalized);
        providerModels.set(providerKey, []);
    }

    for (const entry of rawModels) {
        const normalized = normalizeModel(entry, providers, issues, options);
        if (!normalized) {
            continue;
        }
        const modelName = normalized.name;
        const qualifiedName = `${normalized.providerKey}/${modelName}`;

        let mapKey;

        if (models.has(modelName) && !promotedNames.has(modelName)) {
            // First collision: promote existing entry to its qualified key
            const existing = models.get(modelName);
            const existingQualified = `${existing.providerKey}/${existing.name}`;

            models.set(existingQualified, existing);
            models.delete(modelName);
            qualifiedModels.set(existingQualified, existingQualified);
            // Unqualified fallback resolves to the first entry
            qualifiedModels.set(modelName, existingQualified);

            const idx = orderedModelNames.indexOf(modelName);
            if (idx !== -1) {
                orderedModelNames[idx] = existingQualified;
            }

            promotedNames.add(modelName);
            mapKey = qualifiedName;
        } else if (promotedNames.has(modelName)) {
            // Subsequent collision: use qualified key
            mapKey = qualifiedName;
        } else {
            // No collision: use unqualified name
            mapKey = modelName;
        }

        models.set(mapKey, normalized);
        orderedModelNames.push(mapKey);
        qualifiedModels.set(qualifiedName, mapKey);

        if (!providerModels.has(normalized.providerKey)) {
            providerModels.set(normalized.providerKey, []);
        }
        providerModels.get(normalized.providerKey).push(normalized);
    }

    validateProviders(providers, models, providerModels, issues);

    // Parse defaults map (intent name → model name)
    const defaults = new Map();
    if (rawConfig?.defaults && typeof rawConfig.defaults === 'object') {
        for (const [name, modelName] of Object.entries(rawConfig.defaults)) {
            if (typeof modelName === 'string' && modelName.trim()) {
                defaults.set(name, modelName.trim());
            }
        }
    }

    return {
        providers,
        models,
        providerModels,
        qualifiedModels,
        issues,
        raw: rawConfig,
        orderedModels: orderedModelNames,
        defaults,
    };
}

function normalizeProvider(providerKey, entry, issues, options) {
    if (!entry || typeof entry !== 'object') {
        issues.warnings.push(`Provider "${providerKey}" configuration must be an object.`);
    }

    const config = entry && typeof entry === 'object' ? entry : {};
    if (options.generatedLocalDescriptor
        && providerKey !== 'soul_gateway'
        && (config.apiKeyEnv === 'PLOINKY_AGENT_API_KEY'
            || isGeneratedLocalEndpointAlias(config.baseURL, options.generatedLocalDescriptor))) {
        throw generatedLocalAliasError(`Provider JSON "${providerKey}"`);
    }
    if (providerKey === 'soul_gateway' && options.generatedLocalDescriptor) {
        assertNoGeneratedLocalProtectedOverrides(config, 'Generated-local provider JSON');
        if (Object.hasOwn(config, 'module')
            && config.module !== GENERATED_LOCAL_PROVIDER_MODULE) {
            const error = new Error('Generated-local provider JSON cannot replace its authority-aware OpenAI module.');
            error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
            throw error;
        }
        if (Object.hasOwn(config, 'extra')) {
            const error = new Error('Generated-local provider JSON cannot define an extensible extra configuration bag.');
            error.code = 'PLOINKY_GENERATED_LOCAL_OVERRIDE';
            throw error;
        }
    }
    const apiKeyEnv = config.apiKeyEnv;
    if (!apiKeyEnv) {
        issues.warnings.push(`Provider "${providerKey}" does not declare apiKeyEnv.`);
    }

    const baseURL = selectString(config.baseURL, null);
    if (!baseURL) {
        issues.warnings.push(`Provider "${providerKey}" is missing baseURL; requests may fail unless overridden per model.`);
    }

    const modulePath = selectString(config.module, null);
    const defaultModel = selectString(config.defaultModel, null);

    return {
        name: providerKey,
        providerKey,
        apiKeyEnv,
        baseURL,
        defaultModel,
        module: modulePath,
        extra: config.extra || {},
    };
}

function normalizeModel(entry, providers, issues, options) {
    const modelName = selectString(entry && typeof entry === 'object' ? entry.name : null, null);
    let providerKey = null;
    let apiKeyEnvOverride = null;
    let baseURLOverride = null;

    if (!modelName) {
        issues.warnings.push('Model entry is missing required "name" property.');
        return null;
    }

    if (entry && typeof entry === 'object') {
        providerKey = entry.provider || entry.providerKey || null;
        apiKeyEnvOverride = selectString(entry.apiKeyEnv, null);
        baseURLOverride = selectString(entry.baseURL, null);
    } else {
        issues.warnings.push(`Model "${modelName}" configuration must be an object.`);
        return null;
    }

    if (options.generatedLocalDescriptor
        && providerKey !== 'soul_gateway'
        && (apiKeyEnvOverride === 'PLOINKY_AGENT_API_KEY'
            || isGeneratedLocalEndpointAlias(baseURLOverride, options.generatedLocalDescriptor))) {
        throw generatedLocalAliasError(`Model JSON "${modelName}"`);
    }

    if (!providerKey) {
        issues.errors.push(`Model "${modelName}" is missing provider reference.`);
        return null;
    }

    if (providerKey === 'soul_gateway' && options.generatedLocalDescriptor) {
        assertNoGeneratedLocalProtectedOverrides(entry, `Generated-local model JSON "${modelName}"`);
    }

    if (!providers.has(providerKey)) {
        issues.warnings.push(`Model "${modelName}" references unknown provider "${providerKey}".`);
    }

    const tags = Array.isArray(entry.tags) ? entry.tags.filter(t => typeof t === 'string') : [];

    return {
        name: modelName,
        providerKey,
        tags,
        apiKeyEnv: apiKeyEnvOverride,
        baseURL: baseURLOverride,
    };
}

function validateProviders(providers, models, providerModels, issues) {
    for (const provider of providers.values()) {
        if (provider.defaultModel) {
            const model = models.get(provider.defaultModel);
            if (!model) {
                issues.warnings.push(`Provider "${provider.name}" defaultModel "${provider.defaultModel}" is not defined.`);
            } else if (model.providerKey !== provider.providerKey) {
                issues.warnings.push(`Provider "${provider.name}" defaultModel "${provider.defaultModel}" belongs to provider "${model.providerKey}".`);
            }
        }

        if (!providerModels.get(provider.providerKey)?.length) {
            issues.warnings.push(`Provider "${provider.name}" has no models defined.`);
        }
    }
}

function selectString(preferred, fallback) {
    if (typeof preferred === 'string' && preferred.trim()) {
        return preferred.trim();
    }
    if (typeof fallback === 'string' && fallback.trim()) {
        return fallback.trim();
    }
    return null;
}

/**
 * Merge environment-defined providers and models with JSON config.
 * Env definitions take precedence and are added first in the model order.
 * 
 * @param {object} normalized - Normalized config from JSON
 * @param {object} envConfig - Config loaded from environment variables
 * @returns {object} Merged configuration
 */
function mergeEnvConfig(normalized, envConfig) {
    const { providers, models, providerModels, orderedModels, issues, qualifiedModels } = normalized;
    
    // Merge env providers (they take precedence over JSON)
    for (const [providerKey, envProvider] of envConfig.providers.entries()) {
        if (providers.has(providerKey)) {
            const existing = providers.get(providerKey);
            const generatedLocal = isVerifiedGeneratedLocalRouterDescriptor(
                envProvider.generatedLocalDescriptor
            );
            // A generated-local provider is wholly producer-owned. In
            // particular, never preserve a project JSON module or extensible
            // `extra` state that could bypass the authority-aware transport.
            const merged = generatedLocal ? { ...envProvider } : { ...existing, ...envProvider };
            if (!generatedLocal && existing.module) {
                merged.module = existing.module;
            }
            providers.set(providerKey, merged);
        } else {
            // Add new provider
            providers.set(providerKey, envProvider);
            providerModels.set(providerKey, []);
        }
    }
    
    // Merge env models (prepend to maintain priority)
    const envModelNames = [];
    for (const envModel of envConfig.models) {
        const qualifiedName = `${envModel.providerKey}/${envModel.name}`;
        
        // Check if this model already exists (by qualified name)
        let existingKey = null;
        for (const [key, model] of models.entries()) {
            if (model.providerKey === envModel.providerKey && model.name === envModel.name) {
                existingKey = key;
                break;
            }
        }
        
        if (existingKey) {
            // Override existing model
            const existing = models.get(existingKey);
            models.set(existingKey, { ...existing, ...envModel, fromEnv: true });
        } else {
            // Add new model
            models.set(envModel.name, { ...envModel, fromEnv: true });
            envModelNames.push(envModel.name);
            
            // Add to provider's model list
            if (!providerModels.has(envModel.providerKey)) {
                providerModels.set(envModel.providerKey, []);
            }
            providerModels.get(envModel.providerKey).push(envModel);
        }
        
        // Always add to qualified lookup
        qualifiedModels.set(qualifiedName, envModel.name);
    }
    
    // Build qualified name index for all models (including JSON-defined)
    for (const [modelName, model] of models.entries()) {
        const qualifiedName = `${model.providerKey}/${model.name}`;
        if (!qualifiedModels.has(qualifiedName)) {
            qualifiedModels.set(qualifiedName, modelName);
        }
    }
    
    // Prepend env model names to ordered list
    normalized.orderedModels = [...envModelNames, ...orderedModels];

    // Merge issues
    issues.errors.push(...envConfig.issues.errors);
    issues.warnings.push(...envConfig.issues.warnings);
    
    return normalized;
}

/**
 * Resolve a model name that may be in provider/model format.
 * Returns the model key used in the models map.
 * 
 * @param {string} modelRef - Model reference (either "model" or "provider/model")
 * @param {Map} models - Map of model names to model configs
 * @param {Map} qualifiedModels - Map of "provider/model" to model key
 * @returns {string|null} The model key, or null if not found
 */
export function resolveModelName(modelRef, models, qualifiedModels) {
    if (!modelRef) return null;
    
    const { provider, model } = parseModelReference(modelRef);
    
    if (provider) {
        // Qualified lookup: provider/model
        const qualifiedName = `${provider}/${model}`;
        if (qualifiedModels?.has(qualifiedName)) {
            return qualifiedModels.get(qualifiedName);
        }
        // Try direct lookup in case model name includes provider
        if (models.has(modelRef)) {
            return modelRef;
        }
        return null;
    }
    
    // Simple model name lookup
    if (models.has(model)) {
        return model;
    }

    // Fallback: check qualifiedModels for unqualified name (handles promoted/duplicate names)
    if (qualifiedModels?.has(model)) {
        return qualifiedModels.get(model);
    }

    return null;
}

/**
 * Discover models from providers that have their API key set in process.env.
 * Calls each provider's `/v1/models` endpoint and merges discovered models
 * into the normalized config. Discovered models do NOT override existing
 * static or env-defined models.
 */
async function discoverGatewayModels(normalized) {
    const { providers, models, providerModels, orderedModels, issues, qualifiedModels } = normalized;

    // If soul_gateway API key is set, discover only from soul_gateway
    // (it proxies all upstream providers, so no need to call them individually)
    const soulGateway = providers.get('soul_gateway');
    const generatedSoulGateway = isVerifiedGeneratedLocalRouterDescriptor(
        soulGateway?.generatedLocalDescriptor
    );
    const soulGatewayKeySet = generatedSoulGateway
        ? true
        : soulGateway?.apiKeyEnv && process.env[soulGateway.apiKeyEnv];

    const discoveryProviders = [];
    if (soulGatewayKeySet) {
        discoveryProviders.push(soulGateway);
    } else {
        for (const [, provider] of providers) {
            if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
                discoveryProviders.push(provider);
            }
        }
    }

    if (!discoveryProviders.length) return;

    // Discover models from providers
    const results = await Promise.all(discoveryProviders.map(p => discoverModels(p)));

    const gatewayModelNames = [];

    for (const { models: discovered, issues: discoveryIssues } of results) {
        issues.warnings.push(...discoveryIssues.warnings);
        issues.errors.push(...discoveryIssues.errors);

        for (const dm of discovered) {
            const qualifiedName = `${dm.providerKey}/${dm.name}`;

            const modelDescriptor = {
                name: dm.name,
                providerKey: dm.providerKey,
                tags: dm.tags || [],
                sortOrder: dm.sortOrder ?? 100,
                isFree: dm.isFree || false,
                billingType: dm.billingType || 'api_key',
                fromGateway: true,
            };

            // When discovering from soul_gateway, override existing static/env models
            // so requests route through the gateway instead of directly to providers.
            // For other providers, skip if model already exists.
            if (dm.providerKey === 'soul_gateway') {
                if (models.has(dm.name)) {
                    // Override existing model to route through soul_gateway
                    const existing = models.get(dm.name);
                    if (existing.providerKey !== 'soul_gateway') {
                        models.set(dm.name, modelDescriptor);
                    }
                } else {
                    models.set(dm.name, modelDescriptor);
                    gatewayModelNames.push(dm.name);
                }
            } else {
                // Non-gateway providers: skip if already exists
                if (models.has(dm.name) || qualifiedModels.has(qualifiedName)) {
                    continue;
                }
                models.set(dm.name, modelDescriptor);
                gatewayModelNames.push(dm.name);
            }

            qualifiedModels.set(qualifiedName, dm.name);

            if (!providerModels.has(dm.providerKey)) {
                providerModels.set(dm.providerKey, []);
            }
            providerModels.get(dm.providerKey).push(modelDescriptor);
        }
    }

    // Append gateway models at the end of the ordered list
    normalized.orderedModels = [...orderedModels, ...gatewayModelNames];

}

export async function loadModelsConfiguration(options = {}) {
    const generatedLocalDescriptor = hasGeneratedLocalDescriptorBundle(process.env)
        ? loadGeneratedLocalRouterDescriptor()
        : null;
    const configPath = options.configPath
        || process.env.LLM_MODELS_CONFIG_PATH
        || DEFAULT_CONFIG_PATH;
    const { raw, issues: loadIssues } = loadRawConfig(configPath);
    const normalizationOptions = { ...options, generatedLocalDescriptor };
    const normalized = normalizeConfig(raw, normalizationOptions);

    normalized.issues.errors.push(...loadIssues.errors);
    normalized.issues.warnings.push(...loadIssues.warnings);
    normalized.path = configPath;

    // Load and merge environment-defined providers and models
    const envConfig = loadEnvConfig({ generatedLocalDescriptor });
    mergeEnvConfig(normalized, envConfig);

    // Discover models from gateway providers
    await discoverGatewayModels(normalized);

    return normalized;
}
