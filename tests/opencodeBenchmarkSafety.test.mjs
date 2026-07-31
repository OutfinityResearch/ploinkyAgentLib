import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const benchmarkScript = path.join(
    repositoryRoot,
    'evalsSuite/modelBenchmark/opencodeBenchmark/runOpencodeBenchmark.sh'
);

test('OpenCode benchmark requires only an explicit external Soul Gateway credential', () => {
    const source = fs.readFileSync(benchmarkScript, 'utf8');
    assert.doesNotMatch(source, /PLOINKY_AGENT_API_KEY/);
    assert.match(source, /SOUL_GATEWAY_API_KEY:\?SOUL_GATEWAY_API_KEY must be set/);
    assert.match(source, /"baseURL": "https:\/\/soul\.axiologic\.dev\/v1"/);
});
