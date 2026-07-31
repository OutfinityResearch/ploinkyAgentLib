#!/usr/bin/env node
/**
 * Code Generation Benchmark Evaluation Suite
 *
 * Tests LLM models for code generation quality across two levels:
 *   Level 1: Single-shot function generation (prompt → code → unit tests)
 *   Level 2: Agentic multi-step coding (read → edit → test → fix loop)
 *
 * Usage:
 *   node evalsSuite/modelBenchmark/evalCodeGenBenchmark.mjs [options]
 *
 * Options:
 *   --models <list>    Comma-separated list of models to test
 *   --free             Only test free models (isFree from gateway)
 *   --soul-gateway     Only test soul_gateway models
 *   --healthy          Only test models under 3s latency (from health check)
 *   --level <1|2|all>  Test level (default: all)
 *   --cases <range>    Test case range, e.g., "1-5" or "3"
 *   --difficulty <d>   Filter by difficulty: easy,medium,hard
 *   --runs <n>         Number of runs per model/case (default: 1)
 *   --output <file>    Save results to JSON file
 *   --timeout <ms>     Model call timeout (default: 30000 for L1, 60000 for L2)
 *   --help             Show help
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const L1_CASES_DIR = path.join(__dirname, 'codeGenCases', 'level1');
const L2_CASES_DIR = path.join(__dirname, 'codeGenCases', 'level2');

const { LLMAgent } = await import('../../LLMAgents/LLMAgent.mjs');
const { loadModelsConfiguration } = await import('../../utils/LLMClient.mjs');
const { getProviderCredentialAvailability } = await import('../../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs');

const COLORS = {
    RESET: '\x1b[0m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    GRAY: '\x1b[90m',
    BOLD: '\x1b[1m',
};

const CODE_FENCE_REGEX = /```(?:javascript|js|mjs)?\n([\s\S]*?)```/g;

// ============================================================================
// CLI PARSING
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        models: null,
        level: 'all',
        caseRange: null,
        difficulties: null,
        runs: 1,
        outputFile: null,
        help: false,
        soulGateway: false,
        freeOnly: false,
        healthy: false,
        l1Timeout: 30000,
        l2Timeout: 60000,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--models' || arg === '-m') {
            options.models = args[++i]?.split(',').map(m => m.trim()).filter(Boolean) || null;
            // Explicit model list overrides discovery filters
            if (options.models) { options.freeOnly = false; options.soulGateway = false; }
        } else if (arg === '--all-models') {
            options.models = null;
        } else if (arg === '--soul-gateway') {
            options.soulGateway = true;
            options.models = null;
        } else if (arg === '--free') {
            options.freeOnly = true;
            options.models = null;
        } else if (arg === '--healthy') {
            options.healthy = true;
        } else if (arg === '--level' || arg === '-l') {
            options.level = args[++i] || 'all';
        } else if (arg === '--cases' || arg === '-c') {
            options.caseRange = args[++i];
        } else if (arg === '--difficulty' || arg === '-d') {
            options.difficulties = args[++i]?.split(',').map(d => d.trim()).filter(Boolean) || null;
        } else if (arg === '--runs' || arg === '-r') {
            options.runs = parseInt(args[++i], 10) || 1;
        } else if (arg === '--output' || arg === '-o') {
            options.outputFile = args[++i];
        } else if (arg === '--timeout' || arg === '-t') {
            const t = parseInt(args[++i], 10);
            if (t) { options.l1Timeout = t; options.l2Timeout = t; }
        }
    }

    return options;
}

function printHelp() {
    console.log(`
${COLORS.BOLD}Code Generation Benchmark Evaluation Suite${COLORS.RESET}

Tests LLM models for code generation quality:
  Level 1: Single-shot function generation (prompt → code → unit tests)
  Level 2: Agentic multi-step (read → edit → test → fix loop)

${COLORS.BOLD}Options:${COLORS.RESET}
  --models <list>      Comma-separated models to test (default: all available)
  --free               Only free models (isFree flag from gateway discovery)
  --soul-gateway       Only soul_gateway provider models
  --healthy            Only models under 3s latency (requires prior checkModels run)
  --level <1|2|all>    Test level (default: all)
  --cases <range>      Case range, e.g., "1-5" or "3" (default: all)
  --difficulty <d>     Comma-separated: easy,medium,hard
  --runs <n>           Runs per model/case (default: 1)
  --output <file>      Save JSON results to file
  --timeout <ms>       Model timeout in ms
  --help               Show this help

${COLORS.BOLD}Examples:${COLORS.RESET}
  node evalCodeGenBenchmark.mjs --free --soul-gateway
  node evalCodeGenBenchmark.mjs --free --level 1
  node evalCodeGenBenchmark.mjs --models copilot-gpt-4.1 --cases 1-5
  node evalCodeGenBenchmark.mjs --free --output codegen-results.json
`);
}

// ============================================================================
// MODEL DISCOVERY
// ============================================================================

function loadWorkingModels(maxLatencyMs = null) {
    const files = fsSync.readdirSync(__dirname)
        .filter(f => f.startsWith('model-health-') && f.endsWith('.json'))
        .sort().reverse();
    if (!files.length) return null;
    try {
        const raw = JSON.parse(fsSync.readFileSync(path.join(__dirname, files[0]), 'utf8'));
        let working = new Set(raw.working || []);
        if (maxLatencyMs && raw.workingDetails) {
            working = new Set(
                raw.workingDetails
                    .filter(m => m.latency <= maxLatencyMs)
                    .map(m => m.model)
            );
        }
        console.log(`${COLORS.GRAY}Loaded health check: ${files[0]} (${working.size} models)${COLORS.RESET}`);
        return working;
    } catch { return null; }
}

function getAvailableModels(modelsConfig, requestedModels, { freeOnly = false } = {}) {
    const available = [];

    for (const [name, descriptor] of modelsConfig.models.entries()) {
        if (freeOnly && descriptor.providerKey === 'soul_gateway' && !descriptor.isFree) continue;

        const providerConfig = modelsConfig.providers.get(descriptor.providerKey);
        if (!providerConfig) continue;

        const apiKeyEnv = descriptor.apiKeyEnv || providerConfig.apiKeyEnv;
        const credentialAvailability = getProviderCredentialAvailability(providerConfig, apiKeyEnv);
        if (credentialAvailability !== 'generated-local'
            && credentialAvailability !== 'available') continue;

        const qualifiedName = `${descriptor.providerKey}/${name}`;

        if (requestedModels) {
            const matchesSimple = requestedModels.includes(name);
            const matchesQualified = requestedModels.includes(qualifiedName);
            if (!matchesSimple && !matchesQualified) continue;
        }

        const displayName = requestedModels?.includes(qualifiedName) ? qualifiedName : name;

        available.push({
            name: displayName,
            provider: descriptor.providerKey,
            tier: descriptor.tier || 'fast',
            apiKeyEnv,
        });
    }

    return available;
}

// ============================================================================
// TEST CASE LOADING
// ============================================================================

async function loadCases(dir, caseRange, difficulties) {
    let files;
    try {
        files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
    } catch {
        return [];
    }

    if (caseRange) {
        const [start, end] = caseRange.includes('-')
            ? caseRange.split('-').map(Number)
            : [Number(caseRange), Number(caseRange)];
        files = files.filter(f => {
            const match = f.match(/case_(\d+)/);
            if (match) {
                const num = parseInt(match[1], 10);
                return num >= start && num <= end;
            }
            return false;
        });
    }

    const cases = [];
    for (const file of files) {
        const data = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
        if (difficulties && !difficulties.includes(data.difficulty)) continue;
        cases.push(data);
    }
    return cases;
}

// ============================================================================
// CODE EXTRACTION
// ============================================================================

function extractCode(llmResponse) {
    const matches = [];
    let match;
    const regex = new RegExp(CODE_FENCE_REGEX.source, CODE_FENCE_REGEX.flags);
    while ((match = regex.exec(llmResponse)) !== null) {
        matches.push(match[1]);
    }
    if (matches.length > 0) {
        // Prefer the block that contains `export` (the actual module, not usage examples)
        const withExport = matches.filter(m => /\bexport\b/.test(m));
        if (withExport.length > 0) {
            return withExport.sort((a, b) => b.length - a.length)[0];
        }
        // Fallback to longest if none has export
        return matches.sort((a, b) => b.length - a.length)[0];
    }

    // Fallback: if no fenced block, try to extract code-like content
    const lines = llmResponse.split('\n');
    const codeLines = lines.filter(l =>
        /^\s*(export|import|function|const|let|var|class|async|return|if|for|while|{|}|\/\/)/.test(l)
    );
    if (codeLines.length > 3) {
        return codeLines.join('\n');
    }

    return null;
}

// ============================================================================
// LEVEL 1: FUNCTION GENERATION
// ============================================================================

async function runLevel1Case(agent, modelName, testCase, timeoutMs) {
    const nonce = `[nonce:${Math.random().toString(36).slice(2, 10)}]`;
    const systemPrompt = [
        'You are an expert JavaScript developer.',
        'Write a JavaScript ES module that fulfills the requirements below.',
        'Export all requested functions as named exports.',
        'Wrap your code in a ```javascript fenced code block.',
        'Do not include any explanation, only the code.',
    ].join('\n');

    const prompt = `${testCase.prompt}\n\n${nonce}`;

    const startTime = Date.now();
    let llmResponse;
    try {
        llmResponse = await agent.complete({
            prompt,
            model: modelName,
            context: { intent: 'codegen-benchmark-l1', systemPrompt },
            timeout: timeoutMs,
        });
    } catch (err) {
        return {
            level: 1,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs: Date.now() - startTime,
            error: `LLM call failed: ${err.message}`,
            syntaxOk: false,
            testsRun: 0,
            testsPassed: 0,
            testsTotal: testCase.tests.length,
            success: false,
        };
    }
    const latencyMs = Date.now() - startTime;

    // Extract code
    const code = extractCode(String(llmResponse));
    if (!code) {
        return {
            level: 1,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs,
            error: 'Could not extract code from LLM response',
            syntaxOk: false,
            testsRun: 0,
            testsPassed: 0,
            testsTotal: testCase.tests.length,
            success: false,
        };
    }

    // Write to temp file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegen-l1-'));
    const tmpFile = path.join(tmpDir, 'generated.mjs');
    await fs.writeFile(tmpFile, code);

    // Syntax check first
    try {
        await execFileAsync('node', ['--check', tmpFile], { timeout: 5000 });
    } catch (err) {
        await cleanupDir(tmpDir);
        return {
            level: 1,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs,
            error: `Syntax error: ${err.stderr || err.message}`,
            syntaxOk: false,
            testsRun: 0,
            testsPassed: 0,
            testsTotal: testCase.tests.length,
            success: false,
        };
    }

    // Build a test runner script that executes in a child process.
    // This isolates stack overflows, infinite loops, and other crashes
    // from killing the benchmark harness.
    const testRunnerCode = `
import * as mod from './generated.mjs';

const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'Assertion failed');
};

const tests = ${JSON.stringify(testCase.tests)};
const exportedSymbols = ${JSON.stringify(testCase.exportedSymbols || [])};
const results = { syntaxOk: true, missingExports: [], testDetails: [] };

// Check exported symbols
for (const sym of exportedSymbols) {
    if (!(sym in mod)) results.missingExports.push(sym);
}

if (results.missingExports.length > 0) {
    process.stdout.write(JSON.stringify(results));
    process.exit(0);
}

// Run tests
for (const test of tests) {
    try {
        const isAsync = test.async || test.code.includes('await ');
        if (isAsync) {
            const fn = new Function('mod', 'assert', 'return (async () => { ' + test.code + ' })();');
            await fn(mod, assert);
        } else {
            const fn = new Function('mod', 'assert', test.code);
            fn(mod, assert);
        }
        results.testDetails.push({ name: test.name, passed: true });
    } catch (err) {
        results.testDetails.push({ name: test.name, passed: false, error: String(err.message || err).slice(0, 300) });
    }
}

process.stdout.write(JSON.stringify(results));
`;

    const runnerFile = path.join(tmpDir, '_runner.mjs');
    await fs.writeFile(runnerFile, testRunnerCode);

    let testResult;
    try {
        const { stdout } = await execFileAsync('node', [runnerFile], {
            cwd: tmpDir,
            timeout: 15000,
        });
        testResult = JSON.parse(stdout);
    } catch (err) {
        await cleanupDir(tmpDir);
        const stderr = (err.stderr || '').slice(0, 300);
        const signal = err.signal ? ` (signal: ${err.signal})` : '';
        return {
            level: 1,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs,
            error: `Test execution crashed${signal}: ${stderr || err.message}`,
            syntaxOk: true,
            testsRun: 0,
            testsPassed: 0,
            testsTotal: testCase.tests.length,
            success: false,
        };
    }

    await cleanupDir(tmpDir);

    // Process results from child
    if (testResult.missingExports?.length > 0) {
        return {
            level: 1,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs,
            error: `Missing exports: ${testResult.missingExports.join(', ')}`,
            syntaxOk: true,
            testsRun: 0,
            testsPassed: 0,
            testsTotal: testCase.tests.length,
            success: false,
        };
    }

    const testDetails = testResult.testDetails || [];
    const testsPassed = testDetails.filter(t => t.passed).length;

    return {
        level: 1,
        caseId: testCase.id,
        difficulty: testCase.difficulty,
        latencyMs,
        syntaxOk: true,
        testsRun: testDetails.length,
        testsPassed,
        testsTotal: testCase.tests.length,
        success: testsPassed === testCase.tests.length,
        testDetails,
    };
}

// ============================================================================
// LEVEL 2: AGENTIC MULTI-STEP
// ============================================================================

async function walkDir(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...await walkDir(path.join(dir, entry.name), relPath));
        } else {
            files.push(relPath);
        }
    }
    return files;
}

function createWorkspaceTools(workspaceDir, testFile) {
    return {
        readFile: {
            description: 'Reads a file from the workspace. Arg: file path.',
            handler: async (_agent, prompt) => {
                const filePath = prompt.trim().replace(/^['"]|['"]$/g, '');
                const absPath = path.join(workspaceDir, filePath);
                try {
                    return await fs.readFile(absPath, 'utf8');
                } catch (err) {
                    return `Error reading file: ${err.message}`;
                }
            },
        },
        writeFile: {
            description: 'Writes content to a file. First line is file path, remaining lines are content.',
            handler: async (_agent, prompt) => {
                const lines = prompt.split('\n');
                const filePath = lines[0].trim().replace(/^['"]|['"]$/g, '');
                const content = lines.slice(1).join('\n');
                const absPath = path.join(workspaceDir, filePath);
                try {
                    await fs.mkdir(path.dirname(absPath), { recursive: true });
                    await fs.writeFile(absPath, content);
                    return `File written: ${filePath}`;
                } catch (err) {
                    return `Error writing file: ${err.message}`;
                }
            },
        },
        runTests: {
            description: 'Runs the test suite and returns output. No arguments needed.',
            handler: async (_agent, _prompt) => {
                const absTestFile = path.join(workspaceDir, testFile);
                try {
                    const { stdout, stderr } = await execFileAsync('node', [absTestFile], {
                        cwd: workspaceDir,
                        timeout: 10000,
                    });
                    return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
                } catch (err) {
                    const output = err.stdout || '';
                    const errOutput = err.stderr || err.message;
                    return `TESTS FAILED:\n${output}\n${errOutput}`;
                }
            },
        },
        listFiles: {
            description: 'Lists all files in the workspace. No arguments needed.',
            handler: async (_agent, _prompt) => {
                try {
                    const files = await walkDir(workspaceDir);
                    return files.join('\n');
                } catch (err) {
                    return `Error listing files: ${err.message}`;
                }
            },
        },
    };
}

async function runLevel2Case(agent, modelName, testCase, timeoutMs) {
    const startTime = Date.now();

    // Create temp workspace
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegen-l2-'));

    try {
        // Write workspace files
        for (const [filePath, content] of Object.entries(testCase.workspace)) {
            const absPath = path.join(workspaceDir, filePath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content);
        }

        const tools = createWorkspaceTools(workspaceDir, testCase.verification.testFile);

        const taskPrompt = [
            'Here is your task:',
            testCase.description,
            '',
            'Start by listing and reading the files in the workspace to understand the codebase.',
            'Then run the tests to see what fails.',
            'Fix the code and run the tests again until all tests pass.',
        ].join('\n');

        // Run agentic session
        const session = await agent.startLoopAgentSession(tools, taskPrompt, {
            systemPrompt: testCase.systemPrompt,
            model: modelName,
            maxToolCalls: testCase.maxToolCalls || 10,
            timeout: timeoutMs,
        });

        // Count tool calls from session
        const toolCallCount = session.toolCalls?.length || 0;

        // Verify by actually running the test file
        const absTestFile = path.join(workspaceDir, testCase.verification.testFile);
        let verificationOutput = '';
        let success = false;
        try {
            const { stdout } = await execFileAsync('node', [absTestFile], {
                cwd: workspaceDir,
                timeout: 10000,
            });
            verificationOutput = stdout.trim();
            success = verificationOutput.includes(testCase.verification.expectedOutput);
        } catch (err) {
            verificationOutput = (err.stdout || '') + (err.stderr || err.message);
        }

        const latencyMs = Date.now() - startTime;

        return {
            level: 2,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs,
            toolCalls: toolCallCount,
            success,
            verificationOutput: verificationOutput.slice(0, 200),
        };
    } catch (err) {
        return {
            level: 2,
            caseId: testCase.id,
            difficulty: testCase.difficulty,
            latencyMs: Date.now() - startTime,
            error: `Session error: ${err.message}`,
            toolCalls: 0,
            success: false,
        };
    } finally {
        await cleanupDir(workspaceDir);
    }
}

// ============================================================================
// UTILITIES
// ============================================================================

async function cleanupDir(dir) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

function printProgress(current, total, model, caseId) {
    const pct = ((current / total) * 100).toFixed(0);
    process.stdout.write(`\r${COLORS.GRAY}[${pct}%] ${model} / ${caseId}${' '.repeat(30)}${COLORS.RESET}`);
}

function clearProgress() {
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
}

// ============================================================================
// SCORING & OUTPUT
// ============================================================================

function printSummaryTable(allResults) {
    console.log(`\n${COLORS.BOLD}${COLORS.CYAN}=== CODE GENERATION BENCHMARK SUMMARY ===${COLORS.RESET}\n`);

    const sorted = Object.entries(allResults)
        .map(([model, results]) => {
            const l1Results = results.filter(r => r.level === 1);
            const l2Results = results.filter(r => r.level === 2);

            const l1Pass = l1Results.filter(r => r.success).length;
            const l1Total = l1Results.length;
            const l1Rate = l1Total > 0 ? l1Pass / l1Total : 0;

            const l2Pass = l2Results.filter(r => r.success).length;
            const l2Total = l2Results.length;
            const l2Rate = l2Total > 0 ? l2Pass / l2Total : 0;

            const combined = l1Total > 0 && l2Total > 0
                ? 0.4 * l1Rate + 0.6 * l2Rate
                : l1Total > 0 ? l1Rate : l2Rate;

            const avgLatency = results.length > 0
                ? results.reduce((sum, r) => sum + (r.latencyMs || 0), 0) / results.length
                : 0;

            const avgToolCalls = l2Results.length > 0
                ? l2Results.reduce((sum, r) => sum + (r.toolCalls || 0), 0) / l2Results.length
                : 0;

            return {
                model,
                l1Rate, l1Pass, l1Total,
                l2Rate, l2Pass, l2Total,
                combined,
                avgLatency,
                avgToolCalls,
            };
        })
        .sort((a, b) => {
            if (b.combined !== a.combined) return b.combined - a.combined;
            return a.avgLatency - b.avgLatency;
        });

    // Header
    console.log(
        `${'Model'.padEnd(32)} ` +
        `${'L1 Pass'.padStart(9)} ` +
        `${'L2 Pass'.padStart(9)} ` +
        `${'Combined'.padStart(9)} ` +
        `${'Latency'.padStart(10)} ` +
        `${'ToolCalls'.padStart(10)}`
    );
    console.log('-'.repeat(85));

    for (const row of sorted) {
        const color = row.combined >= 0.8 ? COLORS.GREEN :
                      row.combined >= 0.5 ? COLORS.YELLOW : COLORS.RED;

        const l1Str = row.l1Total > 0
            ? `${(row.l1Rate * 100).toFixed(0)}%`
            : 'N/A';
        const l2Str = row.l2Total > 0
            ? `${(row.l2Rate * 100).toFixed(0)}%`
            : 'N/A';

        console.log(
            `${color}${row.model.padEnd(32)}${COLORS.RESET} ` +
            `${l1Str.padStart(9)} ` +
            `${l2Str.padStart(9)} ` +
            `${(row.combined * 100).toFixed(0).padStart(7)}% ` +
            `${row.avgLatency.toFixed(0).padStart(8)}ms ` +
            `${row.avgToolCalls.toFixed(1).padStart(10)}`
        );
    }

    console.log('-'.repeat(85));

    // Recommendations
    if (sorted.length > 0) {
        const best = sorted[0];
        const fastest = [...sorted].sort((a, b) => a.avgLatency - b.avgLatency)[0];
        const bestL2 = [...sorted].filter(r => r.l2Total > 0).sort((a, b) => b.l2Rate - a.l2Rate)[0];

        console.log(`\n${COLORS.BOLD}Recommendations:${COLORS.RESET}`);
        console.log(`  ${COLORS.GREEN}Best Overall:${COLORS.RESET} ${best.model} (${(best.combined * 100).toFixed(0)}% combined, ${best.avgLatency.toFixed(0)}ms)`);
        if (fastest.model !== best.model) {
            console.log(`  ${COLORS.CYAN}Fastest:${COLORS.RESET} ${fastest.model} (${fastest.avgLatency.toFixed(0)}ms, ${(fastest.combined * 100).toFixed(0)}% combined)`);
        }
        if (bestL2 && bestL2.model !== best.model) {
            console.log(`  ${COLORS.MAGENTA}Best Agentic:${COLORS.RESET} ${bestL2.model} (${(bestL2.l2Rate * 100).toFixed(0)}% L2 pass rate)`);
        }
    }
}

function printDetailedResults(allResults) {
    console.log(`\n${COLORS.BOLD}${COLORS.CYAN}=== DETAILED RESULTS ===${COLORS.RESET}\n`);

    for (const [model, results] of Object.entries(allResults)) {
        console.log(`${COLORS.BOLD}${model}${COLORS.RESET}`);

        for (const r of results) {
            const levelTag = r.level === 1 ? 'L1' : 'L2';
            const icon = r.success ? `${COLORS.GREEN}PASS${COLORS.RESET}` : `${COLORS.RED}FAIL${COLORS.RESET}`;
            const latency = `${r.latencyMs}ms`;

            let detail = '';
            if (r.level === 1) {
                detail = r.error || `${r.testsPassed}/${r.testsTotal} tests`;
            } else {
                detail = r.error || `${r.toolCalls} tool calls`;
            }

            console.log(`  [${levelTag}] ${icon} ${r.caseId} (${r.difficulty}) — ${latency} — ${detail}`);

            // Print failed test details for L1
            if (r.level === 1 && r.testDetails) {
                for (const t of r.testDetails) {
                    if (!t.passed) {
                        console.log(`    ${COLORS.RED}✗ ${t.name}: ${t.error}${COLORS.RESET}`);
                    }
                }
            }
        }
        console.log();
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const config = parseArgs();

    if (config.help) {
        printHelp();
        return;
    }

    console.log(`${COLORS.BOLD}${COLORS.CYAN}Code Generation Benchmark Evaluation Suite${COLORS.RESET}\n`);

    // Load model configuration
    const modelsConfig = await loadModelsConfiguration();

    // Load test cases
    const runL1 = config.level === 'all' || config.level === '1';
    const runL2 = config.level === 'all' || config.level === '2';

    const l1Cases = runL1 ? await loadCases(L1_CASES_DIR, config.caseRange, config.difficulties) : [];
    const l2Cases = runL2 ? await loadCases(L2_CASES_DIR, config.caseRange, config.difficulties) : [];

    if (l1Cases.length === 0 && l2Cases.length === 0) {
        console.log(`${COLORS.RED}No test cases found.${COLORS.RESET}`);
        return;
    }

    // Get available models
    let availableModels = getAvailableModels(modelsConfig, config.models, { freeOnly: config.freeOnly });
    if (config.soulGateway) {
        availableModels = availableModels.filter(m => m.provider === 'soul_gateway');
    }
    if (config.healthy) {
        const working = loadWorkingModels(3000);
        if (working) {
            availableModels = availableModels.filter(m => working.has(m.name));
        } else {
            console.log(`${COLORS.YELLOW}No health check results found. Run checkModels.mjs first.${COLORS.RESET}`);
        }
    }

    if (availableModels.length === 0) {
        console.log(`${COLORS.RED}No models available to test.${COLORS.RESET}`);
        console.log('Make sure the generated runtime descriptor or explicit provider credentials are available.');
        return;
    }

    console.log(`${COLORS.CYAN}Models to test:${COLORS.RESET} ${availableModels.length}`);
    availableModels.forEach(m => console.log(`  - ${m.name} (${m.provider})`));
    console.log(`${COLORS.CYAN}Level 1 cases:${COLORS.RESET} ${l1Cases.length}`);
    console.log(`${COLORS.CYAN}Level 2 cases:${COLORS.RESET} ${l2Cases.length}`);
    console.log(`${COLORS.CYAN}Runs per case:${COLORS.RESET} ${config.runs}`);
    console.log();

    const agent = new LLMAgent({ name: 'CodeGenBenchmark' });
    const allResults = {};
    const totalTests = availableModels.length * (l1Cases.length + l2Cases.length) * config.runs;
    let completedTests = 0;

    for (const modelInfo of availableModels) {
        allResults[modelInfo.name] = [];
        let consecutiveErrors = 0;
        let skipped = false;

        // Run Level 1 cases
        for (const testCase of l1Cases) {
            if (skipped) break;
            for (let run = 0; run < config.runs; run++) {
                completedTests++;
                printProgress(completedTests, totalTests, modelInfo.name, `L1/${testCase.id}`);

                const result = await runLevel1Case(agent, modelInfo.name, testCase, config.l1Timeout);
                allResults[modelInfo.name].push({ ...result, run: run + 1 });

                if (result.error) {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 3) {
                        clearProgress();
                        console.log(`${COLORS.RED}  Skipping ${modelInfo.name} — ${consecutiveErrors} consecutive errors${COLORS.RESET}`);
                        skipped = true;
                        break;
                    }
                } else {
                    consecutiveErrors = 0;
                }
            }
        }

        // Run Level 2 cases
        for (const testCase of l2Cases) {
            if (skipped) break;
            for (let run = 0; run < config.runs; run++) {
                completedTests++;
                printProgress(completedTests, totalTests, modelInfo.name, `L2/${testCase.id}`);

                const result = await runLevel2Case(agent, modelInfo.name, testCase, config.l2Timeout);
                allResults[modelInfo.name].push({ ...result, run: run + 1 });

                if (result.error) {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 3) {
                        clearProgress();
                        console.log(`${COLORS.RED}  Skipping ${modelInfo.name} — ${consecutiveErrors} consecutive errors${COLORS.RESET}`);
                        skipped = true;
                        break;
                    }
                } else {
                    consecutiveErrors = 0;
                }
            }
        }
    }

    clearProgress();

    // Print results
    printDetailedResults(allResults);
    printSummaryTable(allResults);

    // Save to file
    if (config.outputFile) {
        const output = {
            timestamp: new Date().toISOString(),
            config: {
                level: config.level,
                runs: config.runs,
                caseRange: config.caseRange,
                difficulties: config.difficulties,
            },
            models: availableModels,
            l1Cases: l1Cases.map(c => ({ id: c.id, difficulty: c.difficulty })),
            l2Cases: l2Cases.map(c => ({ id: c.id, difficulty: c.difficulty })),
            results: allResults,
        };
        await fs.writeFile(config.outputFile, JSON.stringify(output, null, 2));
        console.log(`\n${COLORS.GREEN}Results saved to ${config.outputFile}${COLORS.RESET}`);
    }
}

main().catch(err => {
    console.error(`${COLORS.RED}Fatal error:${COLORS.RESET}`, err);
    process.exit(1);
});
