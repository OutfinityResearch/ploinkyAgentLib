import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
    callSearch,
    extractSearchQuery,
} from '../utils/SearchProviders/search.mjs';
import {
    __setCallLLMWithModelForTests,
    __resetCallLLMWithModelForTests,
} from '../utils/LLMClient.mjs';
import { registerProvider, resetProviders } from '../utils/LLMProviders/providerRegistry.mjs';

// ── Test helpers ────────────────────────────────────────────────────

const fakeHandler = { callLLM: async () => 'mock response' };

function setupSoulGatewayProvider() {
    registerProvider({ key: 'soul_gateway', handler: fakeHandler });
}

// ── extractSearchQuery ──────────────────────────────────────────────

describe('extractSearchQuery', () => {
    it('extracts string content from last user message', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'first query' },
            { role: 'assistant', content: 'result' },
            { role: 'user', content: 'second query' },
        ];
        assert.equal(extractSearchQuery(messages), 'second query');
    });

    it('extracts text from multi-part content', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'x' } },
                    { type: 'text', text: 'describe this' },
                ],
            },
        ];
        assert.equal(extractSearchQuery(messages), 'describe this');
    });

    it('returns empty string for empty messages', () => {
        assert.equal(extractSearchQuery([]), '');
    });

    it('returns empty string for non-array input', () => {
        assert.equal(extractSearchQuery(null), '');
        assert.equal(extractSearchQuery(undefined), '');
    });

    it('returns empty string when no user message exists', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: 'hi' },
        ];
        assert.equal(extractSearchQuery(messages), '');
    });
});

// ── callSearch model resolution ─────────────────────────────────────

describe('callSearch model resolution', () => {
    let captured;

    beforeEach(() => {
        captured = null;
        setupSoulGatewayProvider();
        __setCallLLMWithModelForTests(async (modelName, history, prompt, opts) => {
            captured = { modelName, history, prompt, opts };
            return 'search result';
        });
    });

    afterEach(() => {
        __resetCallLLMWithModelForTests();
        resetProviders();
    });

    it('provider: "exa" delegates to model search-exa', async () => {
        await callSearch('test query', { provider: 'exa' });
        assert.equal(captured.modelName, 'soul_gateway/search-exa');
        assert.equal(captured.prompt, 'test query');
    });

    it('provider: "tavily" delegates to model search-tavily', async () => {
        await callSearch('test', { provider: 'tavily' });
        assert.equal(captured.modelName, 'soul_gateway/search-tavily');
    });

    it('provider: "brave" delegates to model search-brave', async () => {
        await callSearch('test', { provider: 'brave' });
        assert.equal(captured.modelName, 'soul_gateway/search-brave');
    });

    it('provider: "google-ai-mode" delegates to headless-google-ai-mode', async () => {
        await callSearch('test', { provider: 'google-ai-mode' });
        assert.equal(captured.modelName, 'soul_gateway/headless-google-ai-mode');
    });

    it('provider: "gemini-search" delegates to search-gemini', async () => {
        await callSearch('test', { provider: 'gemini-search' });
        assert.equal(captured.modelName, 'soul_gateway/search-gemini');
    });

    it('options.model overrides provider mapping', async () => {
        await callSearch('test', { model: 'custom-search-model' });
        assert.equal(captured.modelName, 'soul_gateway/custom-search-model');
    });

    it('options.model takes precedence over options.provider', async () => {
        await callSearch('test', { model: 'my-model', provider: 'exa' });
        assert.equal(captured.modelName, 'soul_gateway/my-model');
    });
});

// ── callSearch pass-through options ─────────────────────────────────

