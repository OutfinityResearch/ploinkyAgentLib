import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { LoopAgentSession } from '../../LLMAgents/LoopAgenticSession/LoopAgentSession.mjs';

function decision(tool = 'final_answer', prompt = 'done') {
    return `## tool\n${tool}\n\n## prompt\n${prompt}\n\n## reason\ntest`;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function abortError() {
    return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function createSession(complete, options = {}, tools = {}) {
    return new LoopAgentSession({
        agent: { complete },
        tools,
        options: { historyCompressionEnabled: false, ...options },
    });
}

function assertInterrupted(session, answer, controller) {
    assert.equal(answer, 'Interrupted by user');
    assert.equal(session.getLastResult(), answer);
    assert.equal(session.status, 'interrupted');
    assert.equal(session.turns.at(-1).status, 'interrupted');
    assert.equal(session.errorCount, 0);
    assert.equal(session.failedTurns.length, 0);
    assert.equal(session._currentAbortController, null);
    assert.equal(session._currentAbortSignal, null);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.ok(session.history.some((entry) => entry.event === 'interrupted'));
}

for (const reason of ['esc', '', undefined, new Error('stop')]) {
    test(`pre-aborted signal skips all work and permits reuse (${String(reason)})`, async () => {
        const controller = new AbortController();
        controller.abort(reason);
        let calls = 0;
        const session = createSession(async ({ signal }) => {
            calls += 1;
            assert.equal(signal.aborted, false);
            return decision();
        }, {
            historyCompressionEnabled: true,
            historyCompressionThresholdTokens: 1,
            historyCompressionKeepRecentEntries: 0,
            initialHistory: [{ role: 'user', message: 'Earlier request' }],
            preparation: { text: 'Prepare context' },
        });

        assertInterrupted(session, await session.newPrompt('cancelled', { signal: controller.signal }), controller);
        assert.equal(calls, 0);
        assert.equal(session.toolCalls.length, 0);
        assert.ok(session.history.some((entry) => entry.prompt === 'Earlier request'));

        session.preparation = null;
        session.options.historyCompressionEnabled = false;
        assert.equal(await session.newPrompt('fresh'), 'done');
        assert.equal(session.status, 'active');
        assert.equal(calls, 1);
        assert.equal(session.turns[0].status, 'interrupted');
    });
}

test('abort during the initial setup await cannot be reset by starting the turn', async () => {
    const controller = new AbortController();
    let calls = 0;
    const session = createSession(async () => { calls += 1; return decision(); });
    const run = session.newPrompt('cancel before planner', { signal: controller.signal });
    controller.abort('esc');
    assertInterrupted(session, await run, controller);
    assert.equal(calls, 0);
});

for (const rejects of [false, true]) {
    test(`abort during compression preserves history and settles normally (rejects=${rejects})`, async () => {
        const controller = new AbortController();
        const entered = deferred();
        const release = deferred();
        const calls = [];
        const session = createSession(async ({ signal, context }) => {
            calls.push(context.intent);
            entered.resolve(signal);
            await release.promise;
            if (rejects) throw abortError();
            return '## summary\nLate summary\n\n## keepResultRefs\n';
        }, {
            historyCompressionEnabled: true,
            historyCompressionThresholdTokens: 1,
            historyCompressionKeepRecentEntries: 0,
            initialHistory: [{ role: 'user', message: 'Keep this history' }],
        });
        const run = session.newPrompt('compress', { signal: controller.signal });
        const signal = await entered.promise;
        controller.abort('esc');
        assert.equal(signal.aborted, true);
        release.resolve();
        assertInterrupted(session, await run, controller);
        assert.deepEqual(calls, ['agentic-session-history-compression']);
        assert.ok(session.history.some((entry) => entry.prompt === 'Keep this history'));
        assert.ok(!session.history.some((entry) => entry.type === 'history_summary'));
    });

    test(`abort during preparation reaches the child and starts no parent planner (rejects=${rejects})`, async () => {
        const controller = new AbortController();
        const entered = deferred();
        const release = deferred();
        let calls = 0;
        const session = createSession(async ({ signal }) => {
            calls += 1;
            if (calls > 1) return decision();
            entered.resolve(signal);
            await release.promise;
            if (rejects) throw abortError();
            return decision('final_answer', '@context_late: must not be injected');
        }, { preparation: { text: 'Prepare context', retries: 3 } });
        const run = session.newPrompt('prepare', { signal: controller.signal });
        const signal = await entered.promise;
        controller.abort('esc');
        release.resolve();
        assertInterrupted(session, await run, controller);
        assert.equal(signal.aborted, true);
        assert.equal(calls, 1);
        assert.equal(session.systemPrompt, session.baseSystemPrompt);
        assert.equal(getEventListeners(signal, 'abort').length, 0);
    });
}

test('standalone preparation honours a pre-aborted signal without retrying model work', async () => {
    const controller = new AbortController();
    controller.abort('esc');
    let calls = 0;
    await assert.rejects(LoopAgentSession.runPreparation({
        agent: { complete: async () => { calls += 1; return decision(); } },
        tools: {},
        options: { signal: controller.signal },
        preparationText: 'Prepare context',
        userPrompt: 'work',
        retries: 3,
    }), { name: 'AbortError' });
    assert.equal(calls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const boundary of ['planner', 'approval', 'output', 'tool']) {
    test(`in-flight cancellation at ${boundary} prevents subsequent work`, async () => {
        const controller = new AbortController();
        const entered = deferred();
        const release = deferred();
        let seenSignal;
        let plannerCalls = 0;
        let toolCalls = 0;
        const wait = async () => { entered.resolve(); await release.promise; };
        const session = createSession(async ({ signal }) => {
            plannerCalls += 1;
            seenSignal = signal;
            if (boundary === 'planner') await wait();
            return decision('work');
        }, {
            supervisor: {
                approve: async () => {
                    if (boundary === 'approval') await wait();
                    return 'approve';
                },
                getOutputWriter: () => ({
                    write: async (message) => {
                        if (boundary === 'output' && typeof message === 'string') await wait();
                    },
                }),
            },
        }, {
            work: {
                description: 'Work',
                handler: async (_agent, _prompt, { signal }) => {
                    toolCalls += 1;
                    seenSignal = signal;
                    if (boundary === 'tool') await wait();
                    return { success: true, message: 'Late success' };
                },
            },
        });
        const run = session.newPrompt('work', { signal: controller.signal });
        await entered.promise;
        controller.abort('esc');
        assert.equal(seenSignal.aborted, true);
        release.resolve();
        assertInterrupted(session, await run, controller);
        assert.equal(plannerCalls, 1);
        assert.equal(toolCalls, boundary === 'tool' ? 1 : 0);
        assert.ok(!session.history.some((entry) => entry.type === 'final_answer'));
    });
}

test('old prompt signals cannot cancel a reused session; current cancellation still works', async () => {
    const oldController = new AbortController();
    const currentController = new AbortController();
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const session = createSession(async ({ signal }) => {
        calls += 1;
        if (calls === 2) {
            entered.resolve(signal);
            await release.promise;
        }
        return decision();
    });
    await session.newPrompt('first', { signal: oldController.signal });
    assert.equal(getEventListeners(oldController.signal, 'abort').length, 0);
    const run = session.newPrompt('second', { signal: currentController.signal });
    const signal = await entered.promise;
    oldController.abort('stale');
    assert.equal(signal.aborted, false);
    assert.equal(session.status, 'running');
    currentController.abort('esc');
    release.resolve();
    assertInterrupted(session, await run, currentController);
    assert.equal(await session.newPrompt('third'), 'done');
});

test('ordinary setup failure cleans listeners and still permits a later prompt', async () => {
    const controller = new AbortController();
    const session = createSession(async () => { throw new Error('preparation failed'); }, {
        preparation: { text: 'Prepare', retries: 0 },
    });
    await assert.rejects(session.newPrompt('work', { signal: controller.signal }), /preparation failed/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(session._currentAbortSignal, null);
    session.preparation = null;
    session.agent.complete = async ({ signal }) => {
        controller.abort('stale');
        assert.equal(signal.aborted, false);
        return decision();
    };
    assert.equal(await session.newPrompt('recover'), 'done');
});

test('caller-queued cancelled work does not run or poison the following prompt', async () => {
    const queuedController = new AbortController();
    const entered = deferred();
    const release = deferred();
    const prompts = [];
    const session = createSession(async ({ prompt }) => {
        prompts.push(prompt);
        if (prompt === 'first') { entered.resolve(); await release.promise; }
        return decision();
    });
    const first = session.newPrompt('first');
    const queued = first.then(() => session.newPrompt('queued', { signal: queuedController.signal }));
    await entered.promise;
    queuedController.abort('esc');
    release.resolve();
    assert.equal(await first, 'done');
    assertInterrupted(session, await queued, queuedController);
    assert.equal(await session.newPrompt('last'), 'done');
    assert.deepEqual(prompts, ['first', 'last']);
});

test('cancellation during pending-input interpretation cannot start another planner or tool', async () => {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const session = createSession(async () => { calls += 1; return decision('work'); }, {}, {
        work: { handler: async () => ({ requiresInput: true, message: 'Need more input' }) },
    });
    assert.equal(await session.newPrompt('work'), 'Need more input');
    session.agent.interpretMessage = async (_prompt, { signal }) => {
        entered.resolve(signal);
        await release.promise;
        return { intent: 'unknown', confidence: 0 };
    };
    const run = session.newPrompt('create a fresh report', { signal: controller.signal });
    const signal = await entered.promise;
    controller.abort('esc');
    release.resolve();
    assertInterrupted(session, await run, controller);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    assert.equal(session.toolCalls.length, 1);
});

test('direct session.cancel during setup and repeated cancellation preserve reuse', async () => {
    const controller = new AbortController();
    let calls = 0;
    const session = createSession(async () => { calls += 1; return decision(); });
    const run = session.newPrompt('cancel directly', { signal: controller.signal });
    session.cancel('esc');
    session.cancel('esc');
    assertInterrupted(session, await run, controller);
    assert.equal(calls, 0);
    assert.equal(session.history.filter((entry) => entry.event === 'interrupted').length, 1);
    assert.equal(await session.newPrompt('resume'), 'done');
});

test('cooperative preparation abort rejects promptly without retrying', async () => {
    const controller = new AbortController();
    const entered = deferred();
    let calls = 0;
    const session = createSession(({ signal }) => {
        calls += 1;
        entered.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
    }, { preparation: { text: 'Prepare', retries: 10 } });
    const run = session.newPrompt('prepare', { signal: controller.signal });
    await entered.promise;
    controller.abort('esc');
    assertInterrupted(session, await run, controller);
    assert.equal(calls, 1);
});

test('repeated successful prompts detach a shared external signal after every turn', async () => {
    const controller = new AbortController();
    const session = createSession(async () => decision());
    for (let index = 0; index < 25; index += 1) {
        assert.equal(await session.newPrompt(`turn ${index}`, { signal: controller.signal }), 'done');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
    controller.abort('esc');
    assert.equal(session.status, 'active');
    assert.equal(session.lastAnswer, 'done');
});
