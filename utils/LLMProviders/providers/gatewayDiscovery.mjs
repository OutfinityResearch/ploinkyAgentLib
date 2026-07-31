/**
 * Provider Auto-Discovery
 *
 * Fetches available models from an OpenAI-compatible `/v1/models` endpoint
 * and converts them into achillesAgentLib model descriptors.
 * Works with any provider that exposes a standard models listing endpoint.
 *
 * ## Metadata compatibility
 *
 * The new Soul Gateway (v2) emits curated metadata under underscore-prefixed
 * keys to avoid colliding with any existing OpenAI-style fields:
 *   - `_is_free` — explicit free flag
 *   - `_tags`    — curated tag set (chat, fast, reasoning, coding, ...)
 *   - `_context` — `{ window, max_output_tokens }`
 *   - `_pricing` — `{ mode, input_per_million, output_per_million, request }`
 *
 * Legacy gateways used flat fields (`is_free`, `tags`, `context_window`,
 * `input_price`, `output_price`, `request_price`). Both shapes are kept
 * readable here so the discovery layer works against old and new deployments.
 * The underscore-prefixed fields always win when present — guessing or
 * merging between the two shapes would hide gateway-side bugs.
 */

import {
    GENERATED_LOCAL_MODELS_PATH,
    buildGeneratedLocalOperationURL,
    isVerifiedGeneratedLocalRouterDescriptor,
    refreshGeneratedLocalRouterDescriptor,
} from '../transport/generatedLocalRouterDescriptor.mjs';
import { routerHttpRequest } from '../transport/routerHttpTransport.mjs';

/**
 * Derive the `/v1/models` URL from a provider's baseURL.
 * Strips trailing path segments like `/v1/chat/completions`.
 */
function deriveModelsURL(baseURL) {
    return baseURL
        .replace(/\/chat\/completions\/?$/, '/models')
        .replace(/\/messages\/?$/, '/models')
        .replace(/\/completions\/?$/, '/models')
        .replace(/\/responses\/?$/, '/models');
}

/**
 * Pick the first defined value from a list of candidates. Used to prefer
 * new-gateway fields (`_is_free`, `_tags`, ...) over legacy flat fields
 * without collapsing `null`/`false`/`0` into "missing".
 */
function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

/**
 * Normalize pricing for a single /v1/models entry into a stable internal
 * shape. Prefers the new `_pricing` object, falls back to legacy flat fields.
 *
 * Returned shape:
 *   {
 *     mode:                'token' | 'request' | string | null,
 *     inputPricePerMillion:  number | null,
 *     outputPricePerMillion: number | null,
 *     requestPrice:          number | null,
 *   }
 *
 * No fuzzy inference: if a field is missing we return null rather than
 * defaulting to 0 — that way pricing-sensitive callers can distinguish
 * "declared free" from "unknown".
 */
export function normalizeGatewayPricing(model) {
    const pricing = model && typeof model._pricing === 'object' && model._pricing !== null
        ? model._pricing
        : null;

    if (pricing) {
        return {
            mode: pricing.mode ?? null,
            inputPricePerMillion: toFiniteNumberOrNull(pricing.input_per_million),
            outputPricePerMillion: toFiniteNumberOrNull(pricing.output_per_million),
            requestPrice: toFiniteNumberOrNull(pricing.request),
        };
    }

    // Legacy flat fields — older gateways quoted prices directly on the model
    // entry. We preserve the old 0-default semantics only when at least one
    // legacy field is actually present; otherwise we return nulls.
    const hasLegacy = ['input_price', 'output_price', 'request_price']
        .some(key => model && model[key] !== undefined && model[key] !== null);

    if (hasLegacy) {
        return {
            mode: null,
            inputPricePerMillion: toFiniteNumberOrNull(model.input_price),
            outputPricePerMillion: toFiniteNumberOrNull(model.output_price),
            requestPrice: toFiniteNumberOrNull(model.request_price),
        };
    }

    return {
        mode: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        requestPrice: null,
    };
}

