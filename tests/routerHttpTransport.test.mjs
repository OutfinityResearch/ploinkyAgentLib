import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';

import {
    fixtureEnvironment,
    fixturePath,
    installFixtureEnvironment,
} from './helpers/generatedLocalFixture.mjs';

const restoreFixtureEnvironment = installFixtureEnvironment();
test.after(restoreFixtureEnvironment);

const descriptorModule = await import('../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs');
const transport = await import('../utils/LLMProviders/transport/routerHttpTransport.mjs');
const { parseSSEStream } = await import('../utils/LLMProviders/providers/sseParser.mjs');
const verifiedDescriptor = descriptorModule.loadGeneratedLocalRouterDescriptor();

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

function captureHttpsRequestOptions(physicalOrigin, { stallHandshake = false } = {}) {
    const descriptorModuleURL = new URL(
        '../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        import.meta.url
    ).href;
    const transportModuleURL = new URL(
        '../utils/LLMProviders/transport/routerHttpTransport.mjs',
        import.meta.url
    ).href;
    const sourceFixture = fixturePath('public-envelope.json');
    const script = String.raw`
        import fs from 'node:fs';
        import { EventEmitter } from 'node:events';
        import os from 'node:os';
        import path from 'node:path';
        import {
            createHash,
            generateKeyPairSync,
            sign,
        } from 'node:crypto';

        const physicalOrigin = ${JSON.stringify(physicalOrigin)};
        const stallHandshake = ${JSON.stringify(stallHandshake)};
        const sourceFixture = ${JSON.stringify(sourceFixture)};
        const descriptorModuleURL = ${JSON.stringify(descriptorModuleURL)};
        const transportModuleURL = ${JSON.stringify(transportModuleURL)};
        const keyPair = generateKeyPairSync('ed25519');
        const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' })
            .subarray(-32)
            .toString('base64url');
        process.env.PLOINKY_AGENT_API_PUBLIC_KEY = publicKey;
        process.env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY = 'generated';

        const descriptorModule = await import(descriptorModuleURL);
        const source = JSON.parse(fs.readFileSync(sourceFixture, 'utf8'));
        const payload = structuredClone(source.payload);
        const parsedOrigin = new URL(physicalOrigin);
        payload.physicalOrigin = physicalOrigin;
        payload.routerHost = parsedOrigin.hostname;
        payload.routerPort = parsedOrigin.port || '443';
        const topology = {
            listenerClass: payload.listenerClass,
            localStreaming: payload.localStreaming,
            networkFingerprint: payload.networkFingerprint,
            physicalOrigin: payload.physicalOrigin,
            publicAuthority: payload.publicAuthority,
            requestAuthority: payload.requestAuthority,
            runtimeProof: payload.runtimeProof,
            socketLocalAddressClass: payload.socketLocalAddressClass,
            topology: payload.topology,
            transportVersion: payload.transportVersion,
        };
        payload.semanticTopologyDigest = 'sha256:' + createHash('sha256')
            .update(descriptorModule.canonicalJSONStringify(topology), 'utf8')
            .digest('hex');

        const payloadBytes = Buffer.from(
            descriptorModule.canonicalJSONStringify(payload),
            'utf8'
        );
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(payloadBytes.length));
        const signatureInput = Buffer.concat([
            Buffer.from('PLOINKY\0GENERATED_LOCAL_ROUTER_DESCRIPTOR\0V1\0', 'utf8'),
            length,
            payloadBytes,
        ]);
        const envelope = {
            payload,
            signature: sign(null, signatureInput, keyPair.privateKey).toString('base64url'),
        };
        const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlib-tls-descriptor-'));
        const descriptorFile = path.join(tempDirectory, 'router-descriptor.json');
        fs.writeFileSync(
            descriptorFile,
            descriptorModule.canonicalJSONStringify(envelope),
            { mode: 0o600 }
        );
        try {
            const mirrors = {
                PLOINKY_ROUTER_DESCRIPTOR_FILE: descriptorFile,
                PLOINKY_ROUTER_HOST: payload.routerHost,
                PLOINKY_ROUTER_PORT: payload.routerPort,
                PLOINKY_ROUTER_URL: payload.physicalOrigin,
                PLOINKY_ROUTER_REQUEST_AUTHORITY: payload.requestAuthority,
                PLOINKY_ROUTER_AUTHORITY: payload.publicAuthority,
                PLOINKY_INTERNAL_ROUTER_URL: payload.internalRouterUrl,
                PLOINKY_EDGE_TOPOLOGY_FILE: payload.edgeTopologyFile,
                PLOINKY_ROUTER_LISTENER_CLASS: payload.listenerClass,
                PLOINKY_ROUTER_ATTESTATION_ID: payload.attestationId,
                PLOINKY_ROUTER_TRANSPORT_VERSION: payload.transportVersion,
                PLOINKY_ROUTER_LOCAL_STREAMING: payload.localStreaming,
                PLOINKY_AGENT_ID: payload.agentPrincipal,
                PLOINKY_AGENT_PRINCIPAL: payload.agentPrincipal,
                PLOINKY_AGENT_INSTANCE_ID: payload.instanceId,
                PLOINKY_AGENT_ENABLE_GENERATION: payload.generationId,
                PLOINKY_AGENT_API_PUBLIC_KEY: publicKey,
                PLOINKY_AGENT_API_KEY: 'tls-test-bearer',
            };
            for (const [name, value] of Object.entries(mirrors)) {
                process.env[name] = value;
                process.env['PLOINKY_ENV_SOURCE_' + name] = 'generated';
            }
            const descriptor = descriptorModule.loadGeneratedLocalRouterDescriptor();
            const transport = await import(transportModuleURL);
            let captured;
            let transportErrorCode = null;
            transport.__setRouterRequestFactoryForTests((protocol, options) => {
                captured = { protocol, options };
                if (!stallHandshake) throw new Error('captured without dialing');
                const request = new EventEmitter();
                request.write = () => true;
                request.end = () => queueMicrotask(() => {
                    const socket = new EventEmitter();
                    socket.connecting = false;
                    socket.secureConnecting = true;
                    request.emit('socket', socket);
                    setTimeout(() => {}, 100);
                });
                request.destroy = () => {};
                return request;
            });
            try {
                await transport.routerHttpRequest({
                    descriptor,
                    pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
                    bearer: 'tls-test-bearer',
                    connectTimeoutMs: stallHandshake ? 30 : undefined,
                    headerTimeoutMs: stallHandshake ? 500 : undefined,
                    totalTimeoutMs: stallHandshake ? 1_000 : undefined,
                });
            } catch (error) {
                transportErrorCode = error?.code || null;
            }
            process.stdout.write(JSON.stringify({
                protocol: captured.protocol,
                hostname: captured.options.hostname,
                port: String(captured.options.port),
                servername: captured.options.servername ?? null,
                hasRejectUnauthorized: Object.hasOwn(captured.options, 'rejectUnauthorized'),
                ...(stallHandshake ? { transportErrorCode } : {}),
            }));
        } finally {
            fs.rmSync(tempDirectory, { recursive: true });
        }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
}

async function readRequestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

test('connects to the physical origin while sending the exact signed Host and canonical JSON', async (t) => {
    let observed;
    const server = await createServer(t, async (request, response) => {
        observed = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: await readRequestBody(request),
        };
        response.writeHead(200, {
            'Content-Type': 'application/json',
            'X-Multiple': ['one', 'two'],
            'Set-Cookie': ['a=1', 'b=2'],
        });
        response.end('{"ok":true}');
    });
    const captures = routeRequestsTo(server, t);

    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
        method: 'POST',
        json: { z: 1, a: 2 },
        bearer: 'signed-test-bearer',
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].protocol, 'http:');
    assert.equal(captures[0].options.hostname, 'host.containers.internal');
    assert.equal(captures[0].options.port, '8080');
    assert.equal(captures[0].options.path, descriptorModule.GENERATED_LOCAL_CHAT_PATH);
    assert.equal(captures[0].options.servername, undefined);
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, descriptorModule.GENERATED_LOCAL_CHAT_PATH);
    assert.equal(observed.headers.host, '127.0.0.1:18080');
    assert.equal(observed.headers.authorization, 'Bearer signed-test-bearer');
    assert.equal(observed.headers.accept, 'application/json');
    assert.equal(observed.headers.connection, 'close');
    assert.equal(observed.body, '{"a":2,"z":1}');
    assert.equal(response.headers['x-multiple'], 'one, two');
    assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
});

test('binds HTTPS verification and SNI to physical DNS while omitting SNI only for an IP literal', () => {
    const dns = captureHttpsRequestOptions('https://router.example.invalid:8443');
    assert.deepEqual(dns, {
        protocol: 'https:',
        hostname: 'router.example.invalid',
        port: '8443',
        servername: 'router.example.invalid',
        hasRejectUnauthorized: false,
    });

    const ip = captureHttpsRequestOptions('https://127.0.0.1:8443');
    assert.deepEqual(ip, {
        protocol: 'https:',
        hostname: '127.0.0.1',
        port: '8443',
        servername: null,
        hasRejectUnauthorized: false,
    });

    const stalledHandshake = captureHttpsRequestOptions(
        'https://router.example.invalid:8443',
        { stallHandshake: true }
    );
    assert.equal(stalledHandshake.transportErrorCode, 'PLOINKY_ROUTER_CONNECT_TIMEOUT');
});

test('supports exact credentialed model discovery without changing physical routing', async (t) => {
    let observed;
    const server = await createServer(t, (request, response) => {
        observed = { method: request.method, url: request.url, headers: request.headers };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"data":[]}');
    });
    const captures = routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bearer: 'model-discovery-bearer',
    });
    assert.deepEqual(await response.json(), { data: [] });
    assert.equal(captures[0].options.hostname, 'host.containers.internal');
    assert.equal(observed.method, 'GET');
    assert.equal(observed.url, descriptorModule.GENERATED_LOCAL_MODELS_PATH);
    assert.equal(observed.headers.host, '127.0.0.1:18080');
    assert.equal(observed.headers.authorization, 'Bearer model-discovery-bearer');
});

test('rejects protected, proxy, forwarding, and observation headers before socket construction', async (t) => {
    let socketAttempts = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        socketAttempts += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    const protectedNames = [
        'Host',
        'AUTHORIZATION',
        'Content-Type',
        'content-length',
        'Accept',
        'Connection',
        'Transfer-Encoding',
        'TE',
        'Upgrade',
        'Forwarded',
        'X-Forwarded-Anything',
        'Proxy-Authorization',
        'X-Real-IP',
        'X-Ploinky-Authority-Probe',
    ];
    for (const name of protectedNames) {
        await assert.rejects(
            transport.routerHttpRequest({
                descriptor: verifiedDescriptor,
                pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
                method: 'POST',
                headers: { [name]: 'attacker-controlled' },
            }),
            { code: 'PLOINKY_ROUTER_PROTECTED_HEADER' },
            name
        );
    }
    assert.equal(socketAttempts, 0);
});

test('binds method, path, and Accept semantics before socket construction', async (t) => {
    let socketAttempts = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        socketAttempts += 1;
        throw new Error('socket factory must not run');
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());

    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
            method: 'GET',
        }),
        { code: 'PLOINKY_ROUTER_METHOD_DENIED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            method: 'POST',
        }),
        { code: 'PLOINKY_ROUTER_METHOD_DENIED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            accept: 'text/event-stream',
        }),
        { code: 'PLOINKY_ROUTER_ACCEPT_DENIED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            connectHeaderTimeoutMs: 30,
            connectTimeoutMs: 30,
        }),
        /connectHeaderTimeoutMs cannot be combined/
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: '/services/httpServices/local-ready/v1/models',
        }),
        { code: 'PLOINKY_DESCRIPTOR_OPERATION_DENIED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        }),
        { code: 'PLOINKY_ROUTER_BEARER_REQUIRED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
            method: 'POST',
            bearer: 'required-body-key',
        }),
        { code: 'PLOINKY_ROUTER_REQUEST_BODY_REQUIRED' }
    );
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            bearer: 'no-get-body-key',
            json: {},
        }),
        { code: 'PLOINKY_ROUTER_REQUEST_BODY_DENIED' }
    );
    assert.equal(socketAttempts, 0);
});

test('rejects oversized JSON before dialing and oversized JSON responses during consumption', async (t) => {
    let socketAttempts = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        socketAttempts += 1;
        throw new Error('socket factory must not run');
    });
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
            method: 'POST',
            json: { content: 'x'.repeat(2 * 1024 * 1024) },
            bearer: 'oversize-request-bearer',
        }),
        { code: 'PLOINKY_ROUTER_REQUEST_TOO_LARGE' }
    );
    assert.equal(socketAttempts, 0);
    transport.__resetRouterRequestFactoryForTests();

    const server = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(`{"content":"${'x'.repeat(4 * 1024 * 1024)}"}`);
    });
    routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bearer: 'oversize-response-bearer',
    });
    await assert.rejects(response.json(), { code: 'PLOINKY_ROUTER_RESPONSE_TOO_LARGE' });
});

test('never follows or replays redirects', async (t) => {
    let requests = 0;
    const bearer = 'redirect-secret';
    const server = await createServer(t, (_request, response) => {
        requests += 1;
        response.writeHead(302, {
            Location: `https://alice:password@attacker.invalid/steal?token=${bearer}`,
            'Content-Type': 'text/plain',
            'X-Leaked-Identity': `${bearer} ${verifiedDescriptor.payload.agentPrincipal} ${verifiedDescriptor.descriptorFile}`,
        });
        response.end('do not replay');
    });
    routeRequestsTo(server, t);
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
            method: 'POST',
            json: { model: 'code' },
            bearer,
        }),
        (error) => error?.code === 'PLOINKY_ROUTER_REDIRECT_REJECTED'
            && error?.status === 302
            && error?.headers?.location.includes('[REDACTED]')
            && !JSON.stringify(error.headers).includes('alice')
            && !JSON.stringify(error.headers).includes('password')
            && !JSON.stringify(error.headers).includes(bearer)
            && !JSON.stringify(error.headers).includes(verifiedDescriptor.payload.agentPrincipal)
            && !JSON.stringify(error.headers).includes(verifiedDescriptor.descriptorFile)
    );
    assert.equal(requests, 1);
});

