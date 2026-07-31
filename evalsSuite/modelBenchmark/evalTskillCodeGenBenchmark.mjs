#!/usr/bin/env node
/**
 * tskill Code Generation Benchmark
 *
 * Tests the full tskill pipeline: tskill.md → specs → generated code → functional tests.
 * Uses real coral-agent skills (area, equipment, job, material) as test inputs.
 *
 * Pipeline under test:
 *   1. parseSkillMarkdown(tskill.md) → parsed skill object
 *   2. tskillToSpecs(skillDir, parsedSkill) → specs/tskill.generated.mjs.md
 *   3. generateMirrorCode(skillDir, llmAgent) → src/tskill.generated.mjs
 *   4. Import generated module → run functional tests
 *
 * Tests per skill:
 *   - Validators: required fields, valid/invalid inputs, error format (JSON string)
 *   - Resolvers: null handling, normalization
 *   - Presenters: null → em dash, formatting
 *   - Enumerators: returns correct arrays
 *   - Record-level: validateRecord, prepareRecord, presentRecord, generatePKValues
 *   - Exports: functions.global contains all expected keys
 *
 * Usage:
 *   node evalsSuite/modelBenchmark/evalTskillCodeGenBenchmark.mjs [options]
 *
 * Options:
 *   --models <list>    Comma-separated models (default: all NIM models + claude-opus-4-6)
 *   --skills <list>    Comma-separated skills (default: area,equipment,job,material)
 *   --no-reference     Skip reference model
 *   --output <file>    Save results to JSON file
 *   --cooldown <ms>    Cooldown between models in ms (default: 0)
 *   --help             Show help
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const { getProviderCredentialAvailability } = await import('../../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs');

// Self-contained tskill fixtures (copies of tskill.md from coral-agent skills)
const TSKILL_FIXTURES_DIR = path.join(__dirname, 'tskillFixtures');

const { LLMAgent } = await import('../../LLMAgents/LLMAgent.mjs');
const { loadModelsConfiguration } = await import('../../utils/LLMClient.mjs');
const { generateMirrorCode } = await import('../../skills/mirror-code-generator/src/codegen.mjs');
const { parseSkillMarkdown } = await import('../../DBTableSkillsSubsystem/SkillParser.mjs');
const { tskillToSpecs } = await import('../../DBTableSkillsSubsystem/tskillToSpecs.mjs');

const COLORS = {
    RESET: '\x1b[0m', RED: '\x1b[31m', GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m', CYAN: '\x1b[36m', GRAY: '\x1b[90m', BOLD: '\x1b[1m',
};

const REFERENCE_MODELS = ['claude-opus-4-6'];

// ─────────────────────────────────────────────────────────────────────────────
// Test definitions for each tskill — derived from tskill.md field specs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build functional tests dynamically from parsed skill definition.
 * Tests validators, resolvers, presenters, enumerators, and record-level functions.
 */