function toFiniteNumberOrNull(value) {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize the full model-metadata block that the benchmark/discovery
 * layer cares about. Single source of truth for new vs legacy field names.
 *
 * Returned shape:
 *   {
 *     isFree:        boolean,
 *     tags:          string[],          // lowercased + deduped
 *     contextWindow: number | null,
 *     maxOutputTokens: number | null,
 *     pricing:       <normalizeGatewayPricing>,
 *   }
 *
 * Implementation notes:
 *   - Tags are lowercased and deduped so downstream comparisons can be
 *     plain `includes('fast')` without re-normalizing everywhere.
 *   - `isFree` is strict `=== true`: anything else (null, undefined, 'false',
 *     0) is treated as "not free". This matches Soul Gateway v2's contract.
 */
export function normalizeGatewayModelMetadata(model) {
    const rawTags = firstDefined(model?._tags, model?.tags);
    const tags = Array.isArray(rawTags)
        ? [...new Set(
            rawTags
                .filter(t => typeof t === 'string')
                .map(t => t.trim().toLowerCase())
                .filter(Boolean)
        )]
        : [];

    const isFreeRaw = firstDefined(model?._is_free, model?.is_free);
    const isFree = isFreeRaw === true;

    const context = (model && typeof model._context === 'object' && model._context !== null)
        ? model._context
        : null;
    const contextWindow = context
        ? toFiniteNumberOrNull(context.window)
        : toFiniteNumberOrNull(model?.context_window);
    const maxOutputTokens = context
        ? toFiniteNumberOrNull(context.max_output_tokens)
        : toFiniteNumberOrNull(model?.max_output_tokens);

    return {
        isFree,
        tags,
        contextWindow,
        maxOutputTokens,
        pricing: normalizeGatewayPricing(model),
    };
}

/**
 * Fetch models from a provider's /v1/models endpoint and return them as model descriptors.
 *
 * @param {object} providerConfig - Normalized provider config { providerKey, baseURL, apiKeyEnv, ... }
 * @returns {Promise<{ models: Array, issues: { errors: string[], warnings: string[] } }>}
 */
export async function discoverModels(providerConfig) {
    const issues = { errors: [], warnings: [] };
    const { providerKey, baseURL, apiKeyEnv } = providerConfig;

    if (isVerifiedGeneratedLocalRouterDescriptor(providerConfig.generatedLocalDescriptor)) {
        const descriptor = refreshGeneratedLocalRouterDescriptor(
            providerConfig.generatedLocalDescriptor
        );
        buildGeneratedLocalOperationURL(descriptor, GENERATED_LOCAL_MODELS_PATH);
        // Descriptor, mirrors, sources, exact operation, and brand have all
        // been revalidated. The generated API-key value is read only now.
        const apiKey = process.env.PLOINKY_AGENT_API_KEY;
        if (!apiKey) {
            const error = new Error('Generated-local model discovery requires its runtime credential.');
            error.code = 'PLOINKY_GENERATED_LOCAL_KEY_MISSING';
            throw error;
        }
        try {
            const response = await routerHttpRequest({
                descriptor,
                pathname: GENERATED_LOCAL_MODELS_PATH,
                method: 'GET',
                bearer: apiKey,
                totalTimeoutMs: 15_000,
            });
            if (!response.ok) {
                const detail = await response.readErrorText();
                issues.warnings.push(`Auto-discovery: generated-local models returned ${response.status}${detail ? ` (${detail})` : ''}.`);
                return { models: [], issues };
            }
            const data = await response.json();
            return {
                models: normalizeDiscoveredModels(data, providerKey),
                issues,
            };
        } catch (error) {
            if (String(error?.code || '').startsWith('PLOINKY_DESCRIPTOR_')
                || error?.code === 'PLOINKY_GENERATED_LOCAL_OVERRIDE') {
                throw error;
            }
            issues.warnings.push(`Auto-discovery: generated-local models request failed: ${error.message}`);
            return { models: [], issues };
        }
    }

    if (!baseURL) {
        issues.warnings.push(`Auto-discovery: provider "${providerKey}" has no baseURL.`);
        return { models: [], issues };
    }

    const modelsURL = deriveModelsURL(baseURL);
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;

    if (!apiKey) {
        issues.warnings.push(`Auto-discovery: no API key for provider "${providerKey}" (env: ${apiKeyEnv}).`);
        return { models: [], issues };
    }

    try {
        const resp = await fetch(modelsURL, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
            issues.warnings.push(`Auto-discovery: ${modelsURL} returned ${resp.status}.`);
            return { models: [], issues };
        }

        const data = await resp.json();
        const models = normalizeDiscoveredModels(data, providerKey);

        return { models, issues };
    } catch (err) {
        issues.warnings.push(`Auto-discovery: failed to fetch from ${modelsURL}: ${err.message}`);
        return { models: [], issues };
    }
}

function normalizeDiscoveredModels(data, providerKey) {
    const rawModels = Array.isArray(data) ? data : (data.data || []);
    return rawModels
        .filter(m => m.id)
        .map((m) => {
            const meta = normalizeGatewayModelMetadata(m);
            const tier = typeof m.tier === 'string' && m.tier.trim()
                ? m.tier.trim()
                : typeof m.mode === 'string' && m.mode.trim()
                    ? m.mode.trim()
                    : null;

            return {
                name: m.id,
                providerKey,
                ...(tier ? { tier } : {}),
                tags: meta.tags,
                inputPrice: meta.pricing.inputPricePerMillion ?? 0,
                outputPrice: meta.pricing.outputPricePerMillion ?? 0,
                pricing: meta.pricing,
                context: meta.contextWindow,
                maxOutputTokens: meta.maxOutputTokens,
                sortOrder: m.sort_order ?? 100,
                isFree: meta.isFree,
                billingType: m.billing_type || 'api_key',
                fromGateway: true,
            };
        })
        .sort((a, b) => a.sortOrder - b.sortOrder);
}
