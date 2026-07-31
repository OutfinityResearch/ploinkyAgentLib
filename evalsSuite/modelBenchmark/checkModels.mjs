#!/usr/bin/env node
/**
 * Model Health Check
 *
 * Discovers all enabled models from Soul Gateway and sends a simple prompt
 * to each one to verify which models are working and which are not.
 * Run this before benchmarks to identify broken/quota-exceeded models.
 *
 * Usage:
 *   node evalsSuite/modelBenchmark/checkModels.mjs [options]
 *
 * Options:
 *   --free              Only check free models (default)
 *   --all               Check all enabled models (including paid)
 *   --filter <pattern>  Only check models matching pattern
 *   --timeout <ms>      Per-model timeout (default: 30000)
 *   --help, -h          Show help
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = path.resolve(__dirname, '../..');

const C = {
    RESET: '\x1b[0m', RED: '\x1b[31m', GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m', CYAN: '\x1b[36m', DIM: '\x1b[2m',
};

const TEST_PROMPT = 'Reply with exactly one word: hello';
const EXPECTED = 'hello';

function parseArgs() {
    const args = process.argv.slice(2);
    let filter = null, freeOnly = false, timeoutMs = 30_000;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            console.log([
                'Usage: node evalsSuite/modelBenchmark/checkModels.mjs [options]',
                '',
                'Sends a simple prompt to each Soul Gateway model to check availability.',
                '',
                'Options:',
                '  --free              Only check free models',
                '  --filter <pattern>  Grep-filter models by name',
                '  --timeout <ms>      Per-model timeout (default: 30000)',
            ].join('\n'));
            process.exit(0);
        }
        else if (a === '--free') freeOnly = true;
        else if (a === '--filter') filter = args[++i];
        else if (a === '--timeout') timeoutMs = parseInt(args[++i], 10) || 30_000;
    }
    return { filter, freeOnly, timeoutMs };
}

async function discoverModels(freeOnly = false) {
    const { loadModelsConfiguration } = await import('../../utils/LLMProviders/providers/modelsConfigLoader.mjs');
    const config = await loadModelsConfiguration();
    const models = [];
    for (const [name, model] of config.models) {
        if (model.providerKey !== 'soul_gateway') continue;
        if (freeOnly && !model.isFree) continue;
        models.push(name);
    }
    return models;
}

async function checkModel(agent, modelName, timeoutMs) {
    const nonce = `<!-- [check-${Date.now()}-${Math.random().toString(36).slice(2, 6)}] -->`;
    const prompt = `${TEST_PROMPT}\n${nonce}`;
    const started = Date.now();

    try {
        const result = await Promise.race([
            agent.complete({ prompt, model: modelName }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);

        const latency = Date.now() - started;
        const response = (typeof result === 'string' ? result : String(result)).trim().toLowerCase();
        const ok = response.includes(EXPECTED);

        return { ok, latency, response: response.slice(0, 80), error: null };
    } catch (err) {
        const latency = Date.now() - started;
        const msg = err.message || String(err);
        // Extract the core error
        const short = msg.includes('402') ? '402 quota exceeded'
            : msg.includes('429') ? '429 rate limited'
            : msg.includes('timeout') ? 'timeout'
            : msg.includes('404') ? '404 not found'
            : msg.includes('500') ? '500 server error'
            : msg.slice(0, 80);
        return { ok: false, latency, response: null, error: short };
    }
}

async function main() {
    const opts = parseArgs();

    // Change to lib root so module imports work
    process.chdir(LIB_ROOT);

    const { LLMAgent } = await import('../../LLMAgents/LLMAgent.mjs');
    const agent = new LLMAgent({ name: 'model-health-check' });

    let models = await discoverModels(opts.freeOnly);
    if (opts.filter) {
        const re = new RegExp(opts.filter, 'i');
        models = models.filter(m => re.test(m));
    }

    if (!models.length) {
        console.log('No models found. Check the generated runtime descriptor or explicit provider credentials.');
        return;
    }

    console.log(`${C.CYAN}[Model Health Check] ${models.length} Soul Gateway models | timeout ${opts.timeoutMs / 1000}s${C.RESET}\n`);

    const results = { ok: [], fail: [], error: [] };

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const tag = `[${i + 1}/${models.length}]`;
        process.stdout.write(`${C.DIM}${tag}${C.RESET} ${model.padEnd(55)} `);

        const r = await checkModel(agent, model, opts.timeoutMs);

        if (r.error) {
            console.log(`${C.RED}ERROR ${r.latency}ms — ${r.error}${C.RESET}`);
            results.error.push({ model, ...r });
        } else if (r.ok) {
            console.log(`${C.GREEN}OK ${r.latency}ms${C.RESET}`);
            results.ok.push({ model, ...r });
        } else {
            console.log(`${C.YELLOW}WRONG ${r.latency}ms — got: "${r.response}"${C.RESET}`);
            results.fail.push({ model, ...r });
        }
    }

    // Summary
    console.log(`\n${C.CYAN}━━━ Summary ━━━${C.RESET}`);
    console.log(`${C.GREEN}  OK:    ${results.ok.length}${C.RESET}`);
    if (results.fail.length) console.log(`${C.YELLOW}  WRONG: ${results.fail.length} (responded but wrong answer)${C.RESET}`);
    if (results.error.length) console.log(`${C.RED}  ERROR: ${results.error.length} (failed to respond)${C.RESET}`);

    // List working models sorted by latency
    if (results.ok.length) {
        const sorted = results.ok.sort((a, b) => a.latency - b.latency);
        console.log(`\n${C.CYAN}Working models (sorted by latency):${C.RESET}`);
        for (const r of sorted) {
            console.log(`${C.GREEN}  ${String(r.latency).padStart(6)}ms  ${r.model}${C.RESET}`);
        }
    }

    // List broken models
    if (results.error.length) {
        console.log(`\n${C.RED}Broken models:${C.RESET}`);
        for (const r of results.error) {
            console.log(`${C.RED}  ${r.model} — ${r.error}${C.RESET}`);
        }
    }

    // Save results
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(__dirname, `model-health-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        source: 'soul_gateway',
        total: models.length,
        working: results.ok.map(r => r.model),
        workingDetails: results.ok.map(r => ({ model: r.model, latency: r.latency })),
        wrong: results.fail.map(r => ({ model: r.model, response: r.response, latency: r.latency })),
        broken: results.error.map(r => ({ model: r.model, error: r.error })),
    }, null, 2));
    console.log(`\nResults: ${outPath}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
