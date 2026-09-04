import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MainAgent } from '../../MainAgent/index.mjs';
import { LoopAgentSession } from '../../LLMAgents/LoopAgenticSession/LoopAgentSession.mjs';

test('MainAgent returns interruption on first and reused pre-aborted prompts without a vendor call', async (t) => {
    const agent = new MainAgent({ startDir: '/tmp/nonexistent-cancellation-workspace' });
    t.after(() => agent.shutdown());
    const controller = new AbortController();
    controller.abort('esc');
    let calls = 0;
    agent.llmAgent.complete = async ({ signal }) => {
        calls += 1;
        assert.equal(signal.aborted, false);
        return '## tool\nfinal_answer\n\n## prompt\nready\n\n## reason\ntest';
    };

    const interrupted = { result: 'Interrupted by user', status: 'interrupted' };
    assert.deepEqual(await agent.executePrompt('first', { signal: controller.signal }), interrupted);
    assert.equal(calls, 0);
    const session = agent._session;
    assert.ok(session instanceof LoopAgentSession);
    assert.deepEqual(await agent.executePrompt('resume'), { result: 'ready', status: 'active' });
    assert.deepEqual(await agent.executePrompt('cancel again', { signal: controller.signal }), interrupted);
    assert.equal(agent._session, session);
    assert.equal(calls, 1);
});
