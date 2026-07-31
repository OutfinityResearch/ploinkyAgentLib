import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    fixtureEnvironment,
    installFixtureEnvironment,
} from './helpers/generatedLocalFixture.mjs';

const restoreFixtureEnvironment = installFixtureEnvironment();
test.after(restoreFixtureEnvironment);

const descriptorModule = await import('../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs');
const transport = await import('../utils/LLMProviders/transport/routerHttpTransport.mjs');
const openai = await import('../utils/LLMProviders/providers/openai.mjs');
const { discoverModels } = await import('../utils/LLMProviders/providers/gatewayDiscovery.mjs');
const publicDescriptor = descriptorModule.loadGeneratedLocalRouterDescriptor();

async function createServer(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections?.();
        if (server.listening) {
            server.close();
            await once(server, 'close');
        }
    });
    return server;
}

function routeRequestsTo(server, t, captures = []) {
    const { port } = server.address();
    transport.__setRouterRequestFactoryForTests((protocol, options, callback) => {
        captures.push({ protocol, options: structuredClone(options) });
        return http.request({
            ...options,
            protocol: 'http:',
            hostname: '127.0.0.1',
            port,
            servername: undefined,
        }, callback);
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());
    return captures;
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

async function collect(iterable) {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
}

function withProcessEnvProxy(env, onGet, callback) {
    const original = process.env;
    process.env = new Proxy(env, {
        get(target, property, receiver) {
            onGet?.(property);
            return Reflect.get(target, property, receiver);
        },
    });
    return Promise.resolve()
        .then(callback)
        .finally(() => { process.env = original; });
}

test('non-streaming generated local uses authority transport, exact path, signed Host, and runtime bearer', async (t) => {
    let observed;
    const server = await createServer(t, async (request, response) => {
        observed = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: JSON.parse(await readBody(request)),
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            choices: [{ message: { content: 'authority-aware answer' } }],
        }));
    });
    const captures = routeRequestsTo(server, t);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('generated local must not use fetch');
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const result = await openai.callLLM(
        [{ role: 'user', content: 'hello' }],
        {
            model: 'code',
            params: { temperature: 0, stream: true },
            generatedLocalDescriptor: publicDescriptor,
        }
    );
    assert.equal(result, 'authority-aware answer');
    assert.equal(fetchCalls, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].options.hostname, 'host.containers.internal');
    assert.equal(captures[0].options.port, '8080');
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, descriptorModule.GENERATED_LOCAL_CHAT_PATH);
    assert.equal(observed.headers.host, '127.0.0.1:18080');
    assert.equal(observed.headers.authorization, `Bearer ${process.env.PLOINKY_AGENT_API_KEY}`);
    assert.equal(observed.body.model, 'code');
    assert.equal(observed.body.stream, false, 'params cannot upgrade a non-streaming local call');
    assert.equal(observed.body.temperature, 0);
});

test('generated-local model discovery uses the exact generic models operation and authority transport', async (t) => {
    let observed;
    const server = await createServer(t, (request, response) => {
        observed = { method: request.method, url: request.url, headers: request.headers };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            data: [{ id: 'gateway-code', _tags: ['coding'], _is_free: false }],
        }));
    });
    const captures = routeRequestsTo(server, t);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('generated discovery must not use fetch');
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const result = await discoverModels({
        providerKey: 'soul_gateway',
        generatedLocalDescriptor: publicDescriptor,
    });
    assert.equal(fetchCalls, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].options.hostname, 'host.containers.internal');
    assert.equal(observed.method, 'GET');
    assert.equal(observed.url, descriptorModule.GENERATED_LOCAL_MODELS_PATH);
    assert.equal(observed.headers.host, '127.0.0.1:18080');
    assert.equal(observed.headers.authorization, `Bearer ${process.env.PLOINKY_AGENT_API_KEY}`);
    assert.deepEqual(result.issues, { errors: [], warnings: [] });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].name, 'gateway-code');
    assert.deepEqual(result.models[0].tags, ['coding']);
});

