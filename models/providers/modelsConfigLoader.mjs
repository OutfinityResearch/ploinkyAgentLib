import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PROVIDER_ENV_MAP = {
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
};

const VALID_MODES = new Set(['fast', 'deep']);

export function loadRawConfig(configPath = path.join(__dirname, 'models.json')) {
    if (!fs.existsSync(configPath)) {
        return { raw: { providers: {}, models: {} }, issues: { errors: [`models.json not found at ${configPath}`], warnings: [] } };
    }

    try {
        const rawContent = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(rawContent);
        return { raw: parsed || {}, issues: { errors: [], warnings: [] } };
    } catch (error) {
        return { raw: { providers: {}, models: {} }, issues: { errors: [`Failed to read models.json: ${error.message}`], warnings: [] } };
    }
}

export function normalizeConfig(rawConfig, options = {}) {
    const issues = { errors: [], warnings: [] };
    const providers = new Map();
    const models = new Map();
    const providerModels = new Map();
    const orderedModelNames = [];

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
        models.set(modelName, normalized);
        orderedModelNames.push(modelName);

        if (!providerModels.has(normalized.providerKey)) {
            providerModels.set(normalized.providerKey, []);
        }
        providerModels.get(normalized.providerKey).push(normalized);
    }

    validateProviders(providers, models, providerModels, issues);

    return {
        providers,
        models,
        providerModels,
        issues,
        raw: rawConfig,
        orderedModels: orderedModelNames,
    };
}

function normalizeProvider(providerKey, entry, issues, options) {
    if (!entry || typeof entry !== 'object') {
        issues.warnings.push(`Provider "${providerKey}" configuration must be an object.`);
    }

    const config = entry && typeof entry === 'object' ? entry : {};
    const apiKeyEnv = selectString(config.apiKeyEnv, DEFAULT_PROVIDER_ENV_MAP[providerKey]);
    if (!apiKeyEnv) {
        issues.warnings.push(`Provider "${providerKey}" does not declare apiKeyEnv and no fallback is known.`);
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
    let mode = 'fast';
    let apiKeyEnvOverride = null;
    let baseURLOverride = null;

    if (!modelName) {
        issues.warnings.push('Model entry is missing required "name" property.');
        return null;
    }

    if (entry && typeof entry === 'object') {
        providerKey = entry.provider || entry.providerKey || null;
        mode = normalizeMode(entry.mode ?? entry.modes, issues, `model "${modelName}"`);
        apiKeyEnvOverride = selectString(entry.apiKeyEnv, null);
        baseURLOverride = selectString(entry.baseURL, null);
    } else {
        issues.warnings.push(`Model "${modelName}" configuration must be an object.`);
        return null;
    }

    if (!providerKey) {
        issues.errors.push(`Model "${modelName}" is missing provider reference.`);
        return null;
    }

    if (!providers.has(providerKey)) {
        issues.warnings.push(`Model "${modelName}" references unknown provider "${providerKey}".`);
    }

    return {
        name: modelName,
        providerKey,
        mode,
        apiKeyEnv: apiKeyEnvOverride,
        baseURL: baseURLOverride,
    };
}

function normalizeMode(rawMode, issues, context) {
    if (rawMode === undefined || rawMode === null) {
        return 'fast';
    }

    if (Array.isArray(rawMode)) {
        const normalized = rawMode
            .filter(value => typeof value === 'string')
            .map(value => value.toLowerCase())
            .filter(value => VALID_MODES.has(value));

        if (normalized.length > 1) {
            issues.warnings.push(`Model configuration for ${context} lists multiple modes; using "${normalized[0]}".`);
        }

        if (normalized.length) {
            return normalized[0];
        }

        issues.warnings.push(`No valid mode found for ${context}; defaulting to 'fast'.`);
        return 'fast';
    }

    if (typeof rawMode === 'string') {
        const lower = rawMode.toLowerCase();
        if (VALID_MODES.has(lower)) {
            return lower;
        }
    }

    issues.warnings.push(`Invalid mode value for ${context}; defaulting to 'fast'.`);
    return 'fast';
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

export function loadModelsConfiguration(options = {}) {
    const configPath = options.configPath
        || process.env.LLM_MODELS_CONFIG_PATH
        || path.join(__dirname, 'models.json');
    const { raw, issues: loadIssues } = loadRawConfig(configPath);
    const normalized = normalizeConfig(raw, options);

    normalized.issues.errors.push(...loadIssues.errors);
    normalized.issues.warnings.push(...loadIssues.warnings);
    normalized.path = configPath;
    return normalized;
}
