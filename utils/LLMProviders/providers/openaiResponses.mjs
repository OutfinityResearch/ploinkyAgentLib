import { STATUS_CODES } from 'node:http';

import { toOpenAIChatMessages } from '../messageAdapters/openAIChat.mjs';
import { parseSSEStream } from './sseParser.mjs';

/**
 * OpenAI Responses API provider.
 *
 * Used by models that require the /v1/responses endpoint (e.g. gpt-5.2-codex)
 * instead of the /v1/chat/completions endpoint.
 *
 * Key differences from the Chat Completions API:
 *  - Endpoint: POST /v1/responses (or /backend-api/codex/responses for
 *    Codex with a ChatGPT account — see resolveResponsesURL)
 *  - Payload uses `input` (array of message objects) instead of `messages`
 *  - Role mapping: "system" -> "developer", "user" stays "user",
 *    "assistant" stays "assistant"
 *  - Response shape: output[] -> message -> content[] -> output_text -> text
 *
 * Callers that need the top-level `instructions` field (required by the
 * Codex backend) can pass `instructions` via `options.params` — when it
 * is a string, system messages are filtered out of `input` so they
 * don't get duplicated as both instructions and developer messages.
 */

const ROLE_MAP = {
    system: 'developer',
    developer: 'developer',
    user: 'user',
    assistant: 'assistant',
};

/**
 * Convert standard OpenAI chat messages into Responses API input items.
 * The Responses API uses "developer" instead of "system".
 *
 * @param {Array} chatContext     - Conversation history
 * @param {object} [opts]
 * @param {boolean} [opts.stripSystem]  If true, drop any system/developer
 *        messages from the returned input array. Used when the caller is
 *        providing instructions as a separate top-level field.
 */
function toResponsesInput(chatContext, { stripSystem = false } = {}) {
    const messages = toOpenAIChatMessages(chatContext);
    const filtered = stripSystem
        ? messages.filter((msg) => msg.role !== 'system' && msg.role !== 'developer')
        : messages;
    const input = [];

    for (const msg of filtered) {
        if (msg.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: stringifyToolOutput(msg.content),
            });
            continue;
        }

        const content = Array.isArray(msg.content)
            ? msg.content.map((part) => {
                if (part.type === 'text') return { type: 'input_text', text: part.text || '' };
                if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || '' };
                return part;
            })
            : msg.content;

        if (content !== '' && content !== null && content !== undefined) {
            input.push({
                role: ROLE_MAP[msg.role] || 'user',
                content,
            });
        }

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const toolCall of msg.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                });
            }
        }
    }

    return input;
}

function stringifyToolOutput(content) {
    if (typeof content === 'string') return content;
    if (content === undefined || content === null) return '';
    return JSON.stringify(content);
}

function convertTools(tools) {
    return (tools || []).map((tool) => {
        const fn = tool.function || tool;
        return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
        };
    });
}

/**
 * Extract text from the Responses API output structure.
 * The output is an array of items; each message item contains a content array
 * with entries of type "output_text".
 */
function extractOutputText(output) {
    if (!Array.isArray(output)) {
        return '';
    }

    const textParts = [];
    for (const item of output) {
        if (item.type !== 'message') continue;
        if (!Array.isArray(item.content)) continue;
        for (const block of item.content) {
            if (block.type === 'output_text' && typeof block.text === 'string') {
                textParts.push(block.text);
            }
        }
    }
    return textParts.join('\n').trim();
}

function extractFinalEventText(eventType, data) {
    if (eventType === 'response.output_text.done' && typeof data?.text === 'string') {
        return data.text;
    }

    if (eventType === 'response.output_item.done') {
        return extractOutputText([data?.item]);
    }

    if (eventType === 'response.completed') {
        if (typeof data?.response?.output_text === 'string') {
            return data.response.output_text;
        }
        return extractOutputText(data?.response?.output);
    }

    return '';
}

function getMissingFinalText(streamedText, finalText) {
    if (!finalText) {
        return '';
    }
    if (!streamedText) {
        return finalText;
    }
    if (finalText.startsWith(streamedText)) {
        return finalText.slice(streamedText.length);
    }
    return '';
}

