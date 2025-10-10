import { LLMAgent, DEFAULT_AGENT_NAME } from './LLMAgent.mjs';
import { LLMAgentRegistry, llmAgentRegistry } from './LLMAgentRegistry.mjs';
import {
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
    responseToJSON,
} from './markdown.mjs';
import { envAutoConfig } from './envAutoConfig.mjs';
import { defaultLLMInvokerStrategy } from '../utils/LLMClient.mjs';

const envReport = envAutoConfig();
if (envReport.loaded) {
    const appliedCount = Object.keys(envReport.variables || {}).length;
    console.info(`[ploinkyAgentLib] Environment auto-config applied ${appliedCount} key(s).`);
}

try {
    if (defaultLLMInvokerStrategy && typeof defaultLLMInvokerStrategy.describe === 'function') {
        const description = defaultLLMInvokerStrategy.describe();
        if (description) {
            const modes = Array.isArray(description.supportedModes) && description.supportedModes.length
                ? description.supportedModes.join(', ')
                : 'unknown';
            const fastModels = Array.isArray(description.fastModels) && description.fastModels.length
                ? description.fastModels.join(', ')
                : 'none';
            const deepModels = Array.isArray(description.deepModels) && description.deepModels.length
                ? description.deepModels.join(', ')
                : 'none';
            console.info('[ploinkyAgentLib] Default LLM configuration:');
            if (description.configPath) {
                console.info(`[ploinkyAgentLib]   Config file: ${description.configPath}`);
            }
            console.info(`[ploinkyAgentLib]   Supported modes: ${modes}`);
            console.info(`[ploinkyAgentLib]   Fast models: ${fastModels}`);
            console.info(`[ploinkyAgentLib]   Deep models: ${deepModels}`);
        }
    }
} catch (error) {
    console.warn(`[ploinkyAgentLib] Failed to summarise default LLM configuration: ${error.message}`);
}

export {
    LLMAgent,
    DEFAULT_AGENT_NAME,
    LLMAgentRegistry,
    llmAgentRegistry,
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
    responseToJSON,
    envAutoConfig,
};