describe('callSearch pass-through options', () => {
    let captured;

    beforeEach(() => {
        captured = null;
        setupSoulGatewayProvider();
        __setCallLLMWithModelForTests(async (modelName, history, prompt, opts) => {
            captured = { modelName, history, prompt, opts };
            return 'ok';
        });
    });

    afterEach(() => {
        __resetCallLLMWithModelForTests();
        resetProviders();
    });

    it('passes apiKey through', async () => {
        await callSearch('q', { provider: 'exa', apiKey: 'sk-test' });
        assert.equal(captured.opts.apiKey, 'sk-test');
    });

    it('passes apiKeyEnv through', async () => {
        await callSearch('q', { provider: 'exa', apiKeyEnv: 'MY_KEY' });
        assert.equal(captured.opts.apiKeyEnv, 'MY_KEY');
    });

    it('passes baseURL through', async () => {
        await callSearch('q', { provider: 'exa', baseURL: 'https://my.gateway/v1' });
        assert.equal(captured.opts.baseURL, 'https://my.gateway/v1');
    });

    it('passes headers through', async () => {
        await callSearch('q', { provider: 'exa', headers: { 'X-Custom': 'val' } });
        assert.deepEqual(captured.opts.headers, { 'X-Custom': 'val' });
    });

    it('passes params through', async () => {
        await callSearch('q', { provider: 'exa', params: { max_results: 5 } });
        assert.deepEqual(captured.opts.params, { max_results: 5 });
    });

    it('passes signal through', async () => {
        const controller = new AbortController();
        await callSearch('q', { provider: 'exa', signal: controller.signal });
        assert.equal(captured.opts.signal, controller.signal);
    });

    it('uses a Soul Gateway model qualifier without an explicit providerKey by default', async () => {
        await callSearch('q', { provider: 'exa' });
        assert.equal(captured.modelName, 'soul_gateway/search-exa');
        assert.equal(Object.hasOwn(captured.opts, 'providerKey'), false);
    });

    it('uses an explicit external provider as a model qualifier, not an invocation override', async () => {
        registerProvider({ key: 'my_openai', handler: fakeHandler });
        await callSearch('q', { provider: 'exa', providerKey: 'my_openai' });
        assert.equal(captured.modelName, 'my_openai/search-exa');
        assert.equal(Object.hasOwn(captured.opts, 'providerKey'), false);
    });

    it('does not leak provider/model/providerKey as duplicate keys', async () => {
        await callSearch('q', { provider: 'exa' });
        assert.equal(captured.opts.provider, undefined);
    });
});

// ── callSearch with message arrays ──────────────────────────────────

describe('callSearch with message input', () => {
    let captured;

    beforeEach(() => {
        captured = null;
        setupSoulGatewayProvider();
        __setCallLLMWithModelForTests(async (modelName, history, prompt, opts) => {
            captured = { modelName, history, prompt, opts };
            return 'ok';
        });
    });

    afterEach(() => {
        __resetCallLLMWithModelForTests();
        resetProviders();
    });

    it('extracts query from message array', async () => {
        const messages = [
            { role: 'user', content: 'search this' },
        ];
        await callSearch(messages, { provider: 'brave' });
        assert.equal(captured.prompt, 'search this');
        assert.equal(captured.modelName, 'soul_gateway/search-brave');
    });
});

// ── callSearch error handling ───────────────────────────────────────

describe('callSearch error handling', () => {
    afterEach(() => {
        __resetCallLLMWithModelForTests();
        resetProviders();
    });

    it('throws when neither model nor provider is specified', async () => {
        setupSoulGatewayProvider();
        await assert.rejects(
            () => callSearch('test', {}),
            /callSearch requires options\.model or options\.provider/
        );
    });

    it('throws a clear error when soul_gateway provider is not registered', async () => {
        resetProviders();
        await assert.rejects(
            () => callSearch('test', { provider: 'exa' }),
            /SOUL_GATEWAY_API_KEY/
        );
    });

    it('throws a clear error when a custom providerKey is not registered', async () => {
        resetProviders();
        await assert.rejects(
            () => callSearch('test', { provider: 'exa', providerKey: 'my_gw' }),
            /not configured/
        );
    });
});

