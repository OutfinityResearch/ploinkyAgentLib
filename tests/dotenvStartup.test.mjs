import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fixturePath } from './helpers/generatedLocalFixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loaderURL = pathToFileURL(
    path.resolve(__dirname, '../utils/LLMProviders/providers/modelsConfigLoader.mjs')
).href;

function temporaryRoot(t, prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('rejects every reserved dotenv/source ordering as a whole file before mutation', (t) => {
    const vectors = JSON.parse(
        fs.readFileSync(fixturePath('invalid-source-vectors.json'), 'utf8')
    );

    for (const vector of vectors.cases) {
        const tempRoot = temporaryRoot(t, `achilles-dotenv-${vector.name}-`);
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const selectedDir = path.join(workspaceRoot, 'nested', 'project');
        fs.mkdirSync(selectedDir, { recursive: true });
        const entries = [
            ['SAFE_BEFORE', `${vector.name}-before`],
            ...vector.entries,
            ['SAFE_AFTER', `${vector.name}-after`],
        ];
        fs.writeFileSync(
            path.join(workspaceRoot, '.env'),
            `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`
        );

        const probe = [
            'let code = null;',
            'let rejectedKey = null;',
            'try {',
            `  await import(${JSON.stringify(loaderURL)});`,
            '} catch (error) {',
            '  code = error.code || error.name;',
            '  rejectedKey = error.key || null;',
            '}',
            'console.log(JSON.stringify({',
            '  code,',
            '  rejectedKey,',
            '  safeBefore: process.env.SAFE_BEFORE || null,',
            '  safeAfter: process.env.SAFE_AFTER || null,',
            '}));',
        ].join('\n');
        const probePath = path.join(tempRoot, 'probe.mjs');
        fs.writeFileSync(probePath, probe);
        const result = spawnSync(process.execPath, [probePath, '--dir', selectedDir], {
            cwd: tempRoot,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
            },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        assert.equal(observed.code, 'PLOINKY_DOTENV_RUNTIME_NAME_REJECTED', vector.name);
        assert.equal(typeof observed.rejectedKey, 'string', vector.name);
        assert.equal(observed.safeBefore, null, `${vector.name} partially applied a prior line`);
        assert.equal(observed.safeAfter, null, `${vector.name} partially applied a later line`);
    }
});

test('auto-loads safe explicit external Soul Gateway settings from the nearest --dir parent', (t) => {
    const tempRoot = temporaryRoot(t, 'achilles-dotenv-external-');
    const launchCwd = path.join(tempRoot, 'launch-cwd');
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const selectedDir = path.join(workspaceRoot, 'nested', 'project');
    fs.mkdirSync(launchCwd, { recursive: true });
    fs.mkdirSync(selectedDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.env'), [
        'SOUL_GATEWAY_API_KEY=external-test-key',
        'SOUL_GATEWAY_BASE_URL=https://external-soul.example/v1',
        '',
    ].join('\n'));

    const probe = [
        'global.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) });',
        `const { loadModelsConfiguration } = await import(${JSON.stringify(loaderURL)});`,
        'const config = await loadModelsConfiguration();',
        "const provider = config.providers.get('soul_gateway');",
        'console.log(JSON.stringify({',
        '  keyPresent: Boolean(process.env.SOUL_GATEWAY_API_KEY),',
        '  keySource: process.env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY || null,',
        '  providerApiKeyEnv: provider?.apiKeyEnv || null,',
        '  providerBaseURL: provider?.baseURL || null,',
        '  generatedDescriptor: Boolean(provider?.generatedLocalDescriptor),',
        '}));',
    ].join('\n');
    const probePath = path.join(tempRoot, 'probe.mjs');
    fs.writeFileSync(probePath, probe);
    const result = spawnSync(process.execPath, [probePath, '--dir', selectedDir], {
        cwd: launchCwd,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
        },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(observed, {
        keyPresent: true,
        keySource: 'explicit',
        providerApiKeyEnv: 'SOUL_GATEWAY_API_KEY',
        providerBaseURL: 'https://external-soul.example/v1/chat/completions',
        generatedDescriptor: false,
    });
});
