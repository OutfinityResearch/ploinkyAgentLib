#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const entries = readdirSync(root);
const testFiles = entries
    .filter(name => extname(name) === '.mjs' && name !== 'runAllTests.js')
    .sort();

if (!testFiles.length) {
    console.log('No test files found.');
    process.exit(0);
}

const results = [];

for (const file of testFiles) {
    const path = join(root, file);
    const child = spawnSync('node', ['--test', path], { stdio: 'pipe', encoding: 'utf8' });

    const passed = child.status === 0;
    results.push({
        file,
        status: passed ? 'passed' : 'failed',
        exitCode: child.status,
        stdout: child.stdout?.trim() || '',
        stderr: child.stderr?.trim() || '',
    });

    const statusLabel = passed ? 'PASS' : 'FAIL';
    console.log(`${statusLabel} ${file}`);
    if (!passed) {
        if (child.stderr) {
            console.error(child.stderr.trim());
        }
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
