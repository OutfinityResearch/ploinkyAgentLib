/*
 * Test focus: Ensure chooseSkillWithLLM consults the LLM even when ranking returns a single
 * candidate, using the default (real) agent configuration.
 *
 * Scenario outline:
 *   1. Rank skills for a specific project query and capture the single best match.
 *   2. Instantiate the same SkilledAgent and call chooseSkillWithLLM with the ranking result.
 *   3. Track how many times the LLMAgent.complete method is invoked to prove the selector
 *      still goes through an LLM round-trip.
 *
 * Expectations:
 *   - Only one skill appears in the ranking output.
 *   - chooseSkillWithLLM returns that skill name.
 *   - The LLMAgent records at least one completion invocation during the selection step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from '../LLMAgents/index.mjs';
import registerSkills from './helpers/initializeSkills.mjs';

class TrackingLLMAgent extends LLMAgent {
    constructor(options) {
        super(options);
        this.completionCount = 0;
    }

    async complete(options) {
        this.completionCount += 1;
        return super.complete(options);
    }
}

test('chooseSkillWithLLM consults the LLM even when a single skill is ranked', async () => {
    const llmAgent = new TrackingLLMAgent({ name: 'AutoConfiguredSelector' });
    const agent = registerSkills(llmAgent);

    const query = 'Create a new job record for the Nimbus client project';
    const ranked = agent.rankSkill(query, {
        limit: 1,
        roles: ['Admin', 'ProjectManager'],
    });

    const rankedNames = Object.keys(ranked);
    assert.equal(rankedNames.length, 1, 'Expected a single ranked skill');
    const [topSkill] = rankedNames;
    assert.equal(topSkill, 'create-job', 'Top ranked skill should be create-job for this query');

    const chosen = await agent.chooseSkillWithLLM(ranked, { query });

    assert.equal(chosen, topSkill, 'LLM selection should confirm the only available skill');
    assert.equal(llmAgent.completionCount, 1, 'LLM should be invoked for the selection process');
});
