import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../LLMAgents/index.mjs';
import { SkilledAgent } from '../SkilledAgents/SkilledAgent.mjs';
import { chooseSkillWithLLM } from '../SkilledAgents/index.mjs';

const responsesByIntent = {
    'skill-argument-extraction': '- priority: high',
    'skill-confirmation': '- intent: accept',
    brainstorm: '1. Idea\n2. Another idea',
};

const createMockLLMAgent = () => new LLMAgent({
    name: 'MockLLM',
    invokerStrategy: async ({ context = {} }) => {
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

test('rankSkill returns confidences and chooseSkillWithLLM selects a skill', async () => {
    const llmAgent = createMockLLMAgent();
    const agent = new SkilledAgent({ llmAgent });

    const createTicketSkill = {
        specs: {
            name: 'create_ticket',
            description: 'Create a support ticket with the provided details.',
            arguments: {
                title: { description: 'Ticket title', type: 'string' },
            },
            requiredArguments: ['title'],
        },
        action: () => ({}),
        roles: ['support'],
    };

    const escalateTicketSkill = {
        specs: {
            name: 'escalate_ticket',
            description: 'Escalate an existing ticket to a higher priority queue.',
            arguments: {
                ticket_id: { description: 'Existing ticket identifier', type: 'string' },
            },
            requiredArguments: ['ticket_id'],
        },
        action: () => ({}),
        roles: ['support'],
    };

    agent.registerSkill(createTicketSkill);
    agent.registerSkill(escalateTicketSkill);

    const request = 'Please create a ticket for this issue';
    const ranked = agent.rankSkill(request, {
        roles: ['support'],
    });

    assert.ok(ranked);
    const rankedEntries = Object.entries(ranked);
    assert.ok(rankedEntries.length > 0);
    rankedEntries.forEach(([name, rank]) => {
        assert.ok(typeof name === 'string' && name.length > 0);
        assert.ok(rank >= 1 && rank <= 5);
    });

    const [topSkillName] = rankedEntries.sort((a, b) => a[1] - b[1])[0];

    let nextResponse = topSkillName;
    const chooserAgent = new LLMAgent({
        name: 'Chooser',
        invokerStrategy: async () => nextResponse,
    });

    const chosen = await chooseSkillWithLLM(ranked, {
        llmAgent: chooserAgent,
        skillRegistry: agent.skillRegistry,
        query: request,
    });
    assert.equal(chosen, topSkillName);

    nextResponse = 'none';
    const noneSelection = await chooseSkillWithLLM(ranked, {
        llmAgent: chooserAgent,
        skillRegistry: agent.skillRegistry,
        query: request,
    });
    assert.equal(noneSelection, 'none');

    const emptySelection = await chooseSkillWithLLM({}, { llmAgent: chooserAgent });
    assert.equal(emptySelection, 'none');
});

test('chooseSkillWithLLM throws when no API key is configured', async () => {
    const rankScores = { 'mock-skill': 1 };

    const invokerStrategy = async () => 'mock-skill';
    invokerStrategy.listAvailableModels = () => ({
        fast: [{
            name: 'mock-model',
            providerKey: 'openai',
            apiKeyEnv: 'OPENAI_API_KEY',
        }],
        deep: [],
    });

    const agent = new LLMAgent({
        name: 'MissingKeyAgent',
        invokerStrategy,
    });

    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
        () => chooseSkillWithLLM(rankScores, { llmAgent: agent }),
        /OPENAI_API_KEY/,
    );

    process.env.OPENAI_API_KEY = 'test-key';
    const chosen = await chooseSkillWithLLM(rankScores, { llmAgent: agent });
    assert.equal(chosen, 'mock-skill');

    if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
    } else {
        process.env.OPENAI_API_KEY = previousKey;
    }
});