function responseFunctionCalls(output) {
    if (!Array.isArray(output)) return [];
    return output
        .map((item, outputIndex) => ({ item, outputIndex }))
        .filter(({ item }) => item?.type === 'function_call');
}

function createToolCallAccumulator(item = {}, outputIndex = 0) {
    return {
        index: outputIndex,
        itemId: item.id || '',
        id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: item.arguments || '',
        emittedIdentity: false,
        emittedArgumentsLength: 0,
    };
}

function mergeToolCallAccumulator(accumulator, item = {}) {
    if (item.id) accumulator.itemId = item.id;
    if (item.call_id) accumulator.id = item.call_id;
    if (!accumulator.id && item.id) accumulator.id = item.id;
    if (item.name) accumulator.name = item.name;
    if (typeof item.arguments === 'string') accumulator.arguments = item.arguments;
    return accumulator;
}

function toolCallDelta(accumulator) {
    const missingArguments = accumulator.arguments.slice(
        accumulator.emittedArgumentsLength,
    );
    const needsIdentity = !accumulator.emittedIdentity;
    if (!needsIdentity && !missingArguments) return null;

    accumulator.emittedIdentity = true;
    accumulator.emittedArgumentsLength = accumulator.arguments.length;
    return {
        index: accumulator.index,
        id: needsIdentity ? accumulator.id : undefined,
        type: 'function',
        function: {
            name: needsIdentity ? accumulator.name : undefined,
            arguments: missingArguments,
        },
    };
}

function deriveProviderLabel(baseURL) {
    const match = baseURL.match(/https?:\/\/api\.([^/]+)\/?/i);
    return match?.[1] || 'OpenAI';
}

/**
 * Resolve the full Responses API URL from a provider base URL.
 *
 * - If the base URL already ends with `/responses`, pass it through.
 * - If it ends with `/v1`, append `/responses`.
 * - If it contains `/backend-api/` (e.g. ChatGPT's Codex backend at
 *   `https://chatgpt.com/backend-api/codex`), the endpoint lives at
 *   `<base>/responses` — NOT `<base>/v1/responses`.
 * - Otherwise default to `<base>/v1/responses` (standard OpenAI shape).
 *
 * Empty/missing base URL falls back to the canonical OpenAI endpoint.
 */
function resolveResponsesURL(baseURL) {
    const trimmed = (baseURL || '').replace(/\/+$/, '');
    if (!trimmed) {
        return 'https://api.openai.com/v1/responses';
    }

    if (trimmed.endsWith('/responses')) {
        return trimmed;
    }

    if (trimmed.endsWith('/v1')) {
        return `${trimmed}/responses`;
    }

    // Non-/v1 Responses endpoints such as Codex's ChatGPT backend.
    if (trimmed.includes('/backend-api/')) {
        return `${trimmed}/responses`;
    }

    return `${trimmed}/v1/responses`;
}

/**
 * Default client_version sent to the Codex ChatGPT backend's /models
 * listing endpoint. Each Codex model carries its own
 * `minimal_client_version` and the backend hides models whose minimum
 * is above the requested `client_version`. We send an artificially
 * high value so newly-published models (gpt-5.3-codex, gpt-5.4, ...
 * which require 0.98.0+) show up in the listing alongside older ones.
 *
 * This affects discovery only; inference endpoints do not validate
 * the client_version query param.
 */
const DEFAULT_CODEX_CLIENT_VERSION = '99.99.99';

/**
 * Resolve the full /models listing URL from a provider base URL.
 *
 * Follows the same base-URL convention as resolveResponsesURL:
 * - If the base URL already ends with `/models`, pass it through.
 * - If it ends with `/v1`, append `/models`.
 * - If it contains `/backend-api/` (Codex ChatGPT backend), append
 *   `/models?client_version=<clientVersion>` — the Codex backend
 *   requires a `client_version` query parameter and uses it to
 *   filter models by their per-entry `minimal_client_version`.
 * - Otherwise default to `<base>/v1/models` (standard OpenAI shape).
 *
 * @param {string} baseURL
 * @param {object} [options]
 * @param {string} [options.clientVersion]  Override the default
 *        Codex client_version (only used for /backend-api/ URLs).
 */
