import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent, LLMAgentRegistry } from '../LLMAgents/index.mjs';

test('LLMAgent invokes configured models for fast and deep modes', async (t) => {
    const calls = [];
    const agent = new LLMAgent({
        name: 'MockAgent',
        fastModel: 'mock-fast',
        deepModel: 'mock-deep',
        invoker: async ({ prompt, model, mode }) => {
            calls.push({ prompt, model, mode });
            return `response:${model}`;
        },
    });

    const fast = await agent.complete({ prompt: 'Hello world', mode: 'fast' });
    assert.equal(fast, 'response:mock-fast');

    const deep = await agent.complete({ prompt: 'Deep dive', mode: 'deep' });
    assert.equal(deep, 'response:mock-deep');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, 'mock-fast');
    assert.equal(calls[1].model, 'mock-deep');
});

test('LLMAgent parses markdown and classifies responses', async () => {
    const agent = new LLMAgent({
        name: 'ParserAgent',
        fastModel: 'mock-fast',
        invoker: async ({ prompt }) => {
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

test('LLMAgentRegistry manages agents and defaults', async (t) => {
    const registry = new LLMAgentRegistry();
    const agentA = registry.register({
        name: 'AgentA',
        fastModel: 'fa',
        invoker: async () => 'A',
    }, { setAsDefault: true });
    const agentB = registry.register({
        name: 'AgentB',
        fastModel: 'fb',
        invoker: async () => 'B',
    });

    assert.equal(registry.getDefault(), agentA);
    assert.equal(registry.get('AgentB'), agentB);

    registry.registerDefault({
        name: 'AgentC',
        fastModel: 'fc',
        invoker: async () => 'C',
    });
    assert.equal(registry.getDefault().name, 'AgentC');

    registry.clear();
    assert.equal(registry.list().length, 0);
});
