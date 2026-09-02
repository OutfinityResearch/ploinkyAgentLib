import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixturePath } from './helpers/generatedLocalFixture.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRECTORIES = new Set([
    '.git',
    '.tmp',
    'build',
    'coverage',
    'dist',
    'docs',
    'fixtures',
    'node_modules',
    'tests',
]);
const EXECUTABLE_EXTENSIONS = new Set([
    '.bash', '.cjs', '.cts', '.js', '.json', '.jsonc', '.jsx', '.mjs',
    '.mts', '.py', '.sh', '.toml', '.ts', '.tsx', '.yaml', '.yml', '.zsh',
]);
const GENERATED_REFERENCE_PATTERN = /PLOINKY_ENV_SOURCE_PLOINKY_[A-Z0-9_]*|PLOINKY_AGENT_API_KEY/g;
const DYNAMIC_ENV_ACCESS_PATTERN = /(?:process\.env|\benv)\s*\[[^\]]+\]/;
const DIRECT_ROUTER_SIGNAL_PATTERN = /\b(?:PLOINKY_(?:ROUTER_[A-Z0-9_]+|INTERNAL_ROUTER_URL|EDGE_TOPOLOGY_FILE|AGENT_(?:ID|PRINCIPAL|INSTANCE_ID|ENABLE_GENERATION|API_PUBLIC_KEY|API_KEY)|ENV_SOURCE_PLOINKY_[A-Z0-9_]+)|hasGeneratedLocalDescriptorBundle|GENERATED_LOCAL_(?:CHAT|MODELS)_PATH|routerHttpRequest)\b/;

const DYNAMIC_ENV_ACCESS_DISPOSITIONS = Object.freeze({
    'LLMAgents/index.mjs': 'Reads only externally described fast/deep model environment names; generated-local records do not expose those arrays.',
    'evalsSuite/streaming/evalStreamingIntegration.mjs': 'Standalone explicit-external streaming evaluation reads user-selected environment names and is not a generated-local Router consumer.',
    'utils/LLMClient.mjs': 'Dynamic provider credentials are read only on external-provider branches after the private generated-local brand has short-circuited selection or invocation.',
    'utils/LLMProviders/providers/envConfigLoader.mjs': 'Loads explicit external configuration; generated source markers and generated credential aliases are rejected before these dynamic accesses.',
    'utils/LLMProviders/providers/gatewayDiscovery.mjs': 'Dynamic credential lookup is confined to the explicit-external discovery branch after the branded generated-local branch returns.',
    'utils/LLMProviders/providers/modelsConfigLoader.mjs': 'Dynamic discovery gating short-circuits privately branded generated-local providers before reading external provider credential names.',
    'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs': 'Mirror validation reads public generated metadata; credential availability explicitly rejects the generated credential name before its dynamic external lookup.',
});

const DIRECT_ROUTER_SIGNAL_DISPOSITIONS = Object.freeze({
    'PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs': 'Unsupported generated-local consumer: fail-closed bundle detection executes before URL selection, credential reads, or native socket creation.',
    'utils/LLMProviders/providers/envConfigLoader.mjs': 'Generated-local configuration boundary: detects the bundle and delegates descriptor loading rather than constructing Router requests.',
    'utils/LLMProviders/providers/gatewayDiscovery.mjs': 'Certified generated-local models consumer: validates the private brand, refreshed descriptor, and exact models operation before key access and authority transport.',
    'utils/LLMProviders/providers/modelsConfigLoader.mjs': 'Generated-local configuration boundary: detects the bundle and attaches only the privately branded descriptor to Soul Gateway.',
    'utils/LLMProviders/providers/openai.mjs': 'Certified generated-local chat consumer: validates protected overrides, private brand, refreshed descriptor, and exact chat operation before key access and authority transport.',
    'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs': 'Certified descriptor verifier and mirror validator; Router host/url names are validation inputs, never caller-selected request targets.',
    'utils/LLMProviders/transport/routerHttpTransport.mjs': 'Certified authority-aware socket boundary: connects only to the verified physical origin while binding the signed request authority and exact operation.',
});

