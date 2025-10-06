import { toOpenAIChatMessages } from '../messageAdapters/openAIChat.mjs';

export async function callLLM(chatContext, options) {
    if (!options || typeof options !== 'object') {
        throw new Error('OpenAI provider requires invocation options.');
    }

    const { model, apiKey, baseURL, signal, params, headers } = options;
    if (!model) {
        throw new Error('OpenAI provider requires a model name.');
    }
    if (!apiKey) {
        throw new Error('OpenAI provider requires an API key.');
    }
    if (!baseURL) {
        throw new Error('OpenAI provider requires a baseURL.');
    }

    const convertedContext = toOpenAIChatMessages(chatContext);
    const payload = {
        model,
        messages: convertedContext,
    };

    if (params && typeof params === 'object') {
        Object.assign(payload, params);
    }

    const response = await fetch(baseURL, {
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
        throw new Error(`OpenAI API Error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(JSON.stringify(data.error));
    }
    return data.choices?.[0]?.message?.content;
}
