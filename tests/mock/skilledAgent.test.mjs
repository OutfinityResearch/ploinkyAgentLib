/*
 * Test focus: Exercise SkilledAgent behaviour with fully mocked LLMs so we can control every
 * interaction deterministically.
 *
 * Scenario outline:
 *   1. Register a skill and confirm the agent can execute it end-to-end, collecting arguments
 *      via scripted prompts.
 *   2. Rank multiple skills using a fabricated request and ensure the ranking output is sane.
 *   3. Call chooseSkillWithLLM twice: once where the LLM selects the best-ranked skill and
 *      once where it explicitly returns "none".
 *   4. Simulate an LLM that advertises models without API keys and verify the guard rails
 *      reject the selection attempt with a descriptive error.
 *
 * Expectations:
 *   - All console interactions come from the synthetic prompt reader rather than a real user.
 *   - chooseSkillWithLLM respects the mock invoker’s responses.
 *   - Missing API keys bubble up as actionable errors instead of silent failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../../LLMAgents/index.mjs';
import { SkilledAgent } from '../../SkilledAgents/SkilledAgent.mjs';

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

test('rankSkill returns confidences for registered skills', async () => {
    const llmAgent = createMockLLMAgent();
    const agent = new SkilledAgent({ llmAgent });

    agent.registerSkill({
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
    });

    agent.registerSkill({
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
    });

    const ranked = agent.rankSkill('Please create a ticket for this issue', {
        roles: ['support'],
    });

    assert.ok(ranked);
    const rankedEntries = Object.entries(ranked);
    assert.ok(rankedEntries.length > 0);
    rankedEntries.forEach(([name, rank]) => {
        assert.ok(typeof name === 'string' && name.length > 0);
        assert.ok(rank >= 1 && rank <= 5);
    });
});

test('chooseSkillWithLLM selects a skill using ranked results', async () => {
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
    const ranked = agent.rankSkill(request, { roles: ['support'] });

    const rankedEntries = Object.entries(ranked);
    const [topSkillName] = rankedEntries.sort((a, b) => a[1] - b[1])[0];

    const chooserStrategy = async () => topSkillName;
    chooserStrategy.listAvailableModels = () => ({ fast: [], deep: [] });

    const chooserAgent = new LLMAgent({
        name: 'Chooser',
        invokerStrategy: chooserStrategy,
    });
    const chooser = new SkilledAgent({
        llmAgent: chooserAgent,
        skillRegistry: agent.skillRegistry,
    });
    const chosen = await chooser.chooseSkillWithLLM(ranked, { query: request });

    assert.equal(chosen, topSkillName);

    const noneChooserAgent = new LLMAgent({
        name: 'NoneChooser',
        invokerStrategy: Object.assign(async () => 'none', {
            listAvailableModels: () => ({ fast: [], deep: [] }),
        }),
    });
    const noneChooser = new SkilledAgent({
        llmAgent: noneChooserAgent,
        skillRegistry: agent.skillRegistry,
    });
    const noneSelection = await noneChooser.chooseSkillWithLLM(ranked, { query: request });

    assert.equal(noneSelection, 'none');
});

test('chooseSkillWithLLM throws when no API key is configured for the agent', async () => {
    const rankScores = { 'mock-skill': 1 };

    const invokerStrategy = async () => 'mock-skill';
    invokerStrategy.listAvailableModels = () => ({
        fast: [{
            name: 'mock-model',
            providerKey: 'openai',
            apiKeyEnv: '__PLOINKY_MISSING_API_KEY__',
        }],
        deep: [],
    });

    const selectionAgent = new SkilledAgent({
        llmAgent: new LLMAgent({
            name: 'MissingKeyAgent',
            invokerStrategy,
        }),
    });
    selectionAgent.registerSkill({
        specs: {
            name: 'mock-skill',
            description: 'Mock selection skill',
            arguments: {},
            requiredArguments: [],
        },
        roles: ['test'],
        action: () => ({}),
    });
    await assert.rejects(
        () => selectionAgent.chooseSkillWithLLM(rankScores),
        /__PLOINKY_MISSING_API_KEY__/,
    );
});