const CLASSIFIED_REFERENCES = [
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "const GENERATED_LOCAL_CREDENTIAL_NAME = 'PLOINKY_AGENT_API_KEY';",
        rationale: 'Names the credential solely so unbranded dynamic readers can reject it without accessing its value.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "'PLOINKY_AGENT_API_KEY',",
        rationale: 'Declares the credential name as a reserved runtime mirror; it does not read the value.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY',
        line: 'const capturedTrustAnchorSource = process.env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY;',
        rationale: 'Captures the public trust-anchor source marker before dotenv processing.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_ENV_SOURCE_PLOINKY_',
        line: "|| normalized.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_');",
        rationale: 'Rejects every current or future generated source marker during dotenv parsing.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_ENV_SOURCE_PLOINKY_',
        line: "if (name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_')) return true;",
        rationale: 'Treats every current or future generated source marker as a fail-closed bundle signal.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY',
        line: "if (String(env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY ?? '') !== 'generated') {",
        rationale: 'Validates the credential provenance marker without reading the credential value.',
    },
    {
        file: 'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "if (!Object.hasOwn(env, 'PLOINKY_AGENT_API_KEY')) {",
        rationale: 'Validates credential presence without invoking its value getter.',
    },
    {
        file: 'utils/LLMProviders/providers/envConfigLoader.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "&& (data.apiKeyEnv === 'PLOINKY_AGENT_API_KEY'",
        rationale: 'Rejects an environment-defined provider that aliases the generated credential.',
    },
    {
        file: 'utils/LLMProviders/providers/envConfigLoader.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "apiKeyEnv: 'PLOINKY_AGENT_API_KEY',",
        rationale: 'Records credential metadata only on the private-brand generated provider; no value is read.',
    },
    {
        file: 'utils/LLMProviders/providers/modelsConfigLoader.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "&& (config.apiKeyEnv === 'PLOINKY_AGENT_API_KEY'",
        rationale: 'Rejects JSON provider aliases to the generated credential.',
    },
    {
        file: 'utils/LLMProviders/providers/modelsConfigLoader.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: "&& (apiKeyEnvOverride === 'PLOINKY_AGENT_API_KEY'",
        rationale: 'Rejects JSON model aliases to the generated credential.',
    },
    {
        file: 'utils/LLMProviders/providers/gatewayDiscovery.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: 'const apiKey = process.env.PLOINKY_AGENT_API_KEY;',
        rationale: 'Certified model-discovery read after brand, descriptor refresh, mirrors, and exact path validation.',
    },
    {
        file: 'utils/LLMProviders/providers/openai.mjs',
        token: 'PLOINKY_AGENT_API_KEY',
        line: 'const apiKey = process.env.PLOINKY_AGENT_API_KEY;',
        rationale: 'Certified invocation read reached only after request-time descriptor and override validation.',
    },
];

function referenceKey({ file, token, line }) {
    return `${file}\0${token}\0${line}`;
}

function collectExecutableFiles(directory, relative = '') {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const childRelative = relative ? path.join(relative, entry.name) : entry.name;
        const childAbsolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
                files.push(...collectExecutableFiles(childAbsolute, childRelative));
            }
            continue;
        }
        if (!entry.isFile()) continue;
        const stats = fs.statSync(childAbsolute);
        if (EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
            || (stats.mode & 0o111) !== 0) {
            files.push(childRelative.split(path.sep).join('/'));
        }
    }
    return files.sort();
}

function collectGeneratedReferences() {
    const references = [];
    for (const file of collectExecutableFiles(PACKAGE_ROOT)) {
        const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
        for (const rawLine of source.split(/\r?\n/)) {
            const line = rawLine.trim();
            for (const match of line.matchAll(GENERATED_REFERENCE_PATTERN)) {
                references.push({ file, token: match[0], line });
            }
        }
    }
    return references;
}

function collectExecutableFilesMatching(pattern) {
    return collectExecutableFiles(PACKAGE_ROOT).filter((file) => {
        const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
        return pattern.test(source);
    });
}