function resolveModelsURL(baseURL, { clientVersion = DEFAULT_CODEX_CLIENT_VERSION } = {}) {
    const trimmed = (baseURL || '').replace(/\/+$/, '');
    if (!trimmed) {
        return 'https://api.openai.com/v1/models';
    }

    if (trimmed.endsWith('/models')) {
        return trimmed;
    }

    if (trimmed.endsWith('/v1')) {
        return `${trimmed}/models`;
    }

    if (trimmed.includes('/backend-api/')) {
        return `${trimmed}/models?client_version=${encodeURIComponent(clientVersion)}`;
    }

    return `${trimmed}/v1/models`;
}

/**
 * Normalize a raw model entry into the shape the Soul Gateway's
 * auto-provisioner consumes. Handles both response shapes:
 *
 *  - Codex backend: `{ slug, display_name, description, context_window,
 *    input_modalities, visibility, supported_in_api, ... }`
 *  - Standard OpenAI: `{ id, object: 'model', created, owned_by }`
 *
 * Codex's `supported_in_api` flag distinguishes models available to API-key
 * callers from ChatGPT-only models. Preserve it so callers can apply the
 * authentication-mode-specific filtering used by the official Codex client.
 */
function normalizeDiscoveryModel(raw, { providerLabel } = {}) {
    if (!raw) return null;
    const modelId = raw.slug || raw.id || raw.model_key;
    if (!modelId) return null;

    const inputModalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : null;
    const supportsVision = inputModalities ? inputModalities.includes('image') : null;

    return {
        modelId,
        displayName: raw.display_name || raw.id || modelId,
        description: raw.description || null,
        contextWindow: raw.context_window ?? null,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision,
        ownedBy: raw.owned_by || providerLabel || null,
        visibility: raw.visibility || null,
        metadata: {
            inputModalities,
            minimalClientVersion: raw.minimal_client_version || null,
            priority: raw.priority ?? null,
            reasoningSummaryFormat: raw.reasoning_summary_format || null,
            supportedInApi: raw.supported_in_api ?? null,
            supportedReasoningLevels: Array.isArray(raw.supported_reasoning_levels)
                ? raw.supported_reasoning_levels.map((l) => l.effort || l).filter(Boolean)
                : null,
        },
    };
}

/**
 * List available models for a provider via its `/models` endpoint.
 *
 * Supports two response shapes:
 *  - Codex ChatGPT backend: `{ models: [ ... ] }` with `slug`,
 *    `visibility`, `supported_in_api` per entry.
 *  - Standard OpenAI: `{ object: 'list', data: [ ... ] }` (or a bare
 *    array) with `id` per entry.
 *
 * Returns a normalized array; callers filter further if they want to
 * drop hidden/unsupported entries.
 *
 * @param {object} options
 * @param {string} options.baseURL  Provider base URL (same value used
 *                                  for callLLMStreaming)
 * @param {string} options.apiKey   Bearer token / API key
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.headers]  Extra headers (e.g. User-Agent)
 * @param {boolean} [options.includeChatGPTOnly=false] Include Codex models
 *                                  marked `supported_in_api: false`. The
 *                                  official Codex client includes these for
 *                                  ChatGPT OAuth and filters them for API keys.
 * @returns {Promise<Array<object>>}
 */
