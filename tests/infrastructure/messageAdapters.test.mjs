import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../../LLMAgents/LLMAgent.mjs';
import { listModelsFromCache, loadModelsConfiguration } from '../../utils/LLMClient.mjs'; // loadModelsConfiguration is needed to ensure models are loaded

import { toAnthropicMessages } from '../../utils/LLMProviders/messageAdapters/anthropicMessages.mjs';
import { toGeminiPayload } from '../../utils/LLMProviders/messageAdapters/googleGemini.mjs';
import { toHuggingFacePrompt } from '../../utils/LLMProviders/messageAdapters/huggingFaceConversational.mjs';
import { toOpenAIChatMessages } from '../../utils/LLMProviders/messageAdapters/openAIChat.mjs';
import { buildKiroRequest } from '../../utils/LLMProviders/providers/kiro.mjs';

// Ensure models are loaded before tests run
const modelsConfig = await loadModelsConfiguration();

function resolveAdapterKey(providerKey) {
    const provider = modelsConfig.providers?.get(providerKey);
    const moduleId = provider?.module || '';
    const normalized = moduleId.toLowerCase();

    if (normalized.includes('anthropic')) {
        return 'anthropic';
    }
    if (normalized.includes('google') || normalized.includes('gemini')) {
        return 'google';
    }
    if (normalized.includes('openai')) {
        return 'openai';
    }
    if (normalized.includes('huggingface')) {
        return 'openai';
    }
    return null;
}

const sampleHistory = [
    { role: 'system', message: 'You are a helpful assistant.' },
    { role: 'user', message: 'This is a test to see if the text is transformed to providers message format for their APIs' },
    { role: 'assistant', message: 'I will help with that.' },
];

test('role-aware conversation history is preserved by every message adapter', () => {
    const conversation = [
        { role: 'system', message: 'Planner rules' },
        { role: 'user', message: 'First request' },
        { role: 'assistant', message: 'First answer' },
        { role: 'user', message: 'Current request' },
    ];

    assert.deepEqual(toOpenAIChatMessages(conversation), [
        { role: 'system', content: 'Planner rules' },
        { role: 'user', content: 'First request' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Current request' },
    ]);

    assert.deepEqual(toAnthropicMessages(conversation), {
        system: 'Planner rules',
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'First request' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
            { role: 'user', content: [{ type: 'text', text: 'Current request' }] },
        ],
    });

    assert.deepEqual(toGeminiPayload(conversation), {
        systemInstruction: {
            role: 'system',
            parts: [{ text: 'Planner rules' }],
        },
        contents: [
            { role: 'user', parts: [{ text: 'First request' }] },
            { role: 'model', parts: [{ text: 'First answer' }] },
            { role: 'user', parts: [{ text: 'Current request' }] },
        ],
    });

    assert.equal(
        toHuggingFacePrompt(conversation),
        [
            'System: Planner rules',
            'User: First request',
            'Assistant: First answer',
            'User: Current request',
        ].join('\n'),
    );

    assert.deepEqual(
        buildKiroRequest(conversation, {
            model: 'test-model',
            params: {},
        }),
        {
            modelId: 'test-model',
            conversationState: {
                systemInstruction: 'Planner rules',
                turns: [
                    { role: 'user', content: [{ text: 'First request' }] },
                    { role: 'assistant', content: [{ text: 'First answer' }] },
                    { role: 'user', content: [{ text: 'Current request' }] },
                ],
            },
            inferenceConfig: {},
        },
    );
});