test('every executable generated-credential/source-marker reference is explicitly classified', () => {
    for (const entry of CLASSIFIED_REFERENCES) {
        assert.ok(entry.rationale.length > 20, `Missing rationale for ${entry.file}: ${entry.line}`);
    }
    const actual = collectGeneratedReferences().map(referenceKey).sort();
    const expected = CLASSIFIED_REFERENCES.map(referenceKey).sort();
    assert.deepEqual(actual, expected);
});

test('every executable dynamic environment access has an explicit generated-local disposition', () => {
    for (const rationale of Object.values(DYNAMIC_ENV_ACCESS_DISPOSITIONS)) {
        assert.ok(rationale.length > 20);
    }
    assert.deepEqual(
        collectExecutableFilesMatching(DYNAMIC_ENV_ACCESS_PATTERN),
        Object.keys(DYNAMIC_ENV_ACCESS_DISPOSITIONS).sort(),
    );
});

test('every executable direct Router signal consumer has an explicit disposition', () => {
    for (const rationale of Object.values(DIRECT_ROUTER_SIGNAL_DISPOSITIONS)) {
        assert.ok(rationale.length > 20);
    }
    assert.deepEqual(
        collectExecutableFilesMatching(DIRECT_ROUTER_SIGNAL_PATTERN),
        Object.keys(DIRECT_ROUTER_SIGNAL_DISPOSITIONS).sort(),
    );
});

test('only the two certified request paths read the generated credential value', () => {
    const valueReads = collectGeneratedReferences()
        .filter(({ line }) => line.includes('process.env.PLOINKY_AGENT_API_KEY'))
        .map(({ file }) => file)
        .sort();
    assert.deepEqual(valueReads, [
        'utils/LLMProviders/providers/gatewayDiscovery.mjs',
        'utils/LLMProviders/providers/openai.mjs',
    ]);
});

test('certified value reads remain ordered after brand, refresh, operation, and override validation', () => {
    const discovery = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'utils/LLMProviders/providers/gatewayDiscovery.mjs'),
        'utf8'
    );
    const discoveryBranch = discovery.slice(
        discovery.indexOf('if (isVerifiedGeneratedLocalRouterDescriptor'),
        discovery.indexOf('\n    if (!baseURL)')
    );
    assert.ok(discoveryBranch.indexOf('refreshGeneratedLocalRouterDescriptor')
        < discoveryBranch.indexOf('buildGeneratedLocalOperationURL'));
    assert.ok(discoveryBranch.indexOf('buildGeneratedLocalOperationURL')
        < discoveryBranch.indexOf('process.env.PLOINKY_AGENT_API_KEY'));

    const openai = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'utils/LLMProviders/providers/openai.mjs'),
        'utf8'
    );
    assert.doesNotMatch(openai, /export\s+(?:async\s+)?function\s+readGeneratedLocalCredential/);
    for (const [startMarker, endMarker] of [
        ['export async function callLLM(', '/**\n * Streaming variant'],
        ['export async function* callLLMStreaming(', null],
    ]) {
        const start = openai.indexOf(startMarker);
        const end = endMarker ? openai.indexOf(endMarker, start) : openai.length;
        const body = openai.slice(start, end);
        assert.ok(body.indexOf('validateGeneratedLocalRequest(options')
            < body.indexOf('readGeneratedLocalCredential(generatedLocalDescriptor)'));
    }
});