export async function listModels(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('OpenAI Responses listModels requires invocation options.');
    }

    const {
        baseURL,
        apiKey,
        signal,
        headers,
        clientVersion,
        includeChatGPTOnly = false,
    } = options;
    if (!baseURL) {
        throw new Error('OpenAI Responses listModels requires a baseURL.');
    }
    if (!apiKey) {
        throw new Error('OpenAI Responses listModels requires an API key.');
    }
    const providerLabel = deriveProviderLabel(baseURL);

    const url = resolveModelsURL(baseURL, { clientVersion });
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            ...(headers || {}),
        },
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        const err = new Error(`${providerLabel} Responses model-list request failed: ${response.status} - ${response.statusText || STATUS_CODES[response.status] || 'Unknown Error'}.`);
        err.status = response.status;
        try { err.body = JSON.parse(errorBody); } catch { err.body = { raw: errorBody }; }
        throw err;
    }

    const data = await response.json();

    // Codex ChatGPT backend: { models: [...] }
    if (Array.isArray(data?.models)) {
        return data.models
            .filter((m) => m && (includeChatGPTOnly || m.supported_in_api !== false))
            .map((m) => normalizeDiscoveryModel(m, { providerLabel }))
            .filter(Boolean);
    }

    // Standard OpenAI: { object: 'list', data: [...] } or a bare array
    const rawModels = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return rawModels
        .map((m) => normalizeDiscoveryModel(m, { providerLabel }))
        .filter(Boolean);
}

export async function callLLM(chatContext, options) {
    if (!options || typeof options !== 'object') {
        throw new Error('OpenAI Responses provider requires invocation options.');
    }

    const { model, apiKey, baseURL, signal, params, headers } = options;
    const providerLabel = deriveProviderLabel(baseURL);
    if (!model) {
        throw new Error(`${providerLabel} Responses provider requires a model name.`);
    }
    if (!apiKey) {
        throw new Error(`${providerLabel} Responses provider requires an API key.`);
    }
    if (!baseURL) {
        throw new Error(`${providerLabel} Responses provider requires a baseURL.`);
    }

    const hasExplicitInstructions = typeof params?.instructions === 'string';
    const input = toResponsesInput(chatContext, { stripSystem: hasExplicitInstructions });
    const payload = {
        model,
        input,
    };

    if (params && typeof params === 'object') {
        Object.assign(payload, params);
        if (Array.isArray(params.tools)) {
            payload.tools = convertTools(params.tools);
        }
    }

    const response = await fetch(resolveResponsesURL(baseURL), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(headers || {}),
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        throw new Error(`${providerLabel} Responses API request failed: ${response.status} - ${response.statusText || STATUS_CODES[response.status] || 'Unknown Error'}.`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`${providerLabel} Responses API returned an error: ${typeof data.error === 'string' ? data.error : data.error.message || 'Unknown provider error.'}`);
    }

    // Try the convenience property first, fall back to manual extraction
    if (typeof data.output_text === 'string') {
        return data.output_text;
    }

    return extractOutputText(data.output);
}

/**
 * Streaming variant of callLLM for the OpenAI Responses API.
 *
 * Sets `stream: true`.  The Responses API emits typed SSE events:
 *   - `response.output_text.delta` with `{ delta: string }` — text chunk
 *   - `response.output_text.done` / `response.output_item.done` — finalized output
 *   - `response.completed` — final response, which can also carry output
 *   - `error` — API error
 *
 * @param {Array}  chatContext - Conversation history.
 * @param {object} options     - Same shape as callLLM options.
 * @yields {StreamChunk}
 */