test('default invoker reaches discovery and chat without converting trusted provider routing into an override', async (t) => {
    const isolatedStartDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-invoker-'));
    const previousStartDirectory = process.env.ACHILLES_ENV_START_DIR;
    process.env.ACHILLES_ENV_START_DIR = isolatedStartDirectory;
    t.after(() => {
        if (previousStartDirectory === undefined) delete process.env.ACHILLES_ENV_START_DIR;
        else process.env.ACHILLES_ENV_START_DIR = previousStartDirectory;
        fs.rmSync(isolatedStartDirectory, { recursive: true });
    });

    const protectedEnvironment = new Map();
    for (const name of Object.keys(process.env)) {
        if (
            ['SOUL_GATEWAY_API_KEY', 'SOUL_GATEWAY_BASE_URL', 'SOUL_GATEWAY_URL'].includes(name)
            || /^OPENAI_SOUL_GATEWAY_(?:URL|KEY|TOKEN|KEY_ENV)$/.test(name)
        ) {
            protectedEnvironment.set(name, process.env[name]);
            delete process.env[name];
        }
    }
    t.after(() => {
        for (const [name, value] of protectedEnvironment) process.env[name] = value;
    });

    const observed = [];
    const server = await createServer(t, async (request, response) => {
        observed.push({ method: request.method, url: request.url });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                data: [{ id: 'code', _tags: ['coding'], _is_free: false }],
            }));
            return;
        }
        await readBody(request);
        response.end(JSON.stringify({
            choices: [{ message: { content: 'default invoker answer' } }],
        }));
    });
    routeRequestsTo(server, t);

    const { defaultLLMInvokerStrategy } = await import('../utils/LLMClient.mjs');
    const result = await defaultLLMInvokerStrategy({
        prompt: 'ordinary prompt',
        model: 'soul_gateway/code',
    });

    assert.equal(result.output, 'default invoker answer');
    assert.deepEqual(observed, [
        { method: 'GET', url: descriptorModule.GENERATED_LOCAL_MODELS_PATH },
        { method: 'POST', url: descriptorModule.GENERATED_LOCAL_CHAT_PATH },
    ]);
});

test('protected direct-call and params overrides reject before generated key reads or sockets', async (t) => {
    let sockets = 0;
    let keyReads = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        sockets += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    await withProcessEnvProxy(fixtureEnvironment(), (property) => {
        if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
    }, async () => {
        for (const protectedName of [
            'baseURL',
            'apiKey',
            'apiKeyEnv',
            'transport',
            'headers',
            'providerKey',
        ]) {
            await assert.rejects(
                openai.callLLM([], {
                    model: 'code',
                    generatedLocalDescriptor: publicDescriptor,
                    [protectedName]: protectedName === 'headers' ? {} : 'same-or-attacker-value',
                }),
                { code: 'PLOINKY_GENERATED_LOCAL_OVERRIDE' },
                `direct ${protectedName}`
            );
            await assert.rejects(
                openai.callLLM([], {
                    model: 'code',
                    generatedLocalDescriptor: publicDescriptor,
                    params: {
                        [protectedName]: protectedName === 'headers' ? {} : 'same-or-attacker-value',
                    },
                }),
                { code: 'PLOINKY_GENERATED_LOCAL_OVERRIDE' },
                `params ${protectedName}`
            );
        }

        let protectedGetterReads = 0;
        const getterOptions = {
            model: 'code',
            generatedLocalDescriptor: publicDescriptor,
        };
        Object.defineProperty(getterOptions, 'apiKey', {
            enumerable: true,
            get() {
                protectedGetterReads += 1;
                return 'getter-controlled-key';
            },
        });
        await assert.rejects(
            openai.callLLM([], getterOptions),
            { code: 'PLOINKY_GENERATED_LOCAL_OVERRIDE' }
        );
        assert.equal(protectedGetterReads, 0);
    });
    assert.equal(keyReads, 0);
    assert.equal(sockets, 0);
});

test('disabled local streaming validates descriptor and capability before key or socket', async (t) => {
    let sockets = 0;
    let keyReads = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        sockets += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    await withProcessEnvProxy(fixtureEnvironment(), (property) => {
        if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
    }, async () => {
        const iterator = openai.callLLMStreaming([], {
            model: 'code',
            generatedLocalDescriptor: publicDescriptor,
        });
        await assert.rejects(
            iterator.next(),
            { code: 'PLOINKY_LOCAL_STREAMING_NOT_CERTIFIED' }
        );
    });
    assert.equal(keyReads, 0);
    assert.equal(sockets, 0);
});

test('unbranded descriptor-like objects fail closed without external fetch fallback', async (t) => {
    let sockets = 0;
    let fetchCalls = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        sockets += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('fetch must not run');
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    await assert.rejects(
        openai.callLLM([], {
            model: 'code',
            generatedLocalDescriptor: structuredClone(publicDescriptor),
        }),
        { code: 'PLOINKY_DESCRIPTOR_BRAND_INVALID' }
    );
    assert.equal(fetchCalls, 0);
    assert.equal(sockets, 0);
});

