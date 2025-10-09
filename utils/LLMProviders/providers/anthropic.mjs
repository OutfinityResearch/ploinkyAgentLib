import { toAnthropicMessages } from '../messageAdapters/anthropicMessages.mjs';

export async function callLLM(chatContext, options) {
    if (!options || typeof options !== 'object') {
        throw new Error('Anthropic provider requires invocation options.');
    }
    const { model, apiKey, baseURL, signal, params, headers } = options;

    if (!model) {
        throw new Error('Anthropic provider requires a model name.');
    }
    if (!apiKey) {
        throw new Error('Anthropic provider requires an API key.');
    }
    if (!baseURL) {
        throw new Error('Anthropic provider requires a baseURL.');
    }

    const { messages, system } = toAnthropicMessages(chatContext);
    const payload = {
        model,
        max_tokens: 1000,
        messages,
    };

    if (system) {
        payload.system = system;
    }

    if (params && typeof params === 'object') {
        Object.assign(payload, params);
    }

    const response = await fetch(baseURL, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            ...(headers || {}),
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic API Error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(JSON.stringify(data.error));
    }
    return data.content?.[0]?.text;
}