export async function* callLLMStreaming(chatContext, options) {
    if (!options || typeof options !== 'object') {
        throw new Error('OpenAI Responses provider requires invocation options.');
    }

    const { model, apiKey, baseURL, signal, params, headers } = options;
    const providerLabel = deriveProviderLabel(baseURL);
    if (!model) throw new Error(`${providerLabel} Responses provider requires a model name.`);
    if (!apiKey) throw new Error(`${providerLabel} Responses provider requires an API key.`);
    if (!baseURL) throw new Error(`${providerLabel} Responses provider requires a baseURL.`);

    // When the caller provides `instructions` as a top-level param
    // (required by the Codex backend and honoured by the standard
    // Responses API), strip system/developer messages from `input` so
    // they don't get duplicated in both places.
    const hasExplicitInstructions = typeof params?.instructions === 'string';
    const input = toResponsesInput(chatContext, { stripSystem: hasExplicitInstructions });
    const payload = {
        model,
        input,
        stream: true,
    };

    if (params && typeof params === 'object') {
        Object.assign(payload, params);
        if (Array.isArray(params.tools)) {
            payload.tools = convertTools(params.tools);
        }
    }

    const response = await fetch(resolveResponsesURL(baseURL), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(headers || {}),
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        const err = new Error(`${providerLabel} Responses API request failed: ${response.status} - ${response.statusText || STATUS_CODES[response.status] || 'Unknown Error'}.`);
        err.status = response.status;
        try { err.body = JSON.parse(errorBody); } catch { err.body = { raw: errorBody }; }
        throw err;
    }

    let fullText = '';
    let usage = null;
    let finalText = '';
    const toolCallsByIndex = new Map();
    const toolCallIndexByItemId = new Map();

    const getToolCall = (data, item = data?.item || {}) => {
        const index = Number.isInteger(data?.output_index)
            ? data.output_index
            : toolCallIndexByItemId.get(data?.item_id || item?.id) ?? toolCallsByIndex.size;
        let accumulator = toolCallsByIndex.get(index);
        if (!accumulator) {
            accumulator = createToolCallAccumulator(item, index);
            toolCallsByIndex.set(index, accumulator);
        } else {
            mergeToolCallAccumulator(accumulator, item);
        }
        const itemId = data?.item_id || item?.id;
        if (itemId) toolCallIndexByItemId.set(itemId, index);
        return accumulator;
    };

    try {
        for await (const frame of parseSSEStream(response.body, { doneSentinel: null })) {
            const data = frame.parsedData;
            if (!data) continue;

            // The Responses API uses the SSE event field for event type
            const eventType = frame.event || data.type;

            if (eventType === 'error') {
                const errPayload = data.error || data;
                yield {
                    type: 'error',
                    error: new Error(`${providerLabel} Responses API returned an error: ${typeof errPayload === 'string' ? errPayload : errPayload.message || 'Unknown provider error.'}`),
                };
                return;
            }

            if (data.usage || data.response?.usage) {
                usage = data.usage || data.response?.usage;
            }

            if (eventType === 'response.output_text.delta' && typeof data.delta === 'string') {
                fullText += data.delta;
                yield { type: 'text_delta', text: data.delta };
            }

            if (eventType === 'response.output_item.added' && data.item?.type === 'function_call') {
                const accumulator = getToolCall(data);
                const delta = toolCallDelta(accumulator);
                if (delta) yield { type: 'tool_calls_delta', toolCalls: [delta] };
            }

            if (eventType === 'response.function_call_arguments.delta' && typeof data.delta === 'string') {
                const accumulator = getToolCall(data);
                accumulator.arguments += data.delta;
                const delta = toolCallDelta(accumulator);
                if (delta) yield { type: 'tool_calls_delta', toolCalls: [delta] };
            }

            if (eventType === 'response.function_call_arguments.done') {
                const accumulator = getToolCall(data, {
                    name: data.name,
                    arguments: data.arguments,
                });
                const delta = toolCallDelta(accumulator);
                if (delta) yield { type: 'tool_calls_delta', toolCalls: [delta] };
            }

            if (eventType === 'response.output_item.done' && data.item?.type === 'function_call') {
                const accumulator = getToolCall(data);
                const delta = toolCallDelta(accumulator);
                if (delta) yield { type: 'tool_calls_delta', toolCalls: [delta] };
            }

            const completedText = extractFinalEventText(eventType, data);
            if (completedText) {
                finalText = completedText;
            }

            if (eventType === 'response.completed') {
                for (const { item, outputIndex } of responseFunctionCalls(data.response?.output)) {
                    const accumulator = getToolCall({ output_index: outputIndex, item });
                    const delta = toolCallDelta(accumulator);
                    if (delta) yield { type: 'tool_calls_delta', toolCalls: [delta] };
                }
                break;
            }
        }
    } catch (err) {
        yield { type: 'error', error: err };
        return;
    }

    const missingFinalText = getMissingFinalText(fullText, finalText);
    if (missingFinalText) {
        fullText += missingFinalText;
        yield { type: 'text_delta', text: missingFinalText };
    }

    const toolCalls = [...toolCallsByIndex.values()]
        .sort((left, right) => left.index - right.index)
        .map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
            },
        }));

    yield {
        type: 'done',
        fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        usage,
        stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
}