test('redacts credentials, signed identities, signatures, and descriptor paths from bounded errors', async (t) => {
    const bearer = 'super-secret-bearer';
    const server = await createServer(t, (_request, response) => {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end([
            `Bearer ${bearer}`,
            verifiedDescriptor.payload.agentPrincipal,
            verifiedDescriptor.signature,
            verifiedDescriptor.descriptorFile,
            'https://alice:password@attacker.invalid/path',
        ].join(' '));
    });
    routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
        method: 'POST',
        json: {},
        bearer,
    });
    const detail = await response.readErrorText();
    for (const secret of [
        bearer,
        verifiedDescriptor.payload.agentPrincipal,
        verifiedDescriptor.signature,
        verifiedDescriptor.descriptorFile,
        'alice',
        'password',
    ]) {
        assert.equal(detail.includes(secret), false, `error body leaked ${secret}`);
    }
    assert.match(detail, /\[REDACTED\]/);

    const constructionSecret = 'factory-construction-secret';
    transport.__setRouterRequestFactoryForTests(() => {
        throw new Error(`${constructionSecret} ${verifiedDescriptor.descriptorFile}`);
    });
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            bearer: constructionSecret,
        }),
        (error) => !String(error).includes(constructionSecret)
            && !String(error).includes(verifiedDescriptor.descriptorFile)
            && !String(error.cause || '').includes(constructionSecret)
            && !String(error.cause || '').includes(verifiedDescriptor.descriptorFile)
    );
});

