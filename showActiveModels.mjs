#!/usr/bin/env node
/**
 * Show Active Models
 * 
 * Displays the currently configured models
 * based on LLMConfig.json and .env overrides.
 * 
 * Usage: node showActiveModels.mjs
 */

import { listModelsFromCache, loadModelsConfiguration } from './utils/LLMClient.mjs';
import { getProviderCredentialAvailability } from './utils/LLMProviders/transport/generatedLocalRouterDescriptor.mjs';

const COLORS = {
    RESET: '\x1b[0m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    CYAN: '\x1b[36m',
    GRAY: '\x1b[90m',
    BOLD: '\x1b[1m',
};

function printSection(title, models) {
    console.log(`\n${COLORS.BOLD}${COLORS.CYAN}=== ${title} ===${COLORS.RESET}`);
    
    if (models.length === 0) {
        console.log(`  ${COLORS.YELLOW}(no models available)${COLORS.RESET}`);
        return;
    }

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const isPriority = i === 0;
        
        let badge = '';
        if (isPriority) badge += `${COLORS.GREEN}[1st]${COLORS.RESET} `;
        
        const credentialAvailability = getProviderCredentialAvailability(
            { generatedLocalDescriptor: model.generatedLocalDescriptor },
            model.apiKeyEnv,
        );
        const hasKey = credentialAvailability === 'generated-local'
            ? COLORS.GREEN + 'GENERATED'
            : credentialAvailability === 'available'
                ? COLORS.GREEN + 'YES'
                : credentialAvailability === 'missing'
                    ? COLORS.RED + 'NO'
                    : COLORS.GRAY + 'N/A';
        
        console.log(`  ${badge}${COLORS.BOLD}${model.name}${COLORS.RESET}`);
        console.log(`      Provider: ${model.providerKey}`);
        console.log(`      API Key: ${model.apiKeyEnv || 'none'} (${hasKey}${COLORS.RESET})`);
        if (model.qualifiedName) {
            console.log(`      Qualified: ${model.qualifiedName}`);
        }
    }
}

async function main() {
    console.log(`${COLORS.BOLD}${COLORS.CYAN}Active LLM Models Configuration${COLORS.RESET}`);
    console.log(`${COLORS.GRAY}Models are listed in priority order (first = highest priority)${COLORS.RESET}`);

    const config = await loadModelsConfiguration();
    const models = listModelsFromCache();
    
    // Show LLMConfig.json defaults
    console.log(`\n${COLORS.BOLD}LLMConfig.json Defaults:${COLORS.RESET}`);
    const defaults = Array.from(config.defaults?.entries?.() || []);
    if (!defaults.length) {
        console.log(`  ${COLORS.GRAY}(no defaults configured)${COLORS.RESET}`);
    } else {
        defaults.forEach(([key, value]) => {
            console.log(`  ${key}: ${value}`);
        });
    }
    
    // Show active models
    printSection('Models (priority order)', models.models);
 
    // Summary
    console.log(`\n${COLORS.BOLD}Summary:${COLORS.RESET}`);
    console.log(`  Total models: ${models.models.length}`);
    if (models.models.length > 0) {
        console.log(`  ${COLORS.GREEN}First model (will be used):${COLORS.RESET} ${models.models[0].name}`);
    }
}

await main();
