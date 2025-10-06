import { toHuggingFacePrompt } from '../messageAdapters/huggingFaceConversational.mjs';

export async function callLLM(chatContext, options) {
    if (!options || typeof options !== 'object') {
        throw new Error('Hugging Face provider requires invocation options.');
    }

    const { model, apiKey, baseURL, signal, params, headers } = options;

    if (!model) {
        throw new Error('Hugging Face provider requires a model name.');
    }
    if (!baseURL) {
        throw new Error('Hugging Face provider requires a baseURL.');
    }

    const normalizedBase = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const url = `${normalizedBase}/${model}`;

    const requestHeaders = {
        'Content-Type': 'application/json',
        ...(headers || {}),
    };

    if (apiKey) {
        requestHeaders.Authorization = `Bearer ${apiKey}`;
    }

    const payload = {
        inputs: toHuggingFacePrompt(chatContext),
        parameters: {
            return_full_text: false,
            max_new_tokens: 500,
        },
    };

    if (params && typeof params === 'object') {
        const { parameters, ...rest } = params;
        if (parameters && typeof parameters === 'object') {
            payload.parameters = { ...payload.parameters, ...parameters };
        }
        Object.assign(payload, rest);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 503) {
            throw new Error('Hugging Face model is currently loading or unavailable (503 Service Unavailable). Please try again later.');
        }
        throw new Error(`Hugging Face API Error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    if (Array.isArray(data) && data[0]?.generated_text) {
        return data[0].generated_text.trim();
    }
    if (data.error) {
        throw new Error(`Hugging Face API Error: ${data.error}`);
    }

    return typeof data === 'string' ? data : JSON.stringify(data);
}