test('real generated-local callSearch composition uses a provider qualifier and preserves the wire model', () => {
    const packageRoot = path.resolve(import.meta.dirname, '..');
    const fixtureRoot = path.resolve(import.meta.dirname, '../../../tests/fixtures/router-descriptor');
    const fixtureEnv = JSON.parse(readFileSync(
        path.join(fixtureRoot, 'public-environment.json'),
        'utf8',
    ));
    fixtureEnv.PLOINKY_ROUTER_DESCRIPTOR_FILE = path.join(fixtureRoot, 'public-envelope.json');
    fixtureEnv.ACHILLES_ENV_START_DIR = '/';
    const transportModuleUrl = pathToFileURL(path.join(
        packageRoot,
        'utils/LLMProviders/transport/routerHttpTransport.mjs',
    )).href;
    const searchModuleUrl = pathToFileURL(path.join(packageRoot, 'utils/SearchProviders/search.mjs')).href;

    const childSource = `
        import assert from 'node:assert/strict';
        import http from 'node:http';
        import { once } from 'node:events';

        const requests = [];
        let wireBody = null;
        const server = http.createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            requests.push({ method: request.method, path: request.url });
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.method === 'GET') {
                response.end(JSON.stringify({ data: [{ id: 'catalogued-but-not-search' }] }));
                return;
            }
            wireBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            response.end(JSON.stringify({ choices: [{ message: { content: 'search-ok' } }] }));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = server.address().port;

        const transport = await import(${JSON.stringify(transportModuleUrl)});
        let socketFactoryCalls = 0;
        transport.__setRouterRequestFactoryForTests((_protocol, options, callback) => {
            socketFactoryCalls += 1;
            return http.request({ ...options, hostname: '127.0.0.1', port }, callback);
        });
        const search = await import(${JSON.stringify(searchModuleUrl)});
        const originalEnv = process.env;
        let invocationKeyReads = 0;
        process.env = new Proxy(originalEnv, {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') invocationKeyReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        try {
            const output = await search.callSearch('find opaque', {
                provider: 'exa',
                providerKey: 'soul_gateway',
            });
            assert.equal(output, 'search-ok');
            const countersBeforeOverride = { invocationKeyReads, socketFactoryCalls };
            await assert.rejects(
                search.callSearch('blocked', {
                    provider: 'exa',
                    providerKey: 'soul_gateway',
                    apiKey: 'caller-override',
                }),
                (error) => error?.code === 'PLOINKY_GENERATED_LOCAL_OVERRIDE',
            );
            assert.deepEqual(
                { invocationKeyReads, socketFactoryCalls },
                countersBeforeOverride,
            );
        } finally {
            process.env = originalEnv;
            transport.__resetRouterRequestFactoryForTests();
            server.close();
            await once(server, 'close');
        }
        process.stdout.write('RESULT:' + JSON.stringify({
            requests,
            wireModel: wireBody?.model,
            invocationKeyReads,
            socketFactoryCalls,
        }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
        cwd: packageRoot,
        env: fixtureEnv,
        encoding: 'utf8',
        timeout: 10_000,
    });

    assert.equal(child.status, 0, child.stderr || child.stdout);
    const marker = child.stdout.lastIndexOf('RESULT:');
    assert.notEqual(marker, -1, child.stdout);
    const result = JSON.parse(child.stdout.slice(marker + 'RESULT:'.length));
    assert.deepEqual(result.requests, [
        { method: 'GET', path: '/base-agent-additional-server/soul-gateway/7000/v1/models' },
        { method: 'POST', path: '/base-agent-additional-server/soul-gateway/7000/v1/chat/completions' },
    ]);
    assert.equal(result.wireModel, 'search-exa');
    assert.equal(result.invocationKeyReads, 1);
    assert.equal(result.socketFactoryCalls, 2);
});

// ── Static invariant: no vendor HTTP code ───────────────────────────

describe('static invariant: Achilles search helper', () => {
    const searchModulePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../utils/SearchProviders/search.mjs'
    );
    const source = readFileSync(searchModulePath, 'utf8');

    it('contains no vendor URLs', () => {
        const vendorUrls = [
            'api.tavily.com',
            'api.search.brave.com',
            'api.exa.ai',
            'google.serper.dev',
            's.jina.ai',
            'api.duckduckgo.com',
            'generativelanguage.googleapis.com',
            'searx.be',
        ];
        for (const url of vendorUrls) {
            assert.ok(!source.includes(url), `source must not contain ${url}`);
        }
    });

    it('contains no raw fetch() calls', () => {
        assert.doesNotMatch(source, /\bfetch\s*\(/);
    });

    it('contains no node:http or node:https imports', () => {
        assert.doesNotMatch(source, /from\s+['"]node:https?['"]/);
    });

    it('imports from LLMClient, not from vendor modules', () => {
        assert.match(source, /from\s+['"]\.\.\/LLMClient\.mjs['"]/);
    });
});
