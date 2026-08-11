/**
 * Tests for the OpenAI Responses API provider
 * (utils/LLMProviders/providers/openaiResponses.mjs).
 *
 * Covers the Soul Gateway protocol-family additions:
 *   - resolveResponsesURL detects /backend-api/ endpoints and appends
 *     /responses instead of /v1/responses (Codex ChatGPT backend).
 *   - callLLMStreaming filters system/developer messages from input
 *     when the caller supplies an explicit top-level `instructions`
 *     string via params (required by Codex, harmless for OpenAI).
 *   - callLLMStreaming surfaces structured HTTP errors with a .status
 *     and a parsed .body on the thrown Error.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLLMStreaming, listModels } from '../utils/LLMProviders/providers/openaiResponses.mjs';

// ─── fetch stub helpers ─────────────────────────────────────────────

let originalFetch;
let fetchCalls;

function stubFetch(handler) {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return handler(url, init);
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
    fetchCalls = null;
}

function buildStreamResponse({ events = [], status = 200, statusText = 'OK' } = {}) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            for (const event of events) {
                const payload = typeof event === 'string' ? event : JSON.stringify(event.data || {});
                const frame = event.event
                    ? `event: ${event.event}\ndata: ${payload}\n\n`
                    : `data: ${payload}\n\n`;
                controller.enqueue(encoder.encode(frame));
            }
            controller.close();
        },
    });
    return new Response(body, {
        status,
        statusText,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

function buildErrorResponse({ status = 400, body = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function drain(asyncIterable) {
    const collected = [];
    for await (const chunk of asyncIterable) {
        collected.push(chunk);
    }
    return collected;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('openaiResponses.resolveResponsesURL', () => {
    afterEach(restoreFetch);

    it('appends /v1/responses to a bare api.openai.com base URL', async () => {
        stubFetch(() => buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] }));
        await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-4o', apiKey: 'k', baseURL: 'https://api.openai.com' },
        ));
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, 'https://api.openai.com/v1/responses');
    });

    it('appends /responses when the base URL already ends in /v1', async () => {
        stubFetch(() => buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] }));
        await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-4o', apiKey: 'k', baseURL: 'https://api.openai.com/v1' },
        ));
        assert.equal(fetchCalls[0].url, 'https://api.openai.com/v1/responses');
    });

    it('passes through a URL that already ends in /responses', async () => {
        stubFetch(() => buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] }));
        await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-4o', apiKey: 'k', baseURL: 'https://example.test/custom/responses' },
        ));
        assert.equal(fetchCalls[0].url, 'https://example.test/custom/responses');
    });

    it('appends /responses (NOT /v1/responses) for ChatGPT /backend-api/ URLs', async () => {
        stubFetch(() => buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] }));
        await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));
        assert.equal(fetchCalls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    });

    it('strips a trailing slash before appending', async () => {
        stubFetch(() => buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] }));
        await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex/' },
        ));
        assert.equal(fetchCalls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    });
});

describe('openaiResponses.callLLMStreaming — instructions / stripSystem', () => {
    afterEach(restoreFetch);

    it('forwards instructions as a top-level payload field when passed via params', async () => {
        let captured;
        stubFetch((_url, init) => {
            captured = JSON.parse(init.body);
            return buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] });
        });

        await drain(callLLMStreaming(
            [
                { role: 'system', content: 'You are a pirate.' },
                { role: 'user', content: 'hi' },
            ],
            {
                model: 'gpt-5.4',
                apiKey: 'k',
                baseURL: 'https://chatgpt.com/backend-api/codex',
                params: { instructions: 'You are a pirate.' },
            },
        ));

        assert.equal(captured.instructions, 'You are a pirate.');
    });

    it('strips system messages from input[] when params.instructions is set', async () => {
        let captured;
        stubFetch((_url, init) => {
            captured = JSON.parse(init.body);
            return buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] });
        });

        await drain(callLLMStreaming(
            [
                { role: 'system', content: 'You are a pirate.' },
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'Ahoy!' },
            ],
            {
                model: 'gpt-5.4',
                apiKey: 'k',
                baseURL: 'https://chatgpt.com/backend-api/codex',
                params: { instructions: 'You are a pirate.' },
            },
        ));

        assert.equal(captured.input.length, 2);
        assert.equal(captured.input[0].role, 'user');
        assert.equal(captured.input[1].role, 'assistant');
        for (const item of captured.input) {
            assert.notEqual(item.role, 'developer');
            assert.notEqual(item.role, 'system');
        }
    });

    it('keeps the existing behaviour (maps system → developer) when instructions is NOT provided', async () => {
        let captured;
        stubFetch((_url, init) => {
            captured = JSON.parse(init.body);
            return buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] });
        });

        await drain(callLLMStreaming(
            [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'hi' },
            ],
            {
                model: 'gpt-4o',
                apiKey: 'k',
                baseURL: 'https://api.openai.com/v1',
            },
        ));

        assert.equal(captured.instructions, undefined);
        assert.equal(captured.input.length, 2);
        assert.equal(captured.input[0].role, 'developer');
        assert.equal(captured.input[1].role, 'user');
    });

    it('converts assistant function calls and tool results into Responses input items', async () => {
        let captured;
        stubFetch((_url, init) => {
            captured = JSON.parse(init.body);
            return buildStreamResponse({ events: [{ event: 'response.completed', data: {} }] });
        });

        await drain(callLLMStreaming(
            [
                { role: 'user', content: 'Read a file.' },
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
            ],
            {
                model: 'gpt-5.4',
                apiKey: 'k',
                baseURL: 'https://api.openai.com/v1',
            },
        ));

        assert.deepEqual(captured.input, [
            { role: 'user', content: 'Read a file.' },
            {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"a.txt"}',
            },
            {
                type: 'function_call_output',
                call_id: 'call_1',
                output: 'file contents',
            },
        ]);
    });
});

describe('openaiResponses.callLLMStreaming — error surfacing', () => {
    afterEach(restoreFetch);

    it('throws an Error with .status and parsed .body when the upstream returns 400', async () => {
        stubFetch(() => buildErrorResponse({
            status: 400,
            body: { detail: 'Instructions are required' },
        }));

        let caught;
        try {
            await drain(callLLMStreaming(
                [{ role: 'user', content: 'hi' }],
                {
                    model: 'gpt-5.4',
                    apiKey: 'k',
                    baseURL: 'https://chatgpt.com/backend-api/codex',
                },
            ));
        } catch (err) {
            caught = err;
        }

        assert.ok(caught, 'expected an error to be thrown');
        assert.equal(caught.status, 400);
        assert.equal(caught.message, 'OpenAI Responses API request failed: 400 - Bad Request.');
        assert.doesNotMatch(caught.message, /Instructions are required/);
        assert.deepEqual(caught.body, { detail: 'Instructions are required' });
    });

    it('falls back to the raw body text when the error response is not JSON', async () => {
        stubFetch(() => new Response('plain text failure', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
        }));

        let caught;
        try {
            await drain(callLLMStreaming(
                [{ role: 'user', content: 'hi' }],
                { model: 'gpt-4o', apiKey: 'k', baseURL: 'https://api.openai.com/v1' },
            ));
        } catch (err) {
            caught = err;
        }

        assert.ok(caught);
        assert.equal(caught.status, 500);
        assert.equal(caught.message, 'openai.com Responses API request failed: 500 - Internal Server Error.');
        assert.doesNotMatch(caught.message, /plain text failure/);
        assert.deepEqual(caught.body, { raw: 'plain text failure' });
    });

    it('surfaces response.failed as an error chunk instead of a successful empty response', async () => {
        const failedEvent = {
            event: 'response.failed',
            data: {
                response: {
                    status: 'failed',
                    error: {
                        code: 'model_error',
                        message: 'The upstream model rejected the request.',
                    },
                },
            },
        };
        stubFetch(() => buildStreamResponse({ events: [failedEvent] }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].type, 'error');
        assert.equal(chunks[0].error.code, 'OPENAI_RESPONSES_FAILED');
        assert.equal(
            chunks[0].error.message,
            'OpenAI Responses API response failed: The upstream model rejected the request.',
        );
        assert.deepEqual(chunks[0].error.body, failedEvent.data);
    });

    it('surfaces response.incomplete and its reason as an error chunk', async () => {
        stubFetch(() => buildStreamResponse({
            events: [{
                event: 'response.incomplete',
                data: {
                    response: {
                        status: 'incomplete',
                        incomplete_details: { reason: 'max_output_tokens' },
                    },
                },
            }],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].type, 'error');
        assert.equal(chunks[0].error.code, 'OPENAI_RESPONSES_INCOMPLETE');
        assert.equal(
            chunks[0].error.message,
            'OpenAI Responses API response incomplete: Reason: max_output_tokens.',
        );
    });

    it('surfaces a stream that closes before response.completed as an error chunk', async () => {
        stubFetch(() => buildStreamResponse({
            events: [{ event: 'response.output_text.delta', data: { delta: 'Partial' } }],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.deepEqual(chunks.slice(0, 1), [{ type: 'text_delta', text: 'Partial' }]);
        assert.equal(chunks[1].type, 'error');
        assert.equal(chunks[1].error.code, 'OPENAI_RESPONSES_STREAM_INCOMPLETE');
        assert.equal(
            chunks[1].error.message,
            'OpenAI Responses API stream ended before response.completed.',
        );
        assert.equal(chunks.some((chunk) => chunk.type === 'done'), false);
    });
});

describe('openaiResponses.callLLMStreaming — chunk yield contract', () => {
    afterEach(restoreFetch);

    it('yields text_delta chunks for response.output_text.delta events', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                { event: 'response.output_text.delta', data: { delta: 'Hi' } },
                { event: 'response.output_text.delta', data: { delta: ' there' } },
                { event: 'response.completed', data: {} },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex', params: { instructions: 'be brief' } },
        ));

        const textDeltas = chunks.filter((c) => c.type === 'text_delta');
        assert.equal(textDeltas.length, 2);
        assert.equal(textDeltas[0].text, 'Hi');
        assert.equal(textDeltas[1].text, ' there');

        const done = chunks.find((c) => c.type === 'done');
        assert.ok(done);
        assert.equal(done.fullText, 'Hi there');
    });

    it('recovers finalized text from response.output_text.done when no deltas arrived', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                {
                    event: 'response.output_text.done',
                    data: { text: 'Final text from the completed content part' },
                },
                { event: 'response.completed', data: {} },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        const textDeltas = chunks.filter((chunk) => chunk.type === 'text_delta');
        assert.deepEqual(textDeltas, [
            { type: 'text_delta', text: 'Final text from the completed content part' },
        ]);
        assert.equal(
            chunks.find((chunk) => chunk.type === 'done').fullText,
            'Final text from the completed content part',
        );
    });

    it('recovers text from response.output_item.done when no deltas arrived', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                {
                    event: 'response.output_item.done',
                    data: {
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Text from the completed item' }],
                        },
                    },
                },
                { event: 'response.completed', data: {} },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text_delta'), [
            { type: 'text_delta', text: 'Text from the completed item' },
        ]);
        assert.equal(
            chunks.find((chunk) => chunk.type === 'done').fullText,
            'Text from the completed item',
        );
    });

    it('recovers text from the completed response output when no text events arrived', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                {
                    event: 'response.completed',
                    data: {
                        response: {
                            output: [{
                                type: 'message',
                                content: [{ type: 'output_text', text: 'Text from response.output' }],
                            }],
                        },
                    },
                },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text_delta'), [
            { type: 'text_delta', text: 'Text from response.output' },
        ]);
        assert.equal(
            chunks.find((chunk) => chunk.type === 'done').fullText,
            'Text from response.output',
        );
    });

    it('does not duplicate text already received through deltas', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                { event: 'response.output_text.delta', data: { delta: 'Hi' } },
                { event: 'response.output_text.delta', data: { delta: ' there' } },
                { event: 'response.output_text.done', data: { text: 'Hi there' } },
                {
                    event: 'response.completed',
                    data: {
                        response: {
                            output: [{
                                type: 'message',
                                content: [{ type: 'output_text', text: 'Hi there' }],
                            }],
                        },
                    },
                },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text_delta'), [
            { type: 'text_delta', text: 'Hi' },
            { type: 'text_delta', text: ' there' },
        ]);
        assert.equal(chunks.find((chunk) => chunk.type === 'done').fullText, 'Hi there');
    });

    it('emits only the missing suffix when the finalized text completes partial deltas', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                { event: 'response.output_text.delta', data: { delta: 'Partial' } },
                { event: 'response.output_text.done', data: { text: 'Partial response' } },
                { event: 'response.completed', data: {} },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'hi' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text_delta'), [
            { type: 'text_delta', text: 'Partial' },
            { type: 'text_delta', text: ' response' },
        ]);
        assert.equal(chunks.find((chunk) => chunk.type === 'done').fullText, 'Partial response');
    });

    it('streams function-call identity and argument deltas without duplicating finalized arguments', async () => {
        stubFetch(() => buildStreamResponse({
            events: [
                {
                    event: 'response.output_item.added',
                    data: {
                        output_index: 0,
                        item: {
                            id: 'fc_1',
                            type: 'function_call',
                            call_id: 'call_1',
                            name: 'exec_command',
                            arguments: '',
                        },
                    },
                },
                {
                    event: 'response.function_call_arguments.delta',
                    data: { item_id: 'fc_1', output_index: 0, delta: '{"cmd":' },
                },
                {
                    event: 'response.function_call_arguments.delta',
                    data: { item_id: 'fc_1', output_index: 0, delta: '"pwd"}' },
                },
                {
                    event: 'response.function_call_arguments.done',
                    data: {
                        item_id: 'fc_1',
                        output_index: 0,
                        name: 'exec_command',
                        arguments: '{"cmd":"pwd"}',
                    },
                },
                {
                    event: 'response.output_item.done',
                    data: {
                        output_index: 0,
                        item: {
                            id: 'fc_1',
                            type: 'function_call',
                            call_id: 'call_1',
                            name: 'exec_command',
                            arguments: '{"cmd":"pwd"}',
                        },
                    },
                },
                {
                    event: 'response.completed',
                    data: {
                        response: {
                            output: [{
                                id: 'fc_1',
                                type: 'function_call',
                                call_id: 'call_1',
                                name: 'exec_command',
                                arguments: '{"cmd":"pwd"}',
                            }],
                        },
                    },
                },
            ],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'Run pwd.' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://api.openai.com/v1' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool_calls_delta'), [
            {
                type: 'tool_calls_delta',
                toolCalls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'exec_command', arguments: '' },
                }],
            },
            {
                type: 'tool_calls_delta',
                toolCalls: [{
                    index: 0,
                    id: undefined,
                    type: 'function',
                    function: { name: undefined, arguments: '{"cmd":' },
                }],
            },
            {
                type: 'tool_calls_delta',
                toolCalls: [{
                    index: 0,
                    id: undefined,
                    type: 'function',
                    function: { name: undefined, arguments: '"pwd"}' },
                }],
            },
        ]);
        const done = chunks.find((chunk) => chunk.type === 'done');
        assert.equal(done.stopReason, 'tool_calls');
        assert.deepEqual(done.toolCalls, [{
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        }]);
    });

    it('recovers a completed-only function call when no argument deltas arrived', async () => {
        stubFetch(() => buildStreamResponse({
            events: [{
                event: 'response.completed',
                data: {
                    response: {
                        output: [{ type: 'message', content: [] }, {
                            id: 'fc_2',
                            type: 'function_call',
                            call_id: 'call_2',
                            name: 'read_file',
                            arguments: '{"path":"b.txt"}',
                        }],
                    },
                },
            }],
        }));

        const chunks = await drain(callLLMStreaming(
            [{ role: 'user', content: 'Read b.txt.' }],
            { model: 'gpt-5.4', apiKey: 'k', baseURL: 'https://api.openai.com/v1' },
        ));

        assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool_calls_delta'), [{
            type: 'tool_calls_delta',
            toolCalls: [{
                index: 1,
                id: 'call_2',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"b.txt"}' },
            }],
        }]);
    });
});

// ─── listModels tests ──────────────────────────────────────────────

function buildJsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('openaiResponses.listModels — URL resolution', () => {
    afterEach(restoreFetch);

    it('hits /v1/models on a bare api.openai.com base URL', async () => {
        stubFetch(() => buildJsonResponse({ data: [] }));
        await listModels({ baseURL: 'https://api.openai.com', apiKey: 'k' });
        assert.equal(fetchCalls[0].url, 'https://api.openai.com/v1/models');
    });

    it('appends /models when the base ends in /v1', async () => {
        stubFetch(() => buildJsonResponse({ data: [] }));
        await listModels({ baseURL: 'https://api.openai.com/v1', apiKey: 'k' });
        assert.equal(fetchCalls[0].url, 'https://api.openai.com/v1/models');
    });

    it('passes a URL that already ends in /models through unchanged', async () => {
        stubFetch(() => buildJsonResponse({ data: [] }));
        await listModels({ baseURL: 'https://example.test/custom/models', apiKey: 'k' });
        assert.equal(fetchCalls[0].url, 'https://example.test/custom/models');
    });

    it('hits /backend-api/codex/models with a high default client_version for ChatGPT Codex', async () => {
        stubFetch(() => buildJsonResponse({ models: [] }));
        await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'k',
        });
        // The default must be high enough to surface models with
        // minimal_client_version >= 0.98.0 (gpt-5.3-codex, gpt-5.4,
        // gpt-5.4-mini). 99.99.99 is the canonical future-proof value.
        assert.equal(fetchCalls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=99.99.99');
    });

    it('honours an explicit clientVersion override', async () => {
        stubFetch(() => buildJsonResponse({ models: [] }));
        await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'k',
            clientVersion: '0.30.0',
        });
        assert.equal(fetchCalls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.30.0');
    });

    it('URL-encodes the clientVersion value', async () => {
        stubFetch(() => buildJsonResponse({ models: [] }));
        await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'k',
            clientVersion: '1.0.0-beta+abc',
        });
        assert.equal(
            fetchCalls[0].url,
            'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0-beta%2Babc',
        );
    });
});

describe('openaiResponses.listModels — response normalization', () => {
    afterEach(restoreFetch);

    it('parses the Codex ChatGPT backend shape ({ models: [...] })', async () => {
        stubFetch(() => buildJsonResponse({
            models: [
                {
                    slug: 'gpt-5.2-codex',
                    display_name: 'gpt-5.2-codex',
                    description: 'Frontier coding model.',
                    context_window: 272000,
                    input_modalities: ['text', 'image'],
                    visibility: 'list',
                    supported_in_api: true,
                    priority: 8,
                },
                {
                    slug: 'gpt-5-codex',
                    display_name: 'gpt-5-codex',
                    context_window: 128000,
                    input_modalities: ['text'],
                    visibility: 'hide',
                    supported_in_api: true,
                },
                {
                    slug: 'legacy-model',
                    visibility: 'list',
                    supported_in_api: false,
                },
            ],
        }));

        const models = await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'k',
        });

        assert.equal(models.length, 2);
        assert.equal(models[0].modelId, 'gpt-5.2-codex');
        assert.equal(models[0].displayName, 'gpt-5.2-codex');
        assert.equal(models[0].description, 'Frontier coding model.');
        assert.equal(models[0].contextWindow, 272000);
        assert.equal(models[0].supportsVision, true);
        assert.equal(models[0].visibility, 'list');
        assert.equal(models[1].modelId, 'gpt-5-codex');
        assert.equal(models[1].supportsVision, false);
        assert.equal(models[1].visibility, 'hide');
    });

    it('includes ChatGPT-only Codex models when requested by an OAuth caller', async () => {
        stubFetch(() => buildJsonResponse({
            models: [
                {
                    slug: 'gpt-5.3-codex-spark',
                    display_name: 'GPT-5.3-Codex-Spark',
                    visibility: 'list',
                    supported_in_api: false,
                },
                {
                    slug: 'gpt-5.4',
                    visibility: 'list',
                    supported_in_api: true,
                },
            ],
        }));

        const models = await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'oauth-token',
            includeChatGPTOnly: true,
        });

        assert.deepEqual(models.map((model) => model.modelId), [
            'gpt-5.3-codex-spark',
            'gpt-5.4',
        ]);
        assert.equal(models[0].metadata.supportedInApi, false);
        assert.equal(models[1].metadata.supportedInApi, true);
    });

    it('parses the standard OpenAI models list ({ object: "list", data: [...] })', async () => {
        stubFetch(() => buildJsonResponse({
            object: 'list',
            data: [
                { id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' },
                { id: 'gpt-4o-mini', object: 'model', created: 0, owned_by: 'openai' },
            ],
        }));

        const models = await listModels({ baseURL: 'https://api.openai.com/v1', apiKey: 'k' });
        assert.equal(models.length, 2);
        assert.equal(models[0].modelId, 'gpt-4o');
        assert.equal(models[0].ownedBy, 'openai');
        assert.equal(models[1].modelId, 'gpt-4o-mini');
    });

    it('parses a bare array response for providers that skip the envelope', async () => {
        stubFetch(() => buildJsonResponse([
            { id: 'model-a' },
            { id: 'model-b' },
        ]));
        const models = await listModels({ baseURL: 'https://example.test/v1', apiKey: 'k' });
        assert.equal(models.length, 2);
        assert.equal(models[0].modelId, 'model-a');
    });

    it('drops entries without an id/slug', async () => {
        stubFetch(() => buildJsonResponse({
            data: [
                { id: 'keeper' },
                { description: 'no id here' },
                null,
                { id: 'also-keeper' },
            ],
        }));
        const models = await listModels({ baseURL: 'https://example.test/v1', apiKey: 'k' });
        assert.equal(models.length, 2);
        assert.equal(models[0].modelId, 'keeper');
        assert.equal(models[1].modelId, 'also-keeper');
    });
});

describe('openaiResponses.listModels — validation & errors', () => {
    afterEach(restoreFetch);

    it('requires an apiKey', async () => {
        await assert.rejects(
            () => listModels({ baseURL: 'https://api.openai.com/v1' }),
            /requires an API key/,
        );
    });

    it('requires a baseURL', async () => {
        await assert.rejects(
            () => listModels({ apiKey: 'k' }),
            /requires a baseURL/,
        );
    });

    it('throws an Error with .status and parsed .body on HTTP error', async () => {
        stubFetch(() => new Response(JSON.stringify({ detail: 'scope denied' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        }));

        let caught;
        try {
            await listModels({ baseURL: 'https://api.openai.com/v1', apiKey: 'k' });
        } catch (err) {
            caught = err;
        }
        assert.ok(caught);
        assert.equal(caught.status, 403);
        assert.equal(caught.message, 'openai.com Responses model-list request failed: 403 - Forbidden.');
        assert.doesNotMatch(caught.message, /scope denied/);
        assert.deepEqual(caught.body, { detail: 'scope denied' });
    });

    it('forwards custom headers (e.g. User-Agent) to the fetch call', async () => {
        stubFetch(() => buildJsonResponse({ data: [] }));
        await listModels({
            baseURL: 'https://chatgpt.com/backend-api/codex',
            apiKey: 'k',
            headers: { 'User-Agent': 'codex-cli/1.0.0' },
        });
        assert.equal(fetchCalls[0].init.headers['User-Agent'], 'codex-cli/1.0.0');
        assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer k');
    });
});
