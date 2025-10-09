import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../LLMAgents/index.mjs';
import { SkilledAgent } from '../SkilledAgents/SkilledAgent.mjs';

const responsesByIntent = {
    'skill-argument-extraction': '- priority: high',
    'skill-confirmation': '- intent: accept',
    brainstorm: '1. Idea\n2. Another idea',
};

const createMockLLMAgent = () => new LLMAgent({
    name: 'MockLLM',
    fastModel: 'mock-fast',
    deepModel: 'mock-deep',
    invoker: async ({ context = {} }) => {
        if (context.intent && responsesByIntent[context.intent]) {
            return responsesByIntent[context.intent];
        }
        return 'mock-response';
    },
});

test('SkilledAgent executes a skill using LLMAgent assistance', async () => {
    const llmAgent = createMockLLMAgent();
    const prompts = ['accept'];
    const agent = new SkilledAgent({
        llmAgent,
        promptReader: async () => prompts.shift() || 'accept',
    });

    const actionCalls = [];

    agent.registerSkill({
        specs: {
            name: 'create_ticket',
            description: 'Create a support ticket',
            argumentOrder: ['title', 'priority'],
            arguments: {
                title: { description: 'Ticket title', type: 'string' },
                priority: {
                    description: 'Ticket priority',
                    type: 'string',
                    enumerator: () => [
                        { label: 'low', value: 'low' },
                        { label: 'medium', value: 'medium' },
                        { label: 'high', value: 'high' },
                    ],
                    presenter: (value) => value.toUpperCase(),
                },
            },
            requiredArguments: ['title', 'priority'],
        },
        action: ({ title, priority }) => {
            actionCalls.push({ title, priority });
            return { title, priority };
        },
        roles: ['support'],
    });

    const result = await agent.useSkill('create_ticket', {
        args: { title: 'Printer issue' },
        taskDescription: 'Create a ticket with high priority',
    });

    assert.equal(result.title, 'Printer issue');
    assert.equal(result.priority, 'high');
    assert.equal(actionCalls.length, 1);
});
