/**
 * AgentConfig - Centralized configuration for Agent feedback and logging
 * 
 * This module provides a simple way to control all user-facing feedback
 * mechanisms in the Agent library including verbose output, debug logging,
 * confirmations, and human review modes.
 */

import { Agent } from './AgentLib.mjs';

/**
 * Default feedback configuration
 */
const DEFAULT_CONFIG = {
    // Disable verbose skill ranking/selection feedback
    verbose: false,
    
    // Disable debug logging throughout the library
    debug: false,
    
    // Disable progressive display delays (0 = instant, >0 = delay in ms)
    verboseDelay: 0,
    
    // Skip confirmation prompts by default
    skipConfirmation: true,
    
    // Apply environment variables immediately
    applyToEnvironment: true,
};

/**
 * AgentConfig class - wraps Agent with feedback controls
 */
class AgentConfig {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        if (this.config.applyToEnvironment) {
            this.applyEnvironmentVariables();
        }
        
        this.agent = new Agent(config);
    }
    
    /**
     * Apply configuration to environment variables
     */
    applyEnvironmentVariables() {
        process.env.LLMAgentClient_DEBUG = this.config.debug ? 'true' : 'false';
        process.env.LLMAgentClient_VERBOSE_DELAY = String(this.config.verboseDelay);
    }
    
    /**
     * Update configuration at runtime
     */
    updateConfig(updates = {}) {
        this.config = { ...this.config, ...updates };
        
        if (this.config.applyToEnvironment) {
            this.applyEnvironmentVariables();
        }
    }
    
    /**
     * Enable all feedback (verbose mode)
     */
    enableFeedback() {
        this.updateConfig({
            verbose: true,
            debug: true,
            verboseDelay: 150,
            skipConfirmation: false,
        });
    }
    
    /**
     * Disable all feedback (silent mode)
     */
    disableFeedback() {
        this.updateConfig({
            verbose: false,
            debug: false,
            verboseDelay: 0,
            skipConfirmation: true,
        });
    }
    
    /**
     * Get current configuration
     */
    getConfig() {
        return { ...this.config };
    }
    
    // ============================================================================
    // Wrapped Agent methods with automatic feedback control
    // ============================================================================
    
    /**
     * Register a skill (pass-through)
     */
    registerSkill(skillObj) {
        return this.agent.registerSkill(skillObj);
    }
    
    /**
     * Rank skills with feedback controls applied
     */
    async rankSkill(taskDescription, options = {}) {
        const effectiveOptions = {
            verbose: this.config.verbose,
            ...options,
        };
        return this.agent.rankSkill(taskDescription, effectiveOptions);
    }
    
    /**
     * Use skill with feedback controls applied
     */
    async useSkill(skillName, providedArgs = {}, options = {}) {
        const effectiveOptions = {
            skipConfirmation: this.config.skipConfirmation,
            ...options,
        };
        return this.agent.useSkill(skillName, providedArgs, effectiveOptions);
    }
    
    /**
     * Execute a task (no human review)
     */
    async doTask(agentName, context, description, outputSchema = null, mode = 'fast', retries = 3) {
        return this.agent.doTask(agentName, context, description, outputSchema, mode, retries);
    }
    
    /**
     * Execute a task with automated review (no human feedback)
     */
    async doTaskWithReview(agentName, context, description, outputSchema = null, mode = 'deep', maxIterations = 5) {
        return this.agent.doTaskWithReview(agentName, context, description, outputSchema, mode, maxIterations);
    }
    
    /**
     * Execute a task with human review (always shows feedback)
     * Note: This method inherently requires user interaction
     */
    async doTaskWithHumanReview(agentName, context, description, outputSchema = null, mode = 'deep') {
        return this.agent.doTaskWithHumanReview(agentName, context, description, outputSchema, mode);
    }
    
    /**
     * List skills for a role (pass-through)
     */
    listSkillsForRole(role) {
        return this.agent.listSkillsForRole(role);
    }
    
    /**
     * Get a skill by name (pass-through)
     */
    getSkill(skillName) {
        return this.agent.getSkill(skillName);
    }
    
    /**
     * Get skill action (pass-through)
     */
    getSkillAction(skillName) {
        return this.agent.getSkillAction(skillName);
    }
    
    /**
     * Clear all skills (pass-through)
     */
    clearSkills() {
        return this.agent.clearSkills();
    }
    
    /**
     * Register LLM agent (pass-through)
     */
    registerLLMAgent(options = {}) {
        return this.agent.registerLLMAgent(options);
    }
    
    /**
     * Register default LLM agent (pass-through)
     */
    registerDefaultLLMAgent(options = {}) {
        return this.agent.registerDefaultLLMAgent(options);
    }
    
    /**
     * Cancel tasks (pass-through)
     */
    cancelTasks() {
        return this.agent.cancelTasks();
    }
    
    /**
     * Brainstorm question (pass-through)
     */
    async brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria = null) {
        return this.agent.brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria);
    }
    
    /**
     * Access underlying Agent instance if needed
     */
    getAgent() {
        return this.agent;
    }
}

/**
 * Create a configured Agent with feedback disabled (silent mode)
 */
export function createSilentAgent(options = {}) {
    return new AgentConfig({
        verbose: false,
        debug: false,
        verboseDelay: 0,
        skipConfirmation: true,
        applyToEnvironment: true,
        ...options,
    });
}

/**
 * Create a configured Agent with feedback enabled (verbose mode)
 */
export function createVerboseAgent(options = {}) {
    return new AgentConfig({
        verbose: true,
        debug: true,
        verboseDelay: 150,
        skipConfirmation: false,
        applyToEnvironment: true,
        ...options,
    });
}

/**
 * Create a configured Agent with custom settings
 */
export function createConfiguredAgent(config = {}) {
    return new AgentConfig(config);
}

/**
 * Global feedback control (affects all agents)
 */
export function setGlobalFeedback(enabled = false) {
    process.env.LLMAgentClient_DEBUG = enabled ? 'true' : 'false';
    process.env.LLMAgentClient_VERBOSE_DELAY = enabled ? '150' : '0';
}

export { AgentConfig };
export default AgentConfig;
