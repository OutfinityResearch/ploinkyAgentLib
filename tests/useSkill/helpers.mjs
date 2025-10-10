import { LLMAgent } from '../../LLMAgents/index.mjs';
import { SkilledAgent } from '../../SkilledAgents/SkilledAgent.mjs';

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (value && typeof value === 'object') {
        const copy = {};
        for (const [key, inner] of Object.entries(value)) {
            copy[key] = cloneValue(inner);
        }
        return copy;
    }
    return value;
}

export async function runUseSkillScenario({
    agentName = 'UseSkillScenarioAgent',
    taskDescription,
    responses = [],
    skillConfig,
    interceptExtraction = false,
    manualOverrides = null,
    additionalMatchers = [],
}) {
    const llmAgent = new LLMAgent({ name: agentName });
    const workingSkillConfig = {
        ...skillConfig,
        specs: cloneValue(skillConfig.specs),
    };
    if (interceptExtraction) {
        const originalComplete = llmAgent.complete.bind(llmAgent);
        const maxIntercepts = interceptExtraction === true ? 1 : Number(interceptExtraction) || 0;
        let remainingIntercepts = maxIntercepts;
        llmAgent.complete = async (options = {}) => {
            if (remainingIntercepts > 0 && options?.context?.intent === 'skill-argument-extraction') {
                remainingIntercepts -= 1;
                return '- result: none';
            }
            return originalComplete(options);
        };

        const normalize = (value) => (value || '').toString().trim().replace(/[.!]+$/, '');
        const baseMatchers = [
            { key: 'project_code', regex: /project code (?:is|should be|set to|=)\s+([a-z0-9\- _]+)/i },
            { key: 'location', regex: /location (?:is|should be|set to|=)\s+([a-z0-9\- _]+)/i },
            { key: 'start_date', regex: /start(?: date)? (?:is|should be|set to|on|=)\s+([a-z0-9\- ,]+)/i },
            { key: 'start_date', regex: /we start on\s+([a-z0-9\- ,]+)/i },
            { key: 'end_date', regex: /end(?: date)? (?:is|should be|set to|on|=)\s+([a-z0-9\- ,]+)/i },
            { key: 'end_date', regex: /wrap(?: up)?(?: on)?\s+([a-z0-9\- ,]+)/i },
            { key: 'supervisor', regex: /supervisor (?:is|should be|set to|=|make)\s+([a-z0-9\- ']+)(?:(?:\sand)|$)/i },
            { key: 'backup_supervisor', regex: /backup supervisor (?:is|should be|set to|=|add)\s+([a-z0-9\- ']+)/i },
            { key: 'priority', regex: /priority (?:is|should be|set to|=)\s+([a-z0-9\- ]+)/i },
            { key: 'region_code', regex: /region(?: code)? (?:is|should be|set to|=)\s+([a-z0-9\- ]+)/i },
            { key: 'region_code', regex: /region should be\s+([a-z0-9\- ]+)/i },
            { key: 'quantity', regex: /(?:quantity|units|need)\s*(?:is|should be|set to|=)?\s*([0-9]+)/i },
            { key: 'source_warehouse_id', regex: /source warehouse (?:is|should be|set to|=)\s+([a-z0-9\- ']+)/i },
            { key: 'destination_warehouse_id', regex: /destination(?: warehouse)? (?:is|should be|set to|=)\s+([a-z0-9\- ']+)/i },
            { key: 'destination_warehouse_id', regex: /destination should be\s+([a-z0-9\- ']+)/i },
            { key: 'sku_id', regex: /(?:sku|item|product) (?:is|should be|set to|=)\s+([a-z0-9\- ']+)/i },
            { key: 'sku_id', regex: /transfer the\s+([a-z0-9\- ']+)/i },
        ];
        const matchers = [...baseMatchers, ...additionalMatchers];

        llmAgent.interpretMessage = async (message) => {
            if (!message || typeof message !== 'string') {
                return { intent: 'unknown' };
            }
            const lower = message.toLowerCase();
            if (lower.includes('cancel')) {
                return { intent: 'cancel' };
            }
            if (lower.includes('accept')) {
                return { intent: 'accept' };
            }

            const updates = {};
            for (const { key, regex } of matchers) {
                const match = message.match(regex);
                if (match && match[1]) {
                    updates[key] = normalize(match[1]);
                }
            }

            if (Object.keys(updates).length) {
                return { intent: 'update', updates };
            }

            return { intent: 'unknown' };
        };
    }
    const consoleLog = console.log;
    const capturedLogs = [];
    const prompts = [];
    const transcript = [];
    const actionCalls = [];

    console.log = (...args) => {
        capturedLogs.push(args.join(' '));
    };

    const replies = Array.isArray(responses) ? responses.slice() : [];

    const promptReader = async (message) => {
        prompts.push(message);
        const reply = replies.length ? replies.shift() : '';
        transcript.push({ prompt: message, reply });
        return reply;
    };

    const agent = new SkilledAgent({
        llmAgent,
        promptReader,
    });

    if (manualOverrides && typeof manualOverrides === 'function') {
        manualOverrides({
            agent,
            skillConfig: workingSkillConfig.specs,
        });
    }

    const skill = {
        ...workingSkillConfig,
        action: (...args) => {
            const result = typeof workingSkillConfig.action === 'function'
                ? workingSkillConfig.action(...args)
                : (args.length === 1 ? args[0] : args);
            actionCalls.push(result);
            return result;
        },
    };

    agent.registerSkill(skill);

    let result;
    let error;
    try {
        result = await agent.useSkill(skill.specs.name, { taskDescription });
    } catch (err) {
        error = err;
    } finally {
        console.log = consoleLog;
    }

    return {
        llmAgent,
        result,
        error,
        logs: capturedLogs,
        prompts,
        transcript,
        actionCalls,
        remainingResponses: replies,
    };
}
