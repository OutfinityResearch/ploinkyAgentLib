import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const results = [];

async function listTestFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }
      files.push(...await listTestFiles(fullPath));
    } else if (entry.isFile()) {
      if (entry.name === 'runAll.mjs') {
        continue;
      }
      if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

const testFiles = await listTestFiles(testsRoot);

for (const filePath of testFiles) {
  const relativePath = path.relative(testsRoot, filePath).replace(/\\/g, '/');
  try {
    const { stdout } = await execFileAsync(process.execPath, [filePath], { cwd: testsRoot, maxBuffer: 10 * 1024 * 1024 });
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.results)) {
      results.push({
        file: relativePath,
        pass: false,
        error: 'Test output was not valid JSON with a results array.',
      });
      continue;
    }
    const pass = parsed.results.every((entry) => entry && entry.pass === true);
    const failures = parsed.results
      .filter((entry) => entry && entry.pass === false)
      .map((entry) => ({
        ...entry,
        fileName: relativePath,
      }));
    if (!pass) {
      results.push({
        file: relativePath,
        pass,
        failedTests: failures,
      });
    }
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const message = error?.message ? String(error.message) : 'Test execution failed.';
    const details = [message, stderr, stdout].filter(Boolean).join('\n');
    results.push({
      file: relativePath,
      pass: false,
      error: details,
    });
  }
}

process.stdout.write(JSON.stringify({ failedTests: results }));
process.exitCode = results.length === 0 ? 0 : 1;