test('enforces single response-body ownership', async (t) => {
    const server = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
    });
    routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bearer: 'single-owner-bearer',
    });
    assert.deepEqual(await response.json(), { ok: true });
    await assert.rejects(response.text(), { code: 'PLOINKY_ROUTER_BODY_ALREADY_CONSUMED' });
});

test('pre-abort prevents dialing and an abort while waiting for headers destroys the request', async (t) => {
    const preAborted = new AbortController();
    preAborted.abort();
    let socketAttempts = 0;
    transport.__setRouterRequestFactoryForTests(() => {
        socketAttempts += 1;
        throw new Error('socket factory must not run');
    });
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            signal: preAborted.signal,
        }),
        { name: 'AbortError', code: 'ABORT_ERR' }
    );
    assert.equal(socketAttempts, 0);
    transport.__resetRouterRequestFactoryForTests();

    let requestSeenResolve;
    const requestSeen = new Promise((resolve) => { requestSeenResolve = resolve; });
    const server = await createServer(t, () => requestSeenResolve());
    routeRequestsTo(server, t);
    const controller = new AbortController();
    const pending = transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        signal: controller.signal,
        bearer: 'abort-bearer',
        connectHeaderTimeoutMs: 5_000,
    });
    await requestSeen;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
});

test('bounds connect, response-header, body-idle, and total request time independently', async (t) => {
    const neverConnected = new EventEmitter();
    neverConnected.write = () => true;
    neverConnected.end = () => {};
    neverConnected.destroy = () => {};
    transport.__setRouterRequestFactoryForTests(() => neverConnected);
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            connectTimeoutMs: 30,
            headerTimeoutMs: 5_000,
            bearer: 'connect-timeout-bearer',
        }),
        { code: 'PLOINKY_ROUTER_CONNECT_TIMEOUT' }
    );
    transport.__resetRouterRequestFactoryForTests();

    const headerServer = await createServer(t, () => {});
    routeRequestsTo(headerServer, t);
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            connectTimeoutMs: 5_000,
            headerTimeoutMs: 30,
            bearer: 'header-timeout-bearer',
        }),
        { code: 'PLOINKY_ROUTER_HEADER_TIMEOUT' }
    );
    transport.__resetRouterRequestFactoryForTests();

    routeRequestsTo(headerServer, t);
    await assert.rejects(
        transport.routerHttpRequest({
            descriptor: verifiedDescriptor,
            pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
            connectHeaderTimeoutMs: 30,
            bearer: 'combined-timeout-compatibility-bearer',
        }),
        { code: 'PLOINKY_ROUTER_CONNECT_HEADER_TIMEOUT' }
    );
    transport.__resetRouterRequestFactoryForTests();

    const delayedHeaderServer = await createServer(t, (_request, response) => {
        setTimeout(() => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{"ok":true}');
        }, 75);
    });
    routeRequestsTo(delayedHeaderServer, t);
    const delayedResponse = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        connectTimeoutMs: 30,
        headerTimeoutMs: 500,
        totalTimeoutMs: 1_000,
        bearer: 'delayed-header-bearer',
    });
    assert.deepEqual(await delayedResponse.json(), { ok: true });
    transport.__resetRouterRequestFactoryForTests();

    const bodyServer = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"partial":');
    });
    routeRequestsTo(bodyServer, t);
    const idleResponse = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bodyIdleTimeoutMs: 30,
        totalTimeoutMs: 5_000,
        bearer: 'idle-timeout-bearer',
    });
    await assert.rejects(idleResponse.text(), { code: 'PLOINKY_ROUTER_BODY_IDLE_TIMEOUT' });
    transport.__resetRouterRequestFactoryForTests();

    const totalServer = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"partial":');
    });
    routeRequestsTo(totalServer, t);
    const totalResponse = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bodyIdleTimeoutMs: 5_000,
        totalTimeoutMs: 30,
        bearer: 'total-timeout-bearer',
    });
    await assert.rejects(totalResponse.text(), { code: 'PLOINKY_ROUTER_TOTAL_TIMEOUT' });
});

