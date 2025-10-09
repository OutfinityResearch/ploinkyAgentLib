import { llmAgentRegistry } from '../LLMAgents/LLMAgentRegistry.mjs';
import SkillRegistry from './SkillRegistry.mjs';
import { SkilledAgent } from './SkilledAgent.mjs';
import { executeSkill } from './SkillExecutor.mjs';
import { chooseSkillWithLLM } from './skillSelection.mjs';

const registerLLMAgent = (config, options = {}) => llmAgentRegistry.register(config, options);
const registerDefaultLLMAgent = (config = {}) => llmAgentRegistry.registerDefault(config);
const getLLMAgent = (name) => llmAgentRegistry.get(name);
const getDefaultLLMAgent = () => llmAgentRegistry.getDefault();
const listLLMAgents = () => llmAgentRegistry.list();
const clearLLMAgents = () => llmAgentRegistry.clear();

function createSkilledAgent(options = {}) {
    const { llmAgentName = null, llmAgent = null, skillRegistry = null, promptReader = null } = options;
    const agentInstance = llmAgent
        || (llmAgentName ? llmAgentRegistry.get(llmAgentName) : null)
        || llmAgentRegistry.getDefault();
    if (!agentInstance) {
        throw new Error('No LLMAgent available. Register at least one agent before creating a SkilledAgent.');
    }
    return new SkilledAgent({ llmAgent: agentInstance, skillRegistry, promptReader });
}

export {
    SkilledAgent,
    SkillRegistry,
    executeSkill,
    chooseSkillWithLLM,
    createSkilledAgent,
    registerLLMAgent,
    registerDefaultLLMAgent,
    getLLMAgent,
    getDefaultLLMAgent,
    listLLMAgents,
    clearLLMAgents,
};
