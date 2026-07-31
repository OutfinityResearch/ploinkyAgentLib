import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
    GENERATED_LOCAL_FIXTURE_DIR,
    GENERATED_LOCAL_FIXTURE_HASHES,
    fixtureBytes,
    fixtureEnvelope,
    fixtureEnvironment,
    fixturePath,
    fixtureSha256,
    installFixtureEnvironment,
} from './helpers/generatedLocalFixture.mjs';

const restoreFixtureEnvironment = installFixtureEnvironment();
test.after(restoreFixtureEnvironment);

const descriptorModulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs'
);
const descriptorModuleURL = pathToFileURL(descriptorModulePath).href;
const descriptor = await import(descriptorModuleURL);

test('ordinary Ploinky identity alone does not claim generated-local authority', () => {
    const env = {
        PLOINKY_AGENT_ID: 'agent:repo/name',
        PLOINKY_AGENT_PRINCIPAL: 'agent:repo/name',
        PLOINKY_AGENT_INSTANCE_ID: 'instance-ordinary',
        PLOINKY_AGENT_ENABLE_GENERATION: 'generation-ordinary',
    };
    assert.equal(descriptor.hasGeneratedLocalDescriptorBundle(env), false);
    assert.equal(descriptor.loadGeneratedLocalRouterDescriptor({ env }), null);

    for (const signal of [
        { PLOINKY_ROUTER_HOST: '127.0.0.1' },
        { PLOINKY_AGENT_API_PUBLIC_KEY: 'untrusted' },
        { PLOINKY_AGENT_API_KEY: 'must-not-be-read' },
        { PLOINKY_ENV_SOURCE_PLOINKY_AGENT_ID: 'generated' },
    ]) {
        assert.equal(descriptor.hasGeneratedLocalDescriptorBundle({ ...env, ...signal }), true);
    }
});

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlib-router-descriptor-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function writeCanonicalEnvelope(t, envelope) {
    const filename = path.join(temporaryDirectory(t), 'descriptor.json');
    fs.writeFileSync(filename, descriptor.canonicalJSONStringify(envelope), { mode: 0o600 });
    return filename;
}

