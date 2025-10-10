/*
 * Test focus: Validate the standalone LLMAgent utility layer without touching real providers.
 *
 * Scenario outline:
 *   1. Feed a mock invoker strategy and confirm every completion call is forwarded with the
 *      expected parameters.
 *   2. Exercise the markdown helper methods so we know key/value extraction, idea parsing and
 *      intent classification work in isolation.
 *   3. Drive the LLMAgentRegistry through registration, default selection, and clearing to
 *      ensure it behaves predictably when multiple agents coexist.
 *
 * Expectations:
 *   - The invoker strategy receives the exact prompts/modes the agent emits.
 *   - Markdown helpers interpret structured responses without relying on an actual LLM.
 *   - Registry bookkeeping correctly tracks named agents and handles defaults.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent, LLMAgentRegistry } from '../../LLMAgents/index.mjs';

test('LLMAgent delegates completions to the invokerStrategy', async () => {
    const calls = [];
    const agent = new LLMAgent({
        name: 'MockAgent',
        invokerStrategy: async ({ prompt, mode, agent }) => {
            calls.push({ prompt, mode, agentName: agent.name });
            return `response:${mode}`;
        },
    });

    const fast = await agent.complete({ prompt: 'Hello world', mode: 'fast' });
    assert.equal(fast, 'response:fast');

    const deep = await agent.complete({ prompt: 'Deep dive', mode: 'deep' });
    assert.equal(deep, 'response:deep');

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.mode), ['fast', 'deep']);
    assert.deepEqual(calls.map(call => call.agentName), ['MockAgent', 'MockAgent']);
});

test('LLMAgent parses markdown and classifies responses', async () => {
    const agent = new LLMAgent({
        name: 'ParserAgent',
        invokerStrategy: async ({ prompt }) => {
            if (prompt.includes('Interpret')) {
                return '- intent: update\n- updates: priority=urgent';
            }
            return '- priority: medium';
        },
    });

    const keyValues = agent.parseMarkdownKeyValues('- priority: high\n- title: Reset password');
    assert.deepEqual(keyValues, { priority: 'high', title: 'Reset password' });

    const ideas = agent.parseMarkdownIdeas('1. Idea A\n2. Idea B');
    assert.deepEqual(ideas, ['Idea A', 'Idea B']);

    const intent = agent.classifyMessage('Please cancel this request');
    assert.equal(intent.intent, 'cancel');

    const interpreted = await agent.interpretMessage('maybe set priority to urgent', { intents: ['accept', 'cancel', 'update'] });
    assert.equal(interpreted.intent, 'update');
    assert.equal(interpreted.updates.priority, 'urgent');
});

test('LLMAgentRegistry manages agents and defaults', async () => {
    const registry = new LLMAgentRegistry();
    const baseInvoker = async () => 'result';

    const agentA = registry.register({
        name: 'AgentA',
        invokerStrategy: baseInvoker,
    }, { setAsDefault: true });

    const agentB = registry.register({
        name: 'AgentB',
        invokerStrategy: async () => 'B',
    });

    assert.equal(registry.getDefault(), agentA);
    assert.equal(registry.get('AgentB'), agentB);

    registry.registerDefault({
        name: 'AgentC',
        invokerStrategy: async () => 'C',
    });
    assert.equal(registry.getDefault().name, 'AgentC');

    registry.clear();
    assert.equal(registry.list().length, 0);
});
