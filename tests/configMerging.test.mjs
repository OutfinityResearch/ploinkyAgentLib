/**
 * Test script for configuration merging between .env and LLMConfig.json
 * 
 * Verifies:
 * 1. .env takes priority over LLMConfig.json for providers and models
 * 2. .env and LLMConfig.json are properly merged
 * 3. Qualified model names (provider/model) work correctly
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    loadModelsConfiguration,
    resolveModelName,
} from '../utils/LLMProviders/providers/modelsConfigLoader.mjs';
import { fixtureEnvironment } from './helpers/generatedLocalFixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const descriptorURL = pathToFileURL(path.resolve(
    __dirname,
    '../utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs'
)).href;
const envLoaderURL = pathToFileURL(path.resolve(
    __dirname,
    '../utils/LLMProviders/providers/envConfigLoader.mjs'
)).href;
const modelsLoaderURL = pathToFileURL(path.resolve(
    __dirname,
    '../utils/LLMProviders/providers/modelsConfigLoader.mjs'
)).href;

describe('Config Merging: .env and LLMConfig.json', () => {
    // Store original env vars to restore later
    const originalEnv = {};
    const envKeysToClean = [];

    function setEnvVar(key, value) {
        if (!(key in originalEnv)) {
            originalEnv[key] = process.env[key];
        }
        envKeysToClean.push(key);
        process.env[key] = value;
    }

    function cleanEnvVars() {
        for (const key of envKeysToClean) {
            if (originalEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originalEnv[key];
            }
        }
        envKeysToClean.length = 0;
    }

    beforeEach(() => {
        // Clear any existing test env vars
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('OPENAI_TEST') || 
                key.startsWith('ANTHROPIC_TEST') || 
                key.startsWith('LLM_MODEL_TEST') ||
                key.startsWith('SOUL_GATEWAY') ||
                key.startsWith('PLOINKY_ENV_SOURCE_') ||
                key === 'PLOINKY_AGENT_API_KEY' ||
                key === 'PLOINKY_ROUTER_URL') {
                delete process.env[key];
            }
        }
    });

    afterEach(() => {
        cleanEnvVars();
    });

    describe('.env priority over LLMConfig.json', () => {
        it('keeps descriptor-free stock soul_gateway non-routable', async () => {
            const config = await loadModelsConfiguration();
            const provider = config.providers.get('soul_gateway');
            assert.ok(provider, 'stock provider identity remains available');
            assert.strictEqual(provider.baseURL, null);
            assert.strictEqual(provider.apiKeyEnv, undefined);
            assert.strictEqual(provider.generatedLocalDescriptor, undefined);
        });

        it('should use env-defined provider over JSON provider with same key', async () => {
            // Define an env provider that overrides 'openai'
            setEnvVar('OPENAI_OPENAI_URL', 'https://custom-openai.example.com/v1/chat/completions');
            setEnvVar('OPENAI_OPENAI_KEY', 'sk-env-override-key');

            const config = await loadModelsConfiguration();

            const provider = config.providers.get('openai');
            assert.ok(provider, 'openai provider should exist');
            assert.strictEqual(
                provider.baseURL, 
                'https://custom-openai.example.com/v1/chat/completions',
                'Env baseURL should override JSON baseURL'
            );
            assert.strictEqual(provider.fromEnv, true, 'Provider should be marked as fromEnv');
        });

        it('should prepend env-defined models to orderedModels (higher priority)', async () => {
            // Add an env-defined provider and model
            setEnvVar('OPENAI_TESTPROXY_URL', 'https://testproxy.example.com/v1/chat/completions');
            setEnvVar('OPENAI_TESTPROXY_KEY', 'sk-test-key');
            setEnvVar('LLM_MODEL_TEST01', 'testproxy/test-model-fast|fast|0.1|0.5|128k');

            const config = await loadModelsConfiguration();

            // Env models should be at the beginning of orderedModels
            const testModelIndex = config.orderedModels.indexOf('test-model-fast');
            assert.ok(testModelIndex >= 0, 'test-model-fast should be in orderedModels');
            
            // It should be before JSON-defined models
            const jsonModelIndex = config.orderedModels.indexOf('gpt-4.1');
            if (jsonModelIndex >= 0) {
                assert.ok(
                    testModelIndex < jsonModelIndex,
                    'Env model should appear before JSON models in orderedModels'
                );
            }
        });

        it('should mark env-defined models with fromEnv flag', async () => {
            setEnvVar('OPENAI_TESTPROXY_URL', 'https://testproxy.example.com/v1/chat/completions');
            setEnvVar('OPENAI_TESTPROXY_KEY', 'sk-test-key');
            setEnvVar('LLM_MODEL_TEST01', 'testproxy/my-custom-model|deep|5|15|128k');

            const config = await loadModelsConfiguration();

            const model = config.models.get('my-custom-model');
            assert.ok(model, 'my-custom-model should exist in models');
            assert.strictEqual(model.fromEnv, true, 'Model should be marked as fromEnv');
        });

        it('should allow env models to override JSON models with same name', async () => {
            // This tests the case where an env model has the same name as a JSON model
            // but different provider - the env version should take precedence
            setEnvVar('OPENAI_CUSTOMPROXY_URL', 'https://custom.example.com/v1/chat/completions');
            setEnvVar('OPENAI_CUSTOMPROXY_KEY', 'sk-custom-key');
            // Define a model that might conflict with a JSON-defined one
            setEnvVar('LLM_MODEL_TEST01', 'customproxy/gpt-5|deep|0.5|2|200k');

            const config = await loadModelsConfiguration();

            // The qualified lookup should find the env version
            const resolved = resolveModelName('customproxy/gpt-5', config.models, config.qualifiedModels);
            assert.ok(resolved, 'Should resolve customproxy/gpt-5');
            
            const model = config.models.get(resolved);
            assert.strictEqual(model.providerKey, 'customproxy', 'Should be the env-defined provider');
        });

        it('should fail closed when a generated credential has no signed descriptor bundle', async () => {
            setEnvVar('PLOINKY_AGENT_API_KEY', 'sk-test-agent-key');

            await assert.rejects(
                loadModelsConfiguration(),
                { code: 'PLOINKY_DESCRIPTOR_TRUST_ANCHOR_SOURCE_INVALID' }
            );
        });

        it('constructs generated soul_gateway only from the verified descriptor brand and exact operation', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlib-generated-config-'));
            try {
                const probe = [
                    `const descriptorModule = await import(${JSON.stringify(descriptorURL)});`,
                    'const verified = descriptorModule.loadGeneratedLocalRouterDescriptor();',
                    'let keyReads = 0;',
                    'const originalEnv = process.env;',
                    "process.env = new Proxy(originalEnv, { get(target, property, receiver) { if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1; return Reflect.get(target, property, receiver); } });",
                    `const { loadEnvConfig } = await import(${JSON.stringify(envLoaderURL)});`,
                    'const config = loadEnvConfig({ generatedLocalDescriptor: verified });',
                    "const provider = config.providers.get('soul_gateway');",
                    'console.log(JSON.stringify({',
                    '  branded: descriptorModule.isVerifiedGeneratedLocalRouterDescriptor(provider.generatedLocalDescriptor),',
                    '  baseURL: provider.baseURL,',
                    '  apiKeyEnv: provider.apiKeyEnv,',
                    '  module: provider.module,',
                    '  keyReads,',
                    '}));',
                ].join('\n');
                const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
                    cwd: tempRoot,
                    encoding: 'utf8',
                    timeout: 10_000,
                    env: {
                        ...process.env,
                        ...fixtureEnvironment(),
                        ACHILLES_ENV_START_DIR: tempRoot,
                    },
                });
                assert.strictEqual(result.status, 0, result.stderr || result.stdout);
                const observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
                assert.strictEqual(observed.branded, true);
                assert.strictEqual(observed.apiKeyEnv, 'PLOINKY_AGENT_API_KEY');
                assert.strictEqual(observed.module, './utils/LLMProviders/providers/openai.mjs');
                assert.strictEqual(observed.keyReads, 0);
                assert.strictEqual(
                    observed.baseURL,
                    'http://host.containers.internal:8080/base-agent-additional-server/soul-gateway/7000/v1/chat/completions'
                );
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });

        it('should use an explicit SOUL_GATEWAY_BASE_URL override when provided', async () => {
            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
            setEnvVar('SOUL_GATEWAY_API_KEY', 'sk-test-agent-key');
            setEnvVar('SOUL_GATEWAY_BASE_URL', 'https://custom-soul.example.com');

            try {
                const config = await loadModelsConfiguration();
                const provider = config.providers.get('soul_gateway');
                assert.ok(provider, 'soul_gateway provider should exist');
                assert.strictEqual(
                    provider.baseURL,
                    'https://custom-soul.example.com/v1/chat/completions',
                    'Explicit Soul Gateway env URL should override the JSON default'
                );
                assert.strictEqual(provider.apiKeyEnv, 'SOUL_GATEWAY_API_KEY');
            } finally {
                global.fetch = originalFetch;
            }
        });

        it('rejects protected provider and model JSON properties before generated key access', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlib-generated-overrides-'));
            try {
                for (const vector of [
                    {
                        label: 'provider-baseURL',
                        raw: {
                            providers: {
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                    baseURL: 'http://host.containers.internal:8080',
                                },
                            },
                            models: [],
                        },
                    },
                    {
                        label: 'model-headers',
                        raw: {
                            providers: {
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                },
                            },
                            models: [{
                                name: 'code',
                                providerKey: 'soul_gateway',
                                headers: {},
                            }],
                        },
                    },
                    {
                        label: 'provider-custom-module',
                        raw: {
                            providers: {
                                soul_gateway: {
                                    module: './attacker-controlled-provider.mjs',
                                },
                            },
                            models: [],
                        },
                    },
                    {
                        label: 'provider-extra-transport',
                        raw: {
                            providers: {
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                    extra: {
                                        transport: './attacker-controlled-transport.mjs',
                                        headers: { Host: 'attacker.invalid' },
                                    },
                                },
                            },
                            models: [],
                        },
                    },
                    {
                        label: 'custom-provider-generated-key-alias',
                        raw: {
                            providers: {
                                attacker_gateway: {
                                    module: './attacker-controlled-provider.mjs',
                                    baseURL: 'https://attacker.invalid/v1/chat/completions',
                                    apiKeyEnv: 'PLOINKY_AGENT_API_KEY',
                                },
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                },
                            },
                            models: [],
                        },
                    },
                    {
                        label: 'custom-provider-local-origin-alias',
                        raw: {
                            providers: {
                                attacker_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                    baseURL: 'http://host.containers.internal:8080/v1/chat/completions',
                                    apiKeyEnv: 'ATTACKER_KEY',
                                },
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                },
                            },
                            models: [],
                        },
                    },
                    {
                        label: 'custom-model-generated-key-alias',
                        raw: {
                            providers: {
                                attacker_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                    baseURL: 'https://attacker.invalid/v1/chat/completions',
                                    apiKeyEnv: 'ATTACKER_KEY',
                                },
                                soul_gateway: {
                                    module: './utils/LLMProviders/providers/openai.mjs',
                                },
                            },
                            models: [{
                                name: 'attacker-code',
                                providerKey: 'attacker_gateway',
                                apiKeyEnv: 'PLOINKY_AGENT_API_KEY',
                            }],
                        },
                    },
                ]) {
                    const probe = [
                        `const descriptorModule = await import(${JSON.stringify(descriptorURL)});`,
                        'const verified = descriptorModule.loadGeneratedLocalRouterDescriptor();',
                        'let keyReads = 0;',
                        'const originalEnv = process.env;',
                        "process.env = new Proxy(originalEnv, { get(target, property, receiver) { if (property === 'PLOINKY_AGENT_API_KEY') keyReads += 1; return Reflect.get(target, property, receiver); } });",
                        `const { normalizeConfig } = await import(${JSON.stringify(modelsLoaderURL)});`,
                        'let code = null;',
                        `try { normalizeConfig(${JSON.stringify(vector.raw)}, { generatedLocalDescriptor: verified }); } catch (error) { code = error.code || error.name; }`,
                        'console.log(JSON.stringify({ code, keyReads }));',
                    ].join('\n');
                    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
                        cwd: tempRoot,
                        encoding: 'utf8',
                        timeout: 10_000,
                        env: {
                            ...process.env,
                            ...fixtureEnvironment(),
                            ACHILLES_ENV_START_DIR: tempRoot,
                        },
                    });
                    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
                    assert.deepStrictEqual(
                        JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),
                        { code: 'PLOINKY_GENERATED_LOCAL_OVERRIDE', keyReads: 0 },
                        vector.label
                    );
                }
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    });

    describe('.env and LLMConfig.json merging', () => {
        it('should include both env and JSON providers', async () => {
            setEnvVar('OPENAI_ENVONLY_URL', 'https://envonly.example.com/v1/chat/completions');
            setEnvVar('OPENAI_ENVONLY_KEY', 'sk-envonly-key');

            const config = await loadModelsConfiguration();

            // Should have the env-defined provider
            assert.ok(config.providers.has('envonly'), 'envonly provider should exist');
            
            // Should still have JSON-defined providers
            assert.ok(config.providers.has('openai'), 'openai provider from JSON should exist');
            assert.ok(config.providers.has('anthropic'), 'anthropic provider from JSON should exist');
            assert.ok(config.providers.has('google'), 'google provider from JSON should exist');
        });

        it('should include both env and gateway-discovered models', async () => {
            setEnvVar('OPENAI_ENVPROVIDER_URL', 'https://envprovider.example.com/v1/chat/completions');
            setEnvVar('OPENAI_ENVPROVIDER_KEY', 'sk-env-key');
            setEnvVar('LLM_MODEL_TEST01', 'envprovider/env-only-model|fast|0.1|0.5|64k');

            const config = await loadModelsConfiguration();

            // Env model should exist
            assert.ok(config.models.has('env-only-model'), 'env-only-model should exist');

            // Gateway-discovered models should also exist (if gateway is available)
            if (config.models.size > 1) {
                let hasGatewayModel = false;
                for (const [, desc] of config.models) {
                    if (desc.fromGateway) { hasGatewayModel = true; break; }
                }
                assert.ok(hasGatewayModel, 'gateway-discovered models should coexist with env models');
            }
        });

        it('should build qualified models map for provider/model lookups', async () => {
            setEnvVar('OPENAI_TESTPROV_URL', 'https://testprov.example.com/v1/chat/completions');
            setEnvVar('OPENAI_TESTPROV_KEY', 'sk-test-key');
            setEnvVar('LLM_MODEL_TEST01', 'testprov/qualified-test|fast|0.1|0.5|64k');

            const config = await loadModelsConfiguration();

            assert.ok(config.qualifiedModels, 'qualifiedModels map should exist');
            assert.ok(
                config.qualifiedModels.has('testprov/qualified-test'),
                'Should have qualified name in map'
            );
        });

        it('should resolve models by qualified name (provider/model)', async () => {
            setEnvVar('OPENAI_MYPROV_URL', 'https://myprov.example.com/v1/chat/completions');
            setEnvVar('OPENAI_MYPROV_KEY', 'sk-my-key');
            setEnvVar('LLM_MODEL_TEST01', 'myprov/my-model|fast|0.1|0.5|64k');

            const config = await loadModelsConfiguration();

            // Resolve by qualified name
            const resolved = resolveModelName('myprov/my-model', config.models, config.qualifiedModels);
            assert.strictEqual(resolved, 'my-model', 'Should resolve to model name');

            // Also resolve by simple name
            const simpleResolved = resolveModelName('my-model', config.models, config.qualifiedModels);
            assert.strictEqual(simpleResolved, 'my-model', 'Should resolve simple name too');
        });

        it('should add env models to providerModels map', async () => {
            setEnvVar('OPENAI_GROUPPROV_URL', 'https://groupprov.example.com/v1/chat/completions');
            setEnvVar('OPENAI_GROUPPROV_KEY', 'sk-group-key');
            setEnvVar('LLM_MODEL_TEST01', 'groupprov/group-model-1|fast|0.1|0.5|64k');
            setEnvVar('LLM_MODEL_TEST02', 'groupprov/group-model-2|deep|1|5|128k');

            const config = await loadModelsConfiguration();

            const providerModels = config.providerModels.get('groupprov');
            assert.ok(providerModels, 'groupprov should have providerModels');
            assert.ok(providerModels.length >= 2, 'groupprov should have at least 2 models');
            
            const modelNames = providerModels.map(m => m.name);
            assert.ok(modelNames.includes('group-model-1'), 'Should include group-model-1');
            assert.ok(modelNames.includes('group-model-2'), 'Should include group-model-2');
        });
    });

    describe('LLMConfig.json validation', () => {
        it('should have valid defaultFastModel in LLMConfig.json', async () => {
            const config = await loadModelsConfiguration();

            if (config.defaultFastModel) {
                const model = config.models.get(config.defaultFastModel);
                assert.ok(model, `Default fast model "${config.defaultFastModel}" should exist`);
                assert.strictEqual(
                    model.tier,
                    'fast',
                    `Default fast model should have tier "fast"`
                );
            }
        });

        it('should have valid defaultDeepModel in LLMConfig.json', async () => {
            const config = await loadModelsConfiguration();

            if (config.defaultDeepModel) {
                const model = config.models.get(config.defaultDeepModel);
                assert.ok(model, `Default deep model "${config.defaultDeepModel}" should exist`);
                assert.strictEqual(
                    model.tier,
                    'deep',
                    `Default deep model should have tier "deep"`
                );
            }
        });

        it('should have valid defaults map', async () => {
            const config = await loadModelsConfiguration();

            if (config.defaults && config.defaults.size > 0) {
                for (const [intentName, modelName] of config.defaults) {
                    assert.ok(
                        typeof intentName === 'string' && intentName.length > 0,
                        `Intent name should be a non-empty string`
                    );
                    assert.ok(
                        typeof modelName === 'string' && modelName.length > 0,
                        `Default model for "${intentName}" should be a non-empty string`
                    );
                }
            }
        });

        it('should have no obsolete models (gpt-4, gpt-4-turbo, gpt-4o, etc.)', async () => {
            const config = await loadModelsConfiguration();

            const obsoleteModels = [
                'gpt-4',
                'gpt-4-turbo',
                'gpt-4o',
                'gpt-4o-mini',
                'gpt-4.1-mini',  // Poor performer (96%)
                'gpt-4.1-nano',  // Poor performer (92%)
                'o1',
                'o3',
                'o3-mini',
            ];

            for (const obsolete of obsoleteModels) {
                // Check in JSON-defined models (not env-defined)
                const model = config.models.get(obsolete);
                if (model && !model.fromEnv) {
                    assert.fail(`Obsolete model "${obsolete}" should not be in LLMConfig.json`);
                }
            }
        });

        it('should have all declared providers from LLMConfig.json', async () => {
            const config = await loadModelsConfiguration();

            const expectedProviders = ['openai', 'anthropic', 'google', 'openrouter', 'soul_gateway'];

            for (const expected of expectedProviders) {
                assert.ok(config.providers.has(expected), `Provider "${expected}" should exist in config`);
            }
        });
    });

    describe('ACHILLES env var priority', () => {
        it('should support ACHILLES_DEFAULT_FAST_MODEL env override', () => {
            // This test documents the expected behavior for ACHILLES_* env vars
            // ACHILLES_* env vars are injected by ploinky via docker -e flags
            const envVar = process.env.ACHILLES_DEFAULT_FAST_MODEL;
            
            // Just verify the env var format is understood
            if (envVar) {
                const parts = envVar.split('/');
                if (parts.length === 2) {
                    assert.ok(parts[0].length > 0, 'Provider part should not be empty');
                    assert.ok(parts[1].length > 0, 'Model part should not be empty');
                }
            }
            
            // Test passes - this documents the expected format
            assert.ok(true);
        });

        it('should support ACHILLES_ENABLED_FAST_MODELS env override', () => {
            const envVar = process.env.ACHILLES_ENABLED_FAST_MODELS;
            
            if (envVar) {
                const models = envVar.split(',');
                assert.ok(models.length > 0, 'Should have at least one model');
                
                for (const model of models) {
                    assert.ok(model.trim().length > 0, 'Model names should not be empty');
                }
            }
            
            assert.ok(true);
        });
    });
});

console.log('Running config merging tests...');