test('benchmark selectors use the centralized private-brand availability check and never dynamically read credentials', () => {
    for (const file of [
        'evalsSuite/modelBenchmark/evalFastModelsBenchmark.mjs',
        'evalsSuite/modelBenchmark/evalDeepModelsBenchmark.mjs',
        'evalsSuite/modelBenchmark/evalCodeGenBenchmark.mjs',
        'evalsSuite/modelBenchmark/evalTskillCodeGenBenchmark.mjs',
    ]) {
        const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
        assert.match(source, /getProviderCredentialAvailability\(/);
        assert.doesNotMatch(source, /process\.env\s*\[/);
        assert.doesNotMatch(source, /PLOINKY_AGENT_API_KEY|PLOINKY_ENV_SOURCE_PLOINKY_/);
    }
});

test('showActiveModels reports branded availability without a dynamic credential read', () => {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'showActiveModels.mjs'), 'utf8');
    assert.match(source, /getProviderCredentialAvailability\(/);
    assert.doesNotMatch(source, /process\.env\s*\[/);
    assert.doesNotMatch(source, /PLOINKY_AGENT_API_KEY|PLOINKY_ENV_SOURCE_PLOINKY_/);
});

test('private-brand availability performs zero generated credential getter calls', () => {
    const fixtureEnv = JSON.parse(fs.readFileSync(
        fixturePath('public-environment.json'),
        'utf8',
    ));
    fixtureEnv.PLOINKY_ROUTER_DESCRIPTOR_FILE = fixturePath();
    const descriptorModuleUrl = pathToFileURL(path.join(
        PACKAGE_ROOT,
        'utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs',
    )).href;
    const probe = `
        import assert from 'node:assert/strict';
        const api = await import(${JSON.stringify(descriptorModuleUrl)});
        const descriptor = api.loadGeneratedLocalRouterDescriptor({ env: process.env });
        let generatedReads = 0;
        let externalReads = 0;
        const env = new Proxy({ EXTERNAL_KEY: 'present' }, {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') generatedReads += 1;
                if (property === 'EXTERNAL_KEY') externalReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        assert.equal(api.getProviderCredentialAvailability(
            { generatedLocalDescriptor: descriptor },
            'PLOINKY_AGENT_API_KEY',
            env,
        ), 'generated-local');
        assert.equal(api.getProviderCredentialAvailability(
            {},
            'PLOINKY_AGENT_API_KEY',
            env,
        ), 'missing');
        assert.equal(api.getProviderCredentialAvailability({}, 'EXTERNAL_KEY', env), 'available');
        process.stdout.write(JSON.stringify({ generatedReads, externalReads }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: PACKAGE_ROOT,
        env: fixtureEnv,
        encoding: 'utf8',
        timeout: 5_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), { generatedReads: 0, externalReads: 1 });
});

test('showActiveModels performs only certified discovery key reads and no diagnostic read', () => {
    const fixtureEnv = JSON.parse(fs.readFileSync(
        fixturePath('public-environment.json'),
        'utf8',
    ));
    fixtureEnv.PLOINKY_ROUTER_DESCRIPTOR_FILE = fixturePath();
    fixtureEnv.ACHILLES_ENV_START_DIR = '/';
    const transportModuleUrl = pathToFileURL(path.join(
        PACKAGE_ROOT,
        'utils/LLMProviders/transport/routerHttpTransport.mjs',
    )).href;
    const showActiveModuleUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'showActiveModels.mjs')).href;
    const probe = `
        import http from 'node:http';
        import { once } from 'node:events';
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: [{ id: 'generated-diagnostic-model' }] }));
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
        const originalEnv = process.env;
        let generatedKeyReads = 0;
        let diagnosticKeyReads = 0;
        process.env = new Proxy(originalEnv, {
            get(target, property, receiver) {
                if (property === 'PLOINKY_AGENT_API_KEY') {
                    generatedKeyReads += 1;
                    if ((new Error().stack || '').includes('at printSection')) diagnosticKeyReads += 1;
                }
                return Reflect.get(target, property, receiver);
            },
        });
        try {
            await import(${JSON.stringify(showActiveModuleUrl)});
        } finally {
            process.env = originalEnv;
            transport.__resetRouterRequestFactoryForTests();
            server.close();
            await once(server, 'close');
        }
        process.stdout.write('RESULT:' + JSON.stringify({
            generatedKeyReads,
            diagnosticKeyReads,
            socketFactoryCalls,
        }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: PACKAGE_ROOT,
        env: fixtureEnv,
        encoding: 'utf8',
        timeout: 5_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /GENERATED/);
    const marker = child.stdout.lastIndexOf('RESULT:');
    assert.notEqual(marker, -1, child.stdout);
    assert.deepEqual(
        JSON.parse(child.stdout.slice(marker + 'RESULT:'.length)),
        { generatedKeyReads: 2, diagnosticKeyReads: 0, socketFactoryCalls: 2 },
    );
});