test('waits for upload drain before ending the request', async (t) => {
    let observedBody;
    const server = await createServer(t, async (request, response) => {
        observedBody = await readRequestBody(request);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
    });
    const { port } = server.address();
    let drainReleased = false;
    transport.__setRouterRequestFactoryForTests((_protocol, options, callback) => {
        const request = http.request({
            ...options,
            protocol: 'http:',
            hostname: '127.0.0.1',
            port,
        }, callback);
        const originalWrite = request.write.bind(request);
        const originalEmit = request.emit.bind(request);
        let releaseDrain = false;
        request.emit = (event, ...args) => {
            if (event === 'drain' && !releaseDrain) return false;
            return originalEmit(event, ...args);
        };
        request.write = (chunk) => {
            originalWrite(chunk);
            setTimeout(() => {
                drainReleased = true;
                releaseDrain = true;
                originalEmit('drain');
            }, 20);
            return false;
        };
        return request;
    });
    t.after(() => transport.__resetRouterRequestFactoryForTests());
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
        method: 'POST',
        json: { model: 'code' },
        bearer: 'drain-bearer',
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(drainReleased, true);
    assert.equal(observedBody, '{"model":"code"}');
});

test('incrementally parses bounded SSE metadata and destroys the source on cancellation', async (t) => {
    let serverSideClosedResolve;
    const serverSideClosed = new Promise((resolve) => { serverSideClosedResolve = resolve; });
    const server = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: token\nid: 7\nretry: 25\ndata: {"delta":"one"}\n\n');
        const interval = setInterval(() => {
            response.write('data: {"delta":"more"}\n\n');
        }, 10);
        response.once('close', () => {
            clearInterval(interval);
            serverSideClosedResolve();
        });
    });
    routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
        method: 'POST',
        json: { model: 'code', stream: true },
        accept: 'text/event-stream',
        bearer: 'sse-bearer',
    });
    const iterator = parseSSEStream(response.body)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.deepEqual(first.value, {
        event: 'token',
        data: '{"delta":"one"}',
        id: '7',
        retry: 25,
        parsedData: { delta: 'one' },
    });
    await iterator.return();
    await Promise.race([
        serverSideClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE source was not destroyed')), 1_000)),
    ]);
});

