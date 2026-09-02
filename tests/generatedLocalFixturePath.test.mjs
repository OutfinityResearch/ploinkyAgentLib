import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const fixtureModuleURL = new URL('./helpers/generatedLocalFixture.mjs', import.meta.url).href;

function selectedFixtureDirectory(override) {
    const env = { ...process.env };
    delete env.PLOINKY_TEST_ROUTER_FIXTURE_DIR;
    if (override !== undefined) env.PLOINKY_TEST_ROUTER_FIXTURE_DIR = override;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        const { GENERATED_LOCAL_FIXTURE_DIR, fixturePath } = await import(${JSON.stringify(fixtureModuleURL)});
        console.log(JSON.stringify({ directory: GENERATED_LOCAL_FIXTURE_DIR, file: fixturePath() }));
    `], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

test('router fixtures retain the installed-layout default without an explicit test selector', () => {
    const directory = path.resolve(import.meta.dirname, '../../../tests/fixtures/router-descriptor');
    for (const override of [undefined, '  ']) {
        assert.deepEqual(selectedFixtureDirectory(override), {
            directory,
            file: path.join(directory, 'public-envelope.json'),
        });
    }
});

test('standalone source tests can explicitly select the canonical producer fixtures', () => {
    const directory = path.resolve(import.meta.dirname, 'selected-producer-fixtures');
    assert.deepEqual(selectedFixtureDirectory(` ${directory} `), {
        directory,
        file: path.join(directory, 'public-envelope.json'),
    });
});