function buildTestsForSkill(parsedSkill) {
    return async (mod) => {
        const results = [];
        const fns = mod.functions?.global || mod;

        function assert(condition, name, detail) {
            results.push({ name, pass: !!condition, detail: condition ? null : detail });
        }

        // ── Exports check ───────────────────────────────────────────────────
        assert(typeof fns === 'object', 'exports: functions.global is object');

        // ── Validators ──────────────────────────────────────────────────────
        for (const [fieldName, field] of Object.entries(parsedSkill.fields)) {
            if (!field.validatorDescription && !field.isRequired) continue;
            const fn = fns[`validator_${fieldName}`];

            assert(typeof fn === 'function', `validator_${fieldName}: exists`);
            if (typeof fn !== 'function') continue;

            // Valid empty string return type check
            if (field.isRequired) {
                // Required field: null should return error
                const nullResult = fn(null, {});
                assert(
                    typeof nullResult === 'string' && nullResult.length > 0,
                    `validator_${fieldName}: null → error string`,
                    `got: ${JSON.stringify(nullResult)}`,
                );
                // Check error is valid JSON
                if (typeof nullResult === 'string' && nullResult.length > 0) {
                    try {
                        const parsed = JSON.parse(nullResult);
                        assert(parsed.field === fieldName, `validator_${fieldName}: error JSON has field=${fieldName}`, `got field=${parsed.field}`);
                    } catch {
                        assert(false, `validator_${fieldName}: error is valid JSON`, `got: ${nullResult.slice(0, 100)}`);
                    }
                }
                // Empty string should also return error
                const emptyResult = fn('', {});
                assert(
                    typeof emptyResult === 'string' && emptyResult.length > 0,
                    `validator_${fieldName}: empty string → error`,
                    `got: ${JSON.stringify(emptyResult)}`,
                );
            }
        }

        // ── Resolvers ───────────────────────────────────────────────────────
        for (const [fieldName, field] of Object.entries(parsedSkill.fields)) {
            if (!field.resolverDescription) continue;
            const fn = fns[`resolver_${fieldName}`];

            assert(typeof fn === 'function', `resolver_${fieldName}: exists`);
            if (typeof fn !== 'function') continue;

            // Null input → null output
            const nullResult = fn(null, {});
            // Some resolvers default (e.g., status → "Available"), others return null
            assert(
                nullResult === null || typeof nullResult === 'string',
                `resolver_${fieldName}: null → null or default`,
                `got: ${JSON.stringify(nullResult)}`,
            );
        }

        // ── Presenters ──────────────────────────────────────────────────────
        for (const [fieldName, field] of Object.entries(parsedSkill.fields)) {
            if (!field.valuePresenterDescription) continue;
            const fn = fns[`presenter_${fieldName}`];

            assert(typeof fn === 'function', `presenter_${fieldName}: exists`);
            if (typeof fn !== 'function') continue;

            // Null → em dash
            const nullResult = fn(null, {});
            assert(
                nullResult === '—' || nullResult === '\u2014' || nullResult === '-' || nullResult === 'N/A' || nullResult === 'Not assigned',
                `presenter_${fieldName}: null → placeholder`,
                `got: ${JSON.stringify(nullResult)}`,
            );
        }

        // ── Enumerators ─────────────────────────────────────────────────────
        for (const [fieldName, field] of Object.entries(parsedSkill.fields)) {
            if (!field.enumValues && !field.enumeratorDescription) continue;
            const fn = fns[`enumerator_${fieldName}`];

            assert(typeof fn === 'function', `enumerator_${fieldName}: exists`);
            if (typeof fn !== 'function') continue;

            const enumResult = fn({});
            assert(
                Array.isArray(enumResult),
                `enumerator_${fieldName}: returns array`,
                `got: ${typeof enumResult}`,
            );
            if (field.enumValues && Array.isArray(enumResult)) {
                // Check that known values are present
                for (const expected of field.enumValues) {
                    assert(
                        enumResult.includes(expected),
                        `enumerator_${fieldName}: contains "${expected}"`,
                        `values: ${JSON.stringify(enumResult)}`,
                    );
                }
            }
        }

        // ── Record-level: validateRecord ────────────────────────────────────
        const validateRecord = fns.validateRecord;
        if (typeof validateRecord === 'function') {
            // Empty record → should have errors (required fields missing)
            try {
                const emptyResult = await validateRecord({});
                const requiredFields = Object.entries(parsedSkill.fields).filter(([, f]) => f.isRequired);
                if (requiredFields.length > 0) {
                    assert(
                        emptyResult.isValid === false,
                        'validateRecord: empty record → isValid=false',
                        `got isValid=${emptyResult.isValid}`,
                    );
                    assert(
                        Array.isArray(emptyResult.errors) && emptyResult.errors.length > 0,
                        'validateRecord: empty record → has errors',
                        `got ${emptyResult.errors?.length} errors`,
                    );
                }
            } catch (e) {
                assert(false, 'validateRecord: empty record', `threw: ${e.message}`);
            }
        } else {
            assert(false, 'validateRecord: exists');
        }

        // ── Record-level: prepareRecord ─────────────────────────────────────
        const prepareRecord = fns.prepareRecord;
        assert(typeof prepareRecord === 'function', 'prepareRecord: exists');
        if (typeof prepareRecord === 'function') {
            try {
                const prepared = await prepareRecord({ test: 'value' }, {});
                assert(typeof prepared === 'object', 'prepareRecord: returns object', `got ${typeof prepared}`);
            } catch (e) {
                assert(false, 'prepareRecord: basic call', `threw: ${e.message}`);
            }
        }

        // ── Record-level: presentRecord ─────────────────────────────────────
        const presentRecord = fns.presentRecord;
        assert(typeof presentRecord === 'function', 'presentRecord: exists');
        if (typeof presentRecord === 'function') {
            try {
                const presented = await presentRecord({ test: 'value' });
                assert(typeof presented === 'object', 'presentRecord: returns object', `got ${typeof presented}`);
            } catch (e) {
                assert(false, 'presentRecord: basic call', `threw: ${e.message}`);
            }
        }

        // ── Record-level: generatePKValues ──────────────────────────────────
        const generatePKValues = fns.generatePKValues;
        assert(typeof generatePKValues === 'function', 'generatePKValues: exists');

        // ── Record-level: validateDelete ────────────────────────────────────
        const validateDelete = fns.validateDelete;
        assert(typeof validateDelete === 'function', 'validateDelete: exists');
        if (typeof validateDelete === 'function') {
            try {
                const delResult = await validateDelete('test-id', {}, {});
                assert(
                    delResult && typeof delResult.isValid === 'boolean',
                    'validateDelete: returns {isValid}',
                    `got: ${JSON.stringify(delResult)}`,
                );
            } catch (e) {
                assert(false, 'validateDelete: basic call', `threw: ${e.message}`);
            }
        }

        const passed = results.filter(r => r.pass).length;
        const failed = results.filter(r => !r.pass).length;
        return { passed, failed, results };
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        models: null,
        skills: ['area', 'material'],  // Start with simpler skills (fewer fields)
        includeReference: true,
        outputFile: null,
        cooldown: 0,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--models' || arg === '-m') options.models = args[++i]?.split(',').map(m => m.trim()).filter(Boolean) || null;
        else if (arg === '--skills') options.skills = args[++i]?.split(',').map(s => s.trim()).filter(Boolean) || options.skills;
        else if (arg === '--no-reference') options.includeReference = false;
        else if (arg === '--output' || arg === '-o') options.outputFile = args[++i];
        else if (arg === '--cooldown') options.cooldown = parseInt(args[++i], 10) || 0;
    }

    return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cleanError(msg, maxLen = 150) {
    if (!msg) return msg;
    const cleaned = String(msg).replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
}

function getModelsToTest(modelsConfig, requestedModels, includeReference) {
    const available = [];
    const seen = new Set();
    const referenceSet = new Set(includeReference ? REFERENCE_MODELS : []);
    const wantedSet = requestedModels ? new Set(requestedModels) : null;

    const isNimModel = (name, descriptor) =>
        descriptor.providerKey === 'soul_gateway' && descriptor.fromGateway && name.includes('/');

    const isWanted = (name, descriptor) => {
        if (wantedSet) return wantedSet.has(name);
        return isNimModel(name, descriptor) || referenceSet.has(name);
    };

    for (const [name, descriptor] of modelsConfig.models.entries()) {
        if (!isWanted(name, descriptor)) continue;
        const providerConfig = modelsConfig.providers.get(descriptor.providerKey);
        if (!providerConfig) continue;
        const apiKeyEnv = descriptor.apiKeyEnv || providerConfig.apiKeyEnv;
        const credentialAvailability = getProviderCredentialAvailability(providerConfig, apiKeyEnv);
        if (credentialAvailability !== 'generated-local'
            && credentialAvailability !== 'available') continue;
        if (seen.has(name)) continue;
        seen.add(name);
        available.push({ name, provider: descriptor.providerKey, apiKeyEnv, isReference: referenceSet.has(name) });
    }

    // Pass 2: soul_gateway fallback for reference models
    const sgProvider = modelsConfig.providers.get('soul_gateway');
    const sgKeyEnv = sgProvider?.apiKeyEnv;
    const sgCredentialAvailability = getProviderCredentialAvailability(sgProvider, sgKeyEnv);
    if (sgCredentialAvailability === 'generated-local'
        || sgCredentialAvailability === 'available') {
        for (const [name, descriptor] of modelsConfig.models.entries()) {
            if (seen.has(name) || !isWanted(name, descriptor)) continue;
            seen.add(name);
            available.push({ name, provider: 'soul_gateway', apiKeyEnv: sgKeyEnv, isReference: referenceSet.has(name) });
        }
    }

    available.sort((a, b) => {
        if (a.isReference !== b.isReference) return a.isReference ? 1 : -1;
        return a.name.localeCompare(b.name);
    });
    return available;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: tskill.md → specs → code → test
// ─────────────────────────────────────────────────────────────────────────────

async function testSkillForModel(modelName, skillName, skillDir, parsedSkill) {
    const startTime = Date.now();
    const result = {
        skill: skillName, model: modelName,
        specsGenerated: false, codeGenerated: false, syntaxOk: false,
        testsPassed: 0, testsFailed: 0, testsTotal: 0, testDetails: [],
        genTimeMs: 0, totalTimeMs: 0, error: null,
    };

    const llmAgent = new LLMAgent({ name: `TskillBench-${skillName}` });
    const origExecutePrompt = llmAgent.executePrompt.bind(llmAgent);
    llmAgent.executePrompt = function (prompt, opts = {}) {
        const nonce = `\n<!-- [bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}] -->`;
        return origExecutePrompt(prompt + nonce, { ...opts, model: modelName });
    };

    // Work in a temp copy to avoid corrupting the real skill directory
    const tmpDir = path.join(path.dirname(skillDir), `.bench-${skillName}-${Date.now()}`);

    try {
        // Copy tskill.md to temp dir
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.copyFile(path.join(skillDir, 'tskill.md'), path.join(tmpDir, 'tskill.md'));

        // Step 1: Generate specs from parsed tskill
        await tskillToSpecs(tmpDir, parsedSkill);
        const specFile = path.join(tmpDir, 'specs', 'tskill.generated.mjs.md');
        const specExists = await fs.stat(specFile).then(() => true).catch(() => false);
        if (!specExists) {
            result.error = 'Spec generation failed (no file produced)';
            result.totalTimeMs = Date.now() - startTime;
            return result;
        }
        result.specsGenerated = true;

        // Step 2: Generate code from specs
        const origWarn = console.warn;
        console.warn = () => {};
        const genStart = Date.now();
        let genResult;
        try {
            genResult = await generateMirrorCode(tmpDir, llmAgent, { log: () => {}, warn: () => {}, error: () => {} });
        } finally {
            console.warn = origWarn;
        }
        result.genTimeMs = Date.now() - genStart;

        // generateMirrorCode returns { message, generatedFiles: string[] }
        const generatedFiles = genResult?.generatedFiles || genResult || [];
        const fileList = Array.isArray(generatedFiles) ? generatedFiles : [];

        if (fileList.length === 0) {
            result.error = 'No code files generated';
            result.totalTimeMs = Date.now() - startTime;
            return result;
        }

        const codeFile = path.join(tmpDir, fileList[0]);
        const codeExists = await fs.stat(codeFile).then(() => true).catch(() => false);
        if (!codeExists) {
            result.error = 'Generated code deleted (syntax repair failed)';
            result.totalTimeMs = Date.now() - startTime;
            return result;
        }
        result.codeGenerated = true;

        // Step 3: Syntax check
        try {
            await execFileAsync('node', ['--check', codeFile]);
            result.syntaxOk = true;
        } catch (e) {
            result.error = cleanError(`Syntax error: ${e.stderr || e.message || ''}`);
            result.totalTimeMs = Date.now() - startTime;
            return result;
        }

        // Step 4: Functional tests
        const testFn = buildTestsForSkill(parsedSkill);
        try {
            const fileUrl = pathToFileURL(codeFile).href + `?t=${Date.now()}`;
            const mod = await import(fileUrl);
            const suiteResult = await testFn(mod);
            result.testsPassed = suiteResult.passed;
            result.testsFailed = suiteResult.failed;
            result.testsTotal = suiteResult.passed + suiteResult.failed;
            result.testDetails = suiteResult.results;
        } catch (e) {
            result.error = cleanError(`Runtime error: ${e.message || ''}`);
        }
    } catch (e) {
        result.error = cleanError(`Pipeline error: ${e.message || ''}`);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        result.totalTimeMs = Date.now() - startTime;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

function printModelResults(modelName, results, isReference = false) {
    const totalTests = results.reduce((s, r) => s + r.testsTotal, 0);
    const totalPassed = results.reduce((s, r) => s + r.testsPassed, 0);
    const avgGenTime = results.reduce((s, r) => s + r.genTimeMs, 0) / results.length;
    const allPass = results.every(r => r.testsTotal > 0 && r.testsFailed === 0);
    const color = allPass ? COLORS.GREEN : totalPassed >= totalTests * 0.5 ? COLORS.YELLOW : COLORS.RED;
    const refTag = isReference ? ` ${COLORS.YELLOW}(reference)${COLORS.RESET}` : '';

    console.log(`${color}${COLORS.BOLD}${modelName}${COLORS.RESET}${refTag}`);
    console.log(`  ${COLORS.CYAN}Tests:${COLORS.RESET} ${totalPassed}/${totalTests} | ${COLORS.CYAN}Avg Gen:${COLORS.RESET} ${avgGenTime.toFixed(0)}ms`);

    for (const r of results) {
        if (r.error) {
            console.log(`    ${COLORS.RED}ERROR${COLORS.RESET} ${r.skill} (${r.genTimeMs}ms) - ${r.error}`);
        } else if (!r.codeGenerated) {
            console.log(`    ${COLORS.RED}GEN FAIL${COLORS.RESET} ${r.skill}`);
        } else if (!r.syntaxOk) {
            console.log(`    ${COLORS.RED}SYNTAX${COLORS.RESET} ${r.skill}`);
        } else if (r.testsFailed === 0) {
            console.log(`    ${COLORS.GREEN}${r.testsPassed}/${r.testsTotal} PASS${COLORS.RESET} ${r.skill} (${r.genTimeMs}ms)`);
        } else {
            console.log(`    ${COLORS.YELLOW}${r.testsPassed}/${r.testsTotal} PASS${COLORS.RESET} ${r.skill} (${r.genTimeMs}ms)`);
            for (const t of r.testDetails.filter(t => !t.pass)) {
                console.log(`      ${COLORS.RED}-${COLORS.RESET} ${t.name}${t.detail ? `: ${t.detail}` : ''}`);
            }
        }
    }
    console.log();
}

function printSummaryTable(allResults, skills, modelInfoMap) {
    console.log(`\n${COLORS.BOLD}${COLORS.CYAN}=== TSKILL CODE GENERATION BENCHMARK SUMMARY ===${COLORS.RESET}\n`);

    const sorted = Object.entries(allResults)
        .map(([model, results]) => {
            const totalTests = results.reduce((s, r) => s + r.testsTotal, 0);
            const totalPassed = results.reduce((s, r) => s + r.testsPassed, 0);
            const avgGenTime = results.reduce((s, r) => s + r.genTimeMs, 0) / results.length;
            const isReference = modelInfoMap.get(model)?.isReference || false;
            const testRate = totalTests > 0 ? totalPassed / totalTests : 0;
            return { model, testRate, totalPassed, totalTests, avgGenTime, isReference };
        })
        .sort((a, b) => {
            if (b.testRate !== a.testRate) return b.testRate - a.testRate;
            return a.avgGenTime - b.avgGenTime;
        });

    const skillHeaders = skills.map(s => s.padStart(16)).join('');
    console.log(`${'Model'.padEnd(50)} ${'Tests'.padStart(10)} ${'AvgTime'.padStart(10)}${skillHeaders}`);
    console.log('-'.repeat(76 + skills.length * 16));

    for (const row of sorted) {
        const color = row.testRate === 1 ? COLORS.GREEN : row.testRate >= 0.5 ? COLORS.YELLOW : COLORS.RED;
        const refLabel = row.isReference ? ' *' : '';
        let line = `${color}${(row.model + refLabel).padEnd(50)}${COLORS.RESET} `;
        line += `${`${row.totalPassed}/${row.totalTests}`.padStart(8)} `;
        line += `${row.avgGenTime.toFixed(0).padStart(8)}ms`;

        const results = allResults[row.model];
        for (const skill of skills) {
            const r = results.find(x => x.skill === skill);
            if (!r || r.error) {
                line += `${COLORS.RED}${'ERROR'.padStart(16)}${COLORS.RESET}`;
            } else if (!r.syntaxOk) {
                line += `${COLORS.RED}${'SYNTAX'.padStart(16)}${COLORS.RESET}`;
            } else {
                const score = `${r.testsPassed}/${r.testsTotal}`;
                const c = r.testsFailed === 0 ? COLORS.GREEN : r.testsPassed > 0 ? COLORS.YELLOW : COLORS.RED;
                line += `${c}${score.padStart(16)}${COLORS.RESET}`;
            }
        }
        console.log(line);
    }

    console.log('-'.repeat(76 + skills.length * 16));
    if (sorted.some(m => m.isReference)) {
        console.log(`${COLORS.GRAY}  * = reference model${COLORS.RESET}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    const config = parseArgs();
    if (config.help) {
        console.log(`
${COLORS.BOLD}tskill Code Generation Benchmark${COLORS.RESET}

Tests the full tskill pipeline: tskill.md → specs → code → functional tests.
Uses real coral-agent skills (area, equipment, job, material).

${COLORS.CYAN}Options:${COLORS.RESET}
  --models, -m <list>   Models to test (default: all NIM + reference)
  --skills <list>       Skills: area, equipment, job, material (default: area,material)
  --no-reference        Skip reference model
  --output, -o <file>   Save results to JSON
  --cooldown <ms>       Cooldown between models (default: 0)
`);
        return;
    }

    console.log(`${COLORS.BOLD}${COLORS.CYAN}tskill Code Generation Benchmark${COLORS.RESET}\n`);

    // Verify fixtures directory exists
    const fixturesExist = await fs.stat(TSKILL_FIXTURES_DIR).then(() => true).catch(() => false);
    if (!fixturesExist) {
        console.log(`${COLORS.RED}tskill fixtures directory not found: ${TSKILL_FIXTURES_DIR}${COLORS.RESET}`);
        return;
    }

    // Parse tskill.md for each requested skill
    const parsedSkills = {};
    for (const skillName of config.skills) {
        const skillDir = path.join(TSKILL_FIXTURES_DIR, skillName);
        const tskillPath = path.join(skillDir, 'tskill.md');
        try {
            const content = await fs.readFile(tskillPath, 'utf-8');
            parsedSkills[skillName] = parseSkillMarkdown(content);
        } catch {
            console.log(`${COLORS.RED}Cannot read ${tskillPath}${COLORS.RESET}`);
            return;
        }
    }

    // Discover models
    const modelsConfig = await loadModelsConfiguration();
    const availableModels = getModelsToTest(modelsConfig, config.models, config.includeReference);

    if (availableModels.length === 0) {
        console.log(`${COLORS.RED}No models available. Check the generated runtime descriptor or explicit provider credentials.${COLORS.RESET}`);
        return;
    }

    const modelInfoMap = new Map(availableModels.map(m => [m.name, m]));
    const nvidiaCount = availableModels.filter(m => !m.isReference).length;
    const refCount = availableModels.filter(m => m.isReference).length;

    console.log(`${COLORS.CYAN}Models:${COLORS.RESET} ${nvidiaCount} NIM + ${refCount} reference`);
    console.log(`${COLORS.CYAN}Skills:${COLORS.RESET} ${config.skills.join(', ')}`);
    for (const [name, parsed] of Object.entries(parsedSkills)) {
        const fieldCount = Object.keys(parsed.fields).length;
        const derivedCount = Object.keys(parsed.derivedFields || {}).length;
        console.log(`  - ${name}: ${fieldCount} fields, ${derivedCount} derived`);
    }
    console.log(`${COLORS.CYAN}Total tests:${COLORS.RESET} ${availableModels.length} models x ${config.skills.length} skills`);
    console.log();

    const allResults = {};
    const totalRuns = availableModels.length * config.skills.length;
    let completed = 0;

    for (let mi = 0; mi < availableModels.length; mi++) {
        const model = availableModels[mi];
        allResults[model.name] = [];

        if (mi > 0 && config.cooldown > 0) {
            await new Promise(r => setTimeout(r, config.cooldown));
        }

        for (const skillName of config.skills) {
            completed++;
            const pct = Math.round((completed / totalRuns) * 100);
            process.stdout.write(`\r[${pct}%] ${model.name} | ${skillName}${''.padEnd(30)}`);

            const skillDir = path.join(TSKILL_FIXTURES_DIR, skillName);
            const result = await testSkillForModel(model.name, skillName, skillDir, parsedSkills[skillName]);
            allResults[model.name].push(result);
        }
    }

    process.stdout.write('\r' + ' '.repeat(100) + '\r');

    // Detailed results
    console.log(`\n${COLORS.BOLD}${COLORS.CYAN}=== DETAILED RESULTS ===${COLORS.RESET}\n`);
    const sortedModels = Object.entries(allResults)
        .sort(([, a], [, b]) => {
            const ap = a.reduce((s, r) => s + r.testsPassed, 0);
            const bp = b.reduce((s, r) => s + r.testsPassed, 0);
            if (bp !== ap) return bp - ap;
            return a.reduce((s, r) => s + r.genTimeMs, 0) - b.reduce((s, r) => s + r.genTimeMs, 0);
        });
    for (const [model, results] of sortedModels) {
        printModelResults(model, results, modelInfoMap.get(model)?.isReference);
    }

    printSummaryTable(allResults, config.skills, modelInfoMap);

    if (config.outputFile) {
        const output = {
            timestamp: new Date().toISOString(),
            benchmarkType: 'tskill-code-generation',
            config: { skills: config.skills, cooldown: config.cooldown },
            models: availableModels,
            parsedSkillSummary: Object.fromEntries(
                Object.entries(parsedSkills).map(([name, parsed]) => [
                    name,
                    { fields: Object.keys(parsed.fields).length, derived: Object.keys(parsed.derivedFields || {}).length },
                ]),
            ),
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