test('active raw SSE consumption resets the response body-idle timeout for every arriving chunk', async (t) => {
    const server = await createServer(t, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let sequence = 0;
        const interval = setInterval(() => {
            sequence += 1;
            response.write(`data: {"sequence":${sequence}}\n\n`);
            if (sequence === 8) {
                clearInterval(interval);
                response.end('data: [DONE]\n\n');
            }
        }, 10);
    });
    routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: verifiedDescriptor,
        pathname: descriptorModule.GENERATED_LOCAL_CHAT_PATH,
        method: 'POST',
        json: { model: 'code', stream: true },
        accept: 'text/event-stream',
        bearer: 'sse-idle-bearer',
        bodyIdleTimeoutMs: 35,
        totalTimeoutMs: 1_000,
    });
    const events = [];
    for await (const event of parseSSEStream(response.body)) events.push(event.parsedData);
    assert.deepEqual(events, Array.from({ length: 8 }, (_, index) => ({ sequence: index + 1 })));
});

test('SSE parser enforces line/event bounds and treats [DONE] as terminal', async () => {
    const { Readable } = await import('node:stream');
    const events = [];
    for await (const event of parseSSEStream(Readable.from([
        'data: {"one":1}\n\ndata: [DONE]\n\ndata: {"two":2}\n\n',
    ]))) {
        events.push(event);
    }
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].parsedData, { one: 1 });

    await assert.rejects(async () => {
        for await (const _event of parseSSEStream(
            Readable.from([`data: ${'x'.repeat(64)}\n\n`]),
            { maxLineBytes: 16, maxEventBytes: 32 }
        )) {
            void _event;
        }
    }, { code: 'PLOINKY_SSE_LINE_TOO_LARGE' });
});

test('managed descriptors retain the same physical DNS target with their signed managed Host', async (t) => {
    const managed = descriptorModule.loadGeneratedLocalRouterDescriptor({
        env: fixtureEnvironment('managed-envelope.json'),
    });
    let observedHost;
    const server = await createServer(t, (request, response) => {
        observedHost = request.headers.host;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"data":[]}');
    });
    const captures = routeRequestsTo(server, t);
    const response = await transport.routerHttpRequest({
        descriptor: managed,
        pathname: descriptorModule.GENERATED_LOCAL_MODELS_PATH,
        bearer: 'managed-models-bearer',
    });
    await response.json();
    assert.equal(captures[0].options.hostname, 'host.containers.internal');
    assert.equal(captures[0].options.port, '8080');
    assert.equal(observedHost, 'host.containers.internal:8080');
});
