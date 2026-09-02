import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GENERATED_LOCAL_FIXTURE_DIR = path.resolve(
    String(process.env.PLOINKY_TEST_ROUTER_FIXTURE_DIR || '').trim()
        || path.resolve(__dirname, '../../../../tests/fixtures/router-descriptor')
);

export const GENERATED_LOCAL_FIXTURE_HASHES = Object.freeze({
    'public-envelope.json': '7a968923defef58bfea1d3d9578c1858db0e676aa479160fc1fc36f00c079f15',
    'managed-envelope.json': '5ef19b1f1774b594efb998c9d9b296465867964db59c2982cd3a00711241dcdc',
    'streaming-enabled-envelope.json': '9903c3d269c73b7ad16360c15090299aa78d26115db99ffa7d1b94de8514187e',
});

export function fixturePath(filename = 'public-envelope.json') {
    return path.join(GENERATED_LOCAL_FIXTURE_DIR, filename);
}

export function fixtureBytes(filename = 'public-envelope.json') {
    return fs.readFileSync(fixturePath(filename));
}

export function fixtureEnvelope(filename = 'public-envelope.json') {
    return JSON.parse(fixtureBytes(filename).toString('utf8'));
}

export function fixtureSha256(filename = 'public-envelope.json') {
    return createHash('sha256').update(fixtureBytes(filename)).digest('hex');
}

export function fixtureEnvironment(filename = 'public-envelope.json', descriptorFile = fixturePath(filename)) {
    const env = JSON.parse(
        fs.readFileSync(fixturePath('public-environment.json'), 'utf8')
    );
    const { payload } = fixtureEnvelope(filename);
    Object.assign(env, {
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
    });
    return env;
}

export function installFixtureEnvironment(filename = 'public-envelope.json') {
    const env = fixtureEnvironment(filename);
    const previous = new Map();
    for (const [name, value] of Object.entries(env)) {
        previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
        process.env[name] = value;
    }
    return () => {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    };
}
