/*
 * Test focus: Demonstrate that enumerator prompts sample a long option list while still
 * accepting user input that references unsampled entries.
 *
 * Scenario outline:
 *   1. Register an enumerated argument with twelve possible distribution centers.
 *   2. The agent prompts the user; only the first ten centers should appear alongside an
 *      ellipsis to hint at additional options.
 *   3. The user chooses “Center 11”, which was not explicitly listed in the prompt.
 *   4. The skill proceeds, resolving the human-friendly label to the technical ID.
 *
 * Expectations:
 *   - Prompt text includes ten centers followed by “...” instead of dumping the entire list.
 *   - The final confirmation repeats the friendly name (“Center 11”).
 *   - The stored result and invoked payload use the ID `DC-11`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const centers = Array.from({ length: 12 }, (_, index) => ({
    label: `Center ${index + 1}`,
    value: `DC-${index + 1}`,
}));

const centerByValue = new Map(centers.map((entry) => [entry.value, entry.label]));

const skillConfig = {
    specs: {
        name: 'assign_distribution_region',
        humanDescription: 'a distribution region assignment for logistics',
        description: 'Select an operational region using internal identifiers.',
        arguments: {
            region_code: {
                type: 'string',
                description: 'Operational region for distribution',
                options: centers,
                presenter: (value) => centerByValue.get(value) || value,
            },
        },
        requiredArguments: ['region_code'],
    },
    roles: ['logistics'],
    action: (args) => args,
};

test('useSkill samples at most ten options yet accepts deeper catalog values', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'RegionPlanner',
        taskDescription: 'Route resupply batches to the correct operations center.',
        responses: [
            'Region should be Center 11.',
            'accept',
        ],
        skillConfig,
        interceptExtraction: 1,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should trigger once after acceptance');

    const combinedLogs = scenario.logs.join('\n');
    assert.match(combinedLogs, /For example: Center 1, Center 2, Center 3, Center 4, Center 5, Center 6, Center 7, Center 8, Center 9, Center 10, \.\.\./);
    assert.doesNotMatch(combinedLogs, /Center 11\b/);

    const confirmationPrompt = scenario.prompts.find((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmationPrompt, 'A confirmation prompt should be presented');
    assert.match(confirmationPrompt, /Center 11/i, 'Confirmation should display the human-friendly center name');

    assert.equal(scenario.result, 'DC-11', 'useSkill should resolve the technical value');

    const invokedValue = scenario.actionCalls[0];
    assert.equal(invokedValue, 'DC-11', 'Skill invocation should use the technical identifier');
});