function errorCodeFromFreshProcess(env) {
    const probe = [
        `const module = await import(${JSON.stringify(descriptorModuleURL)});`,
        'try {',
        '  module.loadGeneratedLocalRouterDescriptor();',
        "  console.log('UNEXPECTED_SUCCESS');",
        '} catch (error) {',
        "  console.log(error.code || error.name || 'UNKNOWN_ERROR');",
        '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: path.dirname(descriptorModulePath),
        env,
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('frozen shared descriptor fixtures are exact canonical no-newline bytes', () => {
    const vectors = JSON.parse(fs.readFileSync(fixturePath('vectors.json'), 'utf8'));
    for (const [filename, expectedHash] of Object.entries(GENERATED_LOCAL_FIXTURE_HASHES)) {
        const bytes = fixtureBytes(filename);
        assert.equal(bytes.at(-1), 0x7d, `${filename} must end at the envelope closing brace`);
        assert.equal(bytes.includes(0x0a), false, `${filename} must contain no newline byte`);
        assert.equal(fixtureSha256(filename), expectedHash);
        assert.equal(vectors.files[filename], `sha256:${expectedHash}`);
        assert.equal(
            bytes.toString('utf8'),
            descriptor.canonicalJSONStringify(JSON.parse(bytes.toString('utf8')))
        );
    }
});

test('verifies and privately brands public, managed, and streaming capability vectors', () => {
    for (const filename of Object.keys(GENERATED_LOCAL_FIXTURE_HASHES)) {
        const verified = descriptor.loadGeneratedLocalRouterDescriptor({
            env: fixtureEnvironment(filename),
        });
        assert.equal(descriptor.isVerifiedGeneratedLocalRouterDescriptor(verified), true);
        assert.deepEqual(verified.payload, fixtureEnvelope(filename).payload);
        assert.equal(Object.isFrozen(verified), true);
        assert.equal(Object.isFrozen(verified.payload), true);
        assert.equal(verified.envelopeDigest, `sha256:${GENERATED_LOCAL_FIXTURE_HASHES[filename]}`);
    }
    assert.equal(descriptor.isVerifiedGeneratedLocalRouterDescriptor({}), false);
    assert.throws(
        () => descriptor.assertVerifiedGeneratedLocalRouterDescriptor({}),
        { code: 'PLOINKY_DESCRIPTOR_BRAND_INVALID' }
    );
});

test('constructs only the two exact certified operation URLs', () => {
    const verified = descriptor.loadGeneratedLocalRouterDescriptor();
    assert.equal(
        descriptor.buildGeneratedLocalOperationURL(
            verified,
            descriptor.GENERATED_LOCAL_CHAT_PATH
        ).href,
        'http://host.containers.internal:8080/base-agent-additional-server/soul-gateway/7000/v1/chat/completions'
    );
    assert.equal(
        descriptor.buildGeneratedLocalOperationURL(
            verified,
            descriptor.GENERATED_LOCAL_MODELS_PATH
        ).href,
        'http://host.containers.internal:8080/base-agent-additional-server/soul-gateway/7000/v1/models'
    );
    for (const pathname of [
        '/services/httpServices/local-ready/v1/models',
        '/base-agent-additional-server/soul-gateway/7000/v1/models?alternate=1',
        '//attacker.invalid/v1/models',
    ]) {
        assert.throws(
            () => descriptor.buildGeneratedLocalOperationURL(verified, pathname),
            { code: 'PLOINKY_DESCRIPTOR_OPERATION_DENIED' }
        );
    }
});

test('rejects every signed-envelope mutation vector without reading the API key', (t) => {
    const vectors = JSON.parse(fs.readFileSync(fixturePath('vectors.json'), 'utf8'));
    for (const mutation of vectors.invalidEnvelopeMutations) {
        const envelope = structuredClone(fixtureEnvelope());
        if (mutation.name === 'invalid-signature') {
            envelope.signature = mutation.value;
        } else if (mutation.deleteField) {
            delete envelope.payload[mutation.deleteField];
        } else {
            envelope.payload[mutation.field] = mutation.value;
        }
        const descriptorFile = writeCanonicalEnvelope(t, envelope);
        let keyReads = 0;
        const env = new Proxy(fixtureEnvironment('public-envelope.json', descriptorFile), {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        assert.throws(
            () => descriptor.loadGeneratedLocalRouterDescriptor({ env }),
            (error) => error?.code?.startsWith('PLOINKY_DESCRIPTOR_'),
            mutation.name
        );
        assert.equal(keyReads, 0, `${mutation.name} must not read the generated API key`);
    }
});

test('rejects noncanonical bytes, symlinks, source mismatches, and partial bundles before key access', (t) => {
    const directory = temporaryDirectory(t);
    const unavailable = path.join(directory, 'sensitive-descriptor-name.json');
    assert.throws(
        () => descriptor.loadGeneratedLocalRouterDescriptor({
            env: fixtureEnvironment('public-envelope.json', unavailable),
        }),
        (error) => error?.code === 'PLOINKY_DESCRIPTOR_FILE_UNREADABLE'
            && !String(error).includes(unavailable)
            && !String(error.cause || '').includes(unavailable)
    );

    const withNewline = path.join(directory, 'newline.json');
    fs.writeFileSync(withNewline, Buffer.concat([fixtureBytes(), Buffer.from('\n')]));
    assert.throws(
        () => descriptor.loadGeneratedLocalRouterDescriptor({
            env: fixtureEnvironment('public-envelope.json', withNewline),
        }),
        { code: 'PLOINKY_DESCRIPTOR_ENVELOPE_NONCANONICAL' }
    );

    const link = path.join(directory, 'descriptor-link.json');
    fs.symlinkSync(fixturePath(), link);
    assert.throws(
        () => descriptor.loadGeneratedLocalRouterDescriptor({
            env: fixtureEnvironment('public-envelope.json', link),
        }),
        { code: 'PLOINKY_DESCRIPTOR_FILE_INVALID' }
    );

    const oversized = path.join(directory, 'oversized.json');
    fs.writeFileSync(oversized, Buffer.alloc((64 * 1024) + 1, 0x20));
    assert.throws(
        () => descriptor.loadGeneratedLocalRouterDescriptor({
            env: fixtureEnvironment('public-envelope.json', oversized),
        }),
        { code: 'PLOINKY_DESCRIPTOR_FILE_INVALID' }
    );

    const growing = path.join(directory, 'growing.json');
    fs.copyFileSync(fixturePath(), growing);
    const growingEnvironment = fixtureEnvironment('public-envelope.json', growing);
    const originalReadSync = fs.readSync;
    let grewDuringRead = false;
    fs.readSync = (...args) => {
        if (!grewDuringRead) {
            grewDuringRead = true;
            fs.appendFileSync(growing, '\n');
        }
        return originalReadSync(...args);
    };
    try {
        assert.throws(
            () => descriptor.loadGeneratedLocalRouterDescriptor({
                env: growingEnvironment,
            }),
            { code: 'PLOINKY_DESCRIPTOR_FILE_INVALID' }
        );
    } finally {
        fs.readSync = originalReadSync;
    }

    const swapped = path.join(directory, 'swapped.json');
    const swapTarget = path.join(directory, 'swap-target.json');
    fs.copyFileSync(fixturePath(), swapped);
    fs.copyFileSync(fixturePath(), swapTarget);
    const originalOpenSync = fs.openSync;
    let swappedBeforeOpen = false;
    fs.openSync = (filename, ...args) => {
        if (!swappedBeforeOpen && filename === swapped) {
            swappedBeforeOpen = true;
            fs.unlinkSync(swapped);
            fs.symlinkSync(swapTarget, swapped);
        }
        return originalOpenSync(filename, ...args);
    };
    try {
        assert.throws(
            () => descriptor.loadGeneratedLocalRouterDescriptor({
                env: fixtureEnvironment('public-envelope.json', swapped),
            }),
            { code: 'PLOINKY_DESCRIPTOR_FILE_UNREADABLE' }
        );
    } finally {
        fs.openSync = originalOpenSync;
    }

    for (const mutate of [
        (env) => { env.PLOINKY_ROUTER_REQUEST_AUTHORITY = 'attacker.invalid:8080'; },
        (env) => { env.PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL = 'explicit'; },
        (env) => { delete env.PLOINKY_AGENT_INSTANCE_ID; },
        (env) => { delete env.PLOINKY_AGENT_API_KEY; },
    ]) {
        const base = fixtureEnvironment();
        mutate(base);
        let keyReads = 0;
        const env = new Proxy(base, {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        assert.throws(() => descriptor.loadGeneratedLocalRouterDescriptor({ env }));
        assert.equal(keyReads, 0);
    }

    let partialKeyReads = 0;
    const partial = new Proxy({
        PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
    }, {
        get(target, property, receiver) {
            if (property === 'PLOINKY_AGENT_API_KEY') partialKeyReads += 1;
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => descriptor.loadGeneratedLocalRouterDescriptor({ env: partial }),
        { code: 'PLOINKY_DESCRIPTOR_FILE_INVALID' }
    );
    assert.equal(partialKeyReads, 0);
});

test('captures the trust anchor before dotenv and rejects invalid fresh-process anchors', () => {
    const valid = fixtureEnvironment();
    const vectors = JSON.parse(fs.readFileSync(fixturePath('vectors.json'), 'utf8'));
    for (const publicKey of vectors.invalidPublicKeys) {
        const env = { ...process.env, ...valid, PLOINKY_AGENT_API_PUBLIC_KEY: publicKey };
        assert.match(
            errorCodeFromFreshProcess(env),
            /^PLOINKY_DESCRIPTOR_(?:BASE64URL_INVALID|MIRROR_MISMATCH|SIGNATURE_INVALID)$/
        );
    }
    assert.equal(errorCodeFromFreshProcess({
        ...process.env,
        ...valid,
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'explicit',
    }), 'PLOINKY_DESCRIPTOR_TRUST_ANCHOR_SOURCE_INVALID');
});

test('canonical JSON rejects values outside the frozen byte contract', () => {
    const sparse = [];
    sparse.length = 1;
    const accessor = {};
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => 'value' });
    const nonenumerable = {};
    Object.defineProperty(nonenumerable, 'hidden', { value: 1 });
    const symbolKey = { [Symbol('x')]: 1 };
    const extraArrayProperty = [1];
    extraArrayProperty.extra = true;
    const cyclic = {};
    cyclic.self = cyclic;

    for (const value of [
        Number.NaN,
        Infinity,
        1n,
        undefined,
        sparse,
        accessor,
        nonenumerable,
        symbolKey,
        extraArrayProperty,
        new Date(),
        cyclic,
    ]) {
        assert.throws(
            () => descriptor.canonicalJSONStringify(value),
            { code: 'PLOINKY_DESCRIPTOR_CANONICAL_JSON_INVALID' }
        );
    }
    assert.equal(descriptor.canonicalJSONStringify(-0), '0');
    assert.equal(descriptor.canonicalJSONStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('refresh fails closed when the signed artifact changes', (t) => {
    const directory = temporaryDirectory(t);
    const descriptorFile = path.join(directory, 'descriptor.json');
    fs.copyFileSync(fixturePath(), descriptorFile);
    const env = fixtureEnvironment('public-envelope.json', descriptorFile);
    const verified = descriptor.loadGeneratedLocalRouterDescriptor({ env });
    fs.appendFileSync(descriptorFile, '\n');
    assert.throws(
        () => descriptor.refreshGeneratedLocalRouterDescriptor(verified, { env }),
        { code: 'PLOINKY_DESCRIPTOR_ENVELOPE_NONCANONICAL' }
    );
});

test('fixture location is the shared producer-consumer source of truth', () => {
    assert.equal(
        GENERATED_LOCAL_FIXTURE_DIR,
        '/Users/danielsava/work/file-parser/ploinky/tests/fixtures/router-descriptor'
    );
});
