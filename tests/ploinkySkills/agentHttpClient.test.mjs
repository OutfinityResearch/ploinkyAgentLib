import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

import {
    createAgentHttpClient,
    getAgentCardsUrl,
    getAgentCardUrl,
    getAgentChatCompletionsUrl,
    getRouterUrl
} from '../../PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs';

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        });
    });
}

test('AgentHttpClient resolves router and agent endpoint URLs', () => {
    assert.equal(
        getRouterUrl({}),
        'http://127.0.0.1:8080'
    );
    assert.equal(
        getAgentChatCompletionsUrl('openaiAgent', { routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/openaiAgent/v1/chat/completions'
    );
    assert.equal(
        getAgentCardUrl('openaiAgent', { routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/openaiAgent/agent-card'
    );
    assert.equal(
        getAgentCardsUrl({ routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/agent-card'
    );
    assert.equal(
        getRouterUrl({
            PLOINKY_AGENT_ID: 'agent:repo/name',
            PLOINKY_AGENT_PRINCIPAL: 'agent:repo/name',
            PLOINKY_AGENT_INSTANCE_ID: 'ordinary-instance',
            PLOINKY_AGENT_ENABLE_GENERATION: 'ordinary-generation',
        }),
        'http://127.0.0.1:8080'
    );
});

test('AgentHttpClient rejects partial and future generated-local signals before URL selection', () => {
    for (const env of [
        { PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080' },
        { PLOINKY_ROUTER_HOST: 'host.containers.internal' },
        { PLOINKY_AGENT_API_KEY: 'must-not-be-used' },
        { PLOINKY_ENV_SOURCE_PLOINKY_FUTURE_ROUTER_FIELD: 'generated' },
    ]) {
        assert.throws(
            () => getRouterUrl(env),
            { code: 'PLOINKY_GENERATED_LOCAL_CONSUMER_NOT_CERTIFIED' }
        );
        assert.throws(
            () => getAgentCardUrl('openaiAgent', {
                routerUrl: 'https://explicit-external.example',
                env,
            }),
            { code: 'PLOINKY_GENERATED_LOCAL_CONSUMER_NOT_CERTIFIED' }
        );
    }
});

test('AgentHttpClient request-time safety gate performs zero key reads and zero socket creation', async (t) => {
    const target = {};
    let keyReads = 0;
    const env = new Proxy(target, {
        get(object, property, receiver) {
            if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
            return Reflect.get(object, property, receiver);
        },
    });
    const client = createAgentHttpClient({
        routerUrl: 'https://explicit-external.example',
        env,
    });

    target.PLOINKY_ROUTER_DESCRIPTOR_FILE = '/run/ploinky/router-descriptor.json';
    target.PLOINKY_AGENT_API_KEY = 'must-not-be-read';
    let socketAttempts = 0;
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;
    http.request = (...args) => {
        socketAttempts += 1;
        return originalHttpRequest(...args);
    };
    https.request = (...args) => {
        socketAttempts += 1;
        return originalHttpsRequest(...args);
    };
    t.after(() => {
        http.request = originalHttpRequest;
        https.request = originalHttpsRequest;
    });

    await assert.rejects(
        client.agentCard('openaiAgent'),
        { code: 'PLOINKY_GENERATED_LOCAL_CONSUMER_NOT_CERTIFIED' }
    );
    await assert.rejects(
        client.chatCompletions('openaiAgent', { model: 'demo' }),
        { code: 'PLOINKY_GENERATED_LOCAL_CONSUMER_NOT_CERTIFIED' }
    );
    await assert.rejects(
        client.chatCompletionsStream('openaiAgent', { model: 'demo' }).next(),
        { code: 'PLOINKY_GENERATED_LOCAL_CONSUMER_NOT_CERTIFIED' }
    );
    assert.equal(keyReads, 0);
    assert.equal(socketAttempts, 0);
});

test('AgentHttpClient calls router agent-card and chat completions endpoints', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
        seen.push({
            method: req.method,
            url: req.url,
            auth: req.headers['x-test-auth'] || ''
        });
        if (req.method === 'GET' && req.url === '/agent-card') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                agents: [{ name: 'openaiAgent', payload: { anyShape: { ok: true } } }],
                errors: []
            }));
            return;
        }
        if (req.method === 'GET' && req.url === '/openaiAgent/agent-card') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ agent: 'openaiAgent', 'agent-card': { tags: ['fast'] } }));
            return;
        }
        if (req.method === 'POST' && req.url === '/openaiAgent/v1/chat/completions') {
            const body = await readJsonBody(req);
            assert.equal(body.stream, false);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'echo:ping' } }]
            }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    await listen(server);
    try {
        const { port } = server.address();
        const client = createAgentHttpClient({
            routerUrl: `http://127.0.0.1:${port}`,
            requestHeaders: { 'x-test-auth': 'router-issued' }
        });
        const aggregate = await client.agentCard();
        assert.equal(aggregate.agents[0].name, 'openaiAgent');
        assert.deepEqual(aggregate.agents[0].payload.anyShape, { ok: true });

        const agentCard = await client.agentCard('openaiAgent');
        assert.deepEqual(agentCard['agent-card'].tags, ['fast']);

        const completion = await client.chatCompletions('openaiAgent', {
            model: 'demo',
            stream: false,
            messages: [{ role: 'user', content: 'ping' }]
        });
        assert.equal(completion.choices[0].message.content, 'echo:ping');
    } finally {
        await close(server);
    }

    assert.deepEqual(seen.map(entry => entry.url), [
        '/agent-card',
        '/openaiAgent/agent-card',
        '/openaiAgent/v1/chat/completions'
    ]);
    assert.ok(seen.every(entry => entry.auth === 'router-issued'));
});

test('AgentHttpClient streams chat completions SSE events through router endpoint', async () => {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/openaiAgent/v1/chat/completions') {
            res.writeHead(404);
            res.end();
            return;
        }
        const body = await readJsonBody(req);
        assert.equal(body.stream, true);
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache'
        });
        res.write(`data: ${JSON.stringify({
            object: 'chat.completion.chunk',
            choices: [{ delta: { content: 'echo:ping' } }]
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    await listen(server);
    const events = [];
    try {
        const { port } = server.address();
        const client = createAgentHttpClient({ routerUrl: `http://127.0.0.1:${port}` });
        for await (const event of client.chatCompletionsStream('openaiAgent', {
            model: 'demo',
            messages: [{ role: 'user', content: 'ping' }]
        })) {
            events.push(event);
        }
    } finally {
        await close(server);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].done, false);
    assert.equal(events[0].json.object, 'chat.completion.chunk');
    assert.equal(events[0].json.choices[0].delta.content, 'echo:ping');
    assert.equal(events[1].done, true);
});