test('OpenAI chat messages preserve developer and tool-call history', () => {
    assert.deepEqual(toOpenAIChatMessages([
        { role: 'developer', content: 'Use tools when required.' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
    ]), [
        { role: 'developer', content: 'Use tools when required.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            }],
        },
        { role: 'tool', content: 'file contents', tool_call_id: 'call_1' },
    ]);
});

test('LLMAgent.complete uses correct message adapter for each configured model (mocked)', async () => {
    const llmAgent = new LLMAgent();

    // Override the complete method for this test
    llmAgent.complete = async (options = {}) => {
        const { history = [], model = null } = options; // prompt is now empty

        if (!model) {
            throw new Error('Model must be specified for mocked complete.');
        }

        const { models: allModels } = listModelsFromCache();
        const modelRecord = allModels.find(m => m.name === model);

        if (!modelRecord) {
            throw new Error(`Model ${model} not found in cache.`);
        }

        const providerKey = modelRecord.providerKey;
        const adapterKey = resolveAdapterKey(providerKey);
        let convertedContext;

        // Use history directly, as it now contains the full conversation
        switch (adapterKey) {
            case 'anthropic':
                convertedContext = toAnthropicMessages(history);
                break;
            case 'google':
                convertedContext = toGeminiPayload(history);
                break;
            case 'openai':
                convertedContext = toOpenAIChatMessages(history);
                break;
            default:
                throw new Error(`Unknown provider key: ${providerKey}`);
        }
        return JSON.stringify(convertedContext);
    };

    const { models: allModels } = listModelsFromCache();

    for (const modelRecord of allModels) {
        const modelName = modelRecord.name;
        const providerKey = modelRecord.providerKey;
        const adapterKey = resolveAdapterKey(providerKey);

        // Skip models that don't have a direct message adapter or are not relevant for this test
        if (!adapterKey) {
            continue;
        }

        const response = await llmAgent.complete({
            prompt: '', // No separate prompt, as fullHistory is passed
            history: sampleHistory, // Pass the full sampleHistory
            model: modelName,
        });

        const convertedContext = JSON.parse(response); // Parse the mocked response

        switch (adapterKey) {
            case 'anthropic': {
                const { system, messages } = convertedContext;
                assert.equal(system, 'You are a helpful assistant.', `Anthropic: Should extract system message for ${modelName}`);
                assert.equal(messages.length, 2, `Anthropic: Should have two messages for ${modelName}`);
                assert.equal(messages[0].role, 'user', `Anthropic: First message role should be user for ${modelName}`);
                assert.equal(messages[0].content[0].text, 'This is a test to see if the text is transformed to providers message format for their APIs', `Anthropic: First message content should match for ${modelName}`);
                assert.equal(messages[1].role, 'assistant', `Anthropic: Second message role should be assistant for ${modelName}`);
                assert.equal(messages[1].content[0].text, 'I will help with that.', `Anthropic: Second message content should match for ${modelName}`);
                break;
            }
            case 'google': {
                const { contents, systemInstruction } = convertedContext;
                assert.deepStrictEqual(systemInstruction, { role: 'system', parts: [{ text: 'You are a helpful assistant.' }] }, `Gemini: Should extract system instruction for ${modelName}`);
                assert.equal(contents.length, 2, `Gemini: Should have two contents for ${modelName}`);
                assert.equal(contents[0].role, 'user', `Gemini: First content role should be user for ${modelName}`);
                assert.ok(contents[0].parts, `Gemini: First content should have parts for ${modelName}`);
                assert.equal(contents[0].parts[0].text, 'This is a test to see if the text is transformed to providers message format for their APIs', `Gemini: First content text should match for ${modelName}`);
                assert.equal(contents[1].role, 'model', `Gemini: Second content role should be model for ${modelName}`);
                assert.ok(contents[1].parts, `Gemini: Second content should have parts for ${modelName}`);
                assert.equal(contents[1].parts[0].text, 'I will help with that.', `Gemini: Second content text should match for ${modelName}`);
                break;
            }
            case 'openai': {
                const messages = convertedContext;
                assert.equal(messages.length, 3, `OpenAI: Should have three messages for ${modelName}`);
                assert.equal(messages[0].role, 'system', `OpenAI: First message role should be system for ${modelName}`);
                assert.equal(messages[0].content, 'You are a helpful assistant.', `OpenAI: First message content should match for ${modelName}`);
                assert.equal(messages[1].role, 'user', `OpenAI: Second message role should be user for ${modelName}`);
                assert.equal(messages[1].content, 'This is a test to see if the text is transformed to providers message format for their APIs', `OpenAI: Second message content should match for ${modelName}`);
                assert.equal(messages[2].role, 'assistant', `OpenAI: Third message role should be assistant for ${modelName}`);
                assert.equal(messages[2].content, 'I will help with that.', `OpenAI: Third message content should match for ${modelName}`);
                break;
            }
        }
    }
});
