/*
 * Test focus: Smoke-test rankSkill against the auto-configured default LLM instance.
 *
 * Scenario outline:
 *   1. Use the real provider configuration (via envAutoConfig) so the default agent can talk
 *      to whichever LLM is configured.
 *   2. Ask the SkilledAgent to rank skills for the cue "help".
 *   3. Inspect the returned scoring map and confirm the “show-help” skill appears as one of
 *      the candidates.
 *
 * Expectations:
 *   - rankSkill succeeds with live model metadata (no mocks involved).
 *   - The help skill is surfaced with a non-zero confidence score, demonstrating the search
 *     index and ranking pipeline are wired up correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../LLMAgents/index.mjs';
import registerSkills from './helpers/initializeSkills.mjs';

function createAutoConfiguredAgent() {
    const llmAgent = new LLMAgent({ name: 'AutoConfiguredRankingAgent' });
    return registerSkills(llmAgent);
}

test('rankSkill highlights the help skill for a help query', async () => {
    const agent = createAutoConfiguredAgent();
    const ranked = agent.rankSkill('help', {
        limit: 5,
        roles: ['Admin', 'ProjectManager', 'SystemAdmin', 'Storeman', 'SPC', 'Viewer'],
    });

    assert.ok(ranked, 'rankSkill should return a result map');
    assert.ok(Object.prototype.hasOwnProperty.call(ranked, 'show-help'), 'rankSkill should surface the help skill');
    assert.ok(ranked['show-help'] >= 1, 'help skill should have a confidence score');
});