test('stale mirror state and missing key fail before socket construction', async (t) => {
    let sockets = 0;
    let keyReads = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        sockets += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    const stale = fixtureEnvironment();
    stale.PLOINKY_ROUTER_REQUEST_AUTHORITY = 'attacker.invalid:8080';
    await withProcessEnvProxy(stale, (property) => {
        if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
    }, async () => {
        await assert.rejects(
            openai.callLLM([], {
                model: 'code',
                generatedLocalDescriptor: publicDescriptor,
            }),
            { code: 'PLOINKY_DESCRIPTOR_MIRROR_MISMATCH' }
        );
    });
    assert.equal(keyReads, 0);
    assert.equal(sockets, 0);

    const emptyKey = fixtureEnvironment();
    emptyKey.PLOINKY_AGENT_API_KEY = '';
    await withProcessEnvProxy(emptyKey, (property) => {
        if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
    }, async () => {
        await assert.rejects(
            openai.callLLM([], {
                model: 'code',
                generatedLocalDescriptor: publicDescriptor,
            }),
            { code: 'PLOINKY_GENERATED_LOCAL_KEY_MISSING' }
        );
    });
    assert.equal(keyReads, 1);
    assert.equal(sockets, 0);
});

test('external OpenAI-compatible providers preserve fetch, URL, headers, and caller key behavior', async (t) => {
    const originalFetch = globalThis.fetch;
    let observed;
    globalThis.fetch = async (url, init) => {
        observed = { url: String(url), init };
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            async json() {
                return { choices: [{ message: { content: 'external answer' } }] };
            },
        };
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    let sockets = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        sockets += 1;
        throw new Error('authority transport must not run for external providers');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    const result = await openai.callLLM([], {
        model: 'external-model',
        baseURL: 'https://external.example/v1',
        apiKey: 'external-key',
        headers: { 'X-External': 'preserved' },
    });
    assert.equal(result, 'external answer');
    assert.equal(observed.url, 'https://external.example/v1/chat/completions');
    assert.equal(observed.init.headers.Authorization, 'Bearer external-key');
    assert.equal(observed.init.headers['X-External'], 'preserved');
    assert.equal(sockets, 0);
});

test('generated-local HTTP errors are bounded and redact credential material', async (t) => {
    const server = await createServer(t, (_request, response) => {
        response.writeHead(421, { 'Content-Type': 'text/plain' });
        response.end(`misdirected ${process.env.PLOINKY_AGENT_API_KEY} ${publicDescriptor.payload.agentPrincipal}`);
    });
    routeRequestsTo(server, t);
    let error;
    try {
        await openai.callLLM([], {
            model: 'code',
            generatedLocalDescriptor: publicDescriptor,
        });
    } catch (caught) {
        error = caught;
    }
    assert.equal(error?.status, 421);
    assert.equal(error?.message.includes(process.env.PLOINKY_AGENT_API_KEY), false);
    assert.equal(error?.message.includes(publicDescriptor.payload.agentPrincipal), false);
    assert.equal(error?.body.includes(process.env.PLOINKY_AGENT_API_KEY), false);
});

test('an enabled signed capability uses the same authority transport and bounded SSE parser', async (t) => {
    const streamingEnv = fixtureEnvironment('streaming-enabled-envelope.json');
    const streamingDescriptor = descriptorModule.loadGeneratedLocalRouterDescriptor({ env: streamingEnv });
    const originalEnv = process.env;
    process.env = { ...originalEnv, ...streamingEnv };
    t.after(() => { process.env = originalEnv; });

    let observed;
    const server = await createServer(t, async (request, response) => {
        observed = {
            headers: request.headers,
            body: JSON.parse(await readBody(request)),
        };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end([
            'data: {"choices":[{"delta":{"content":"hello"}}]}',
            '',
            'data: {"choices":[{"finish_reason":"stop","delta":{}}]}',
            '',
            'data: [DONE]',
            '',
            '',
        ].join('\n'));
    });
    const captures = routeRequestsTo(server, t);
    const chunks = await collect(openai.callLLMStreaming([], {
        model: 'code',
        params: { stream: false },
        generatedLocalDescriptor: streamingDescriptor,
    }));
    assert.equal(captures.length, 1);
    assert.equal(observed.headers.host, '127.0.0.1:18080');
    assert.equal(observed.headers.accept, 'text/event-stream');
    assert.equal(observed.body.stream, true, 'params cannot disable the streaming call');
    assert.deepEqual(chunks, [
        { type: 'text_delta', text: 'hello' },
        {
            type: 'done',
            fullText: 'hello',
            toolCalls: null,
            usage: null,
            stopReason: 'stop',
        },
    ]);
});
