#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('.', import.meta.url));

const DEFAULT_DISABLED = new Set(['runAllTests.js', 'useSkill/helpers.mjs']);
const envDisabled = (process.env.DISABLED_TESTS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
const disabled = new Set([...DEFAULT_DISABLED, ...envDisabled]);

function collectTestFiles(dirPath, basePath = dirPath) {
    const collected = [];
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }

        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            collected.push(...collectTestFiles(fullPath, basePath));
            continue;
        }
        if (extname(entry.name) !== '.mjs') {
            continue;
        }

        const relativePath = relative(basePath, fullPath);
        if (disabled.has(entry.name) || disabled.has(relativePath)) {
            continue;
        }
        collected.push(relativePath);
    }

    return collected;
}

const testFiles = collectTestFiles(rootPath).sort();

if (!testFiles.length) {
    console.log('No test files found.');
    process.exit(0);
}

if (disabled.size) {
    console.log('Disabled tests:', Array.from(disabled).join(', ') || 'none');
}

const results = [];

for (const relativePath of testFiles) {
    const absolutePath = join(rootPath, relativePath);
    const child = spawnSync('node', ['--test', absolutePath], { stdio: 'pipe', encoding: 'utf8' });

    const passed = child.status === 0;
    results.push({
        file: relativePath,
        status: passed ? 'passed' : 'failed',
        exitCode: child.status,
        stdout: child.stdout?.trim() || '',
        stderr: child.stderr?.trim() || '',
    });

    const statusLabel = passed ? 'PASS' : 'FAIL';
    console.log(`${statusLabel} ${relativePath}`);
    if (!passed && child.stderr) {
        console.error(child.stderr.trim());
    }
}

const failed = results.filter(result => result.status === 'failed');

console.log('\nTest Summary');
console.log('------------');
results.forEach(result => {
    console.log(`${result.status === 'passed' ? '✔' : '✖'} ${result.file}`);
    if (result.status === 'failed') {
        if (result.stderr) {
            console.log(`  stderr: ${result.stderr.replace(/\n/g, '\n          ')}`);
        }
        if (result.stdout) {
            console.log(`  stdout: ${result.stdout.replace(/\n/g, '\n          ')}`);
        }
        console.log(`  exit code: ${result.exitCode}`);
    }
});

console.log('\nTotal:', results.length, 'tests');
console.log('Passed:', results.length - failed.length);
console.log('Failed:', failed.length);

if (failed.length) {
    process.exit(1);
}
