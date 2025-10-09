import { LLMAgent, DEFAULT_AGENT_NAME } from './LLMAgent.mjs';

class LLMAgentRegistry {
    constructor() {
        this.agents = new Map();
        this.defaultAgentName = null;
    }

    createAgent(config = {}) {
        if (config instanceof LLMAgent) {
            return config;
        }
        return new LLMAgent(config);
    }

    register(agentConfig, { setAsDefault = false } = {}) {
        const agent = this.createAgent(agentConfig);
        this.agents.set(agent.name, agent);
        if (setAsDefault || !this.defaultAgentName) {
            this.defaultAgentName = agent.name;
        }
        return agent;
    }

    registerDefault(agentConfig = {}) {
        const mergedConfig = {
            name: agentConfig?.name || DEFAULT_AGENT_NAME,
            ...agentConfig,
        };
        return this.register(mergedConfig, { setAsDefault: true });
    }

    get(name) {
        if (!name) {
            return this.getDefault();
        }
        return this.agents.get(name) || null;
    }

    getDefault() {
        if (!this.defaultAgentName) {
            return null;
        }
        return this.agents.get(this.defaultAgentName) || null;
    }

    list() {
        return Array.from(this.agents.values());
    }

    clear() {
        this.agents.clear();
        this.defaultAgentName = null;
    }
}

const globalRegistry = new LLMAgentRegistry();

export {
    LLMAgentRegistry,
    globalRegistry as llmAgentRegistry,
};
