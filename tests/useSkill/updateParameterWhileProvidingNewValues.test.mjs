/*
 * Test focus: Capture the case where the user tweaks an existing value and supplies an extra
 * piece of information in the same sentence.
 *
 * Scenario outline:
 *   1. The agent first gathers machine name and an initial priority.
 *   2. The user provides window start and window end in separate messages.
 *   3. In a single follow-up reply, the user says “Actually set priority to medium, keep window
 *      start June 3rd, and set window end to July 12th.”
 *   4. The agent regenerates its confirmation summary to show the updated priority plus both
 *      window boundaries before executing the maintenance task.
 *
 * Expectations:
 *   - Earlier summaries show the original priority (“high”).
 *   - The final summary presents the revised priority (“medium”) and both dates.
 *   - The executed payload reflects the updated priority and the retained window start/end values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const skillConfig = {
    specs: {
        name: 'schedule_maintenance',
        humanDescription: 'a maintenance task for factory equipment',
        description: 'Schedule preventative maintenance for factory assets.',
        arguments: {
            machine_name: { type: 'string', description: 'Equipment needing service' },
            window_start: { type: 'string', description: 'When the work should start' },
            window_end: { type: 'string', description: 'When the maintenance window should close' },
            priority: {
                type: 'string',
                description: 'Maintenance priority',
                enumerator: () => [
                    { label: 'Low', value: 'low' },
                    { label: 'Medium', value: 'medium' },
                    { label: 'High', value: 'high' },
                ],
            },
        },
        requiredArguments: ['machine_name', 'priority'],
    },
    action: (args) => args,
    roles: ['maintenance'],
};

test('useSkill applies updates while adding new values in the same reply', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'MaintenancePlanner',
        taskDescription: 'Please line up service for the conveyor belt this week.',
        responses: [
            'Machine name is the primary conveyor belt.',
            'Priority should be high.',
            'window start is June 3rd.',
            'Actually set priority to medium, keep window start June 3rd, and set window end to July 12th.',
            'accept',
        ],
        skillConfig,
        interceptExtraction: true,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should execute once after acceptance');

    const confirmationPrompts = scenario.prompts.filter((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmationPrompts.length >= 2, 'Agent should refresh the summary after the user amends parameters');

    const revisedPrompt = confirmationPrompts.find((prompt) => prompt.toLowerCase().includes('priority: medium'));
    assert.ok(revisedPrompt, 'Revised summary should include the updated priority value');
    assert.match(revisedPrompt, /Window Start: June 3rd/i, 'Revised summary should retain the previously supplied window start');
    assert.match(revisedPrompt, /Window End: July 12th/i, 'Revised summary should include the provided window end');

    const transcriptText = scenario.transcript.map(({ reply }) => reply).join('\n');
    assert.match(transcriptText, /set priority to medium/i, 'Transcript should show the user revising the original priority');
    assert.match(transcriptText, /keep window start June 3rd/i, 'Transcript should show the user reinforcing an existing parameter');

    const result = scenario.result;
    assert.equal((result.priority || '').toLowerCase(), 'medium', 'Execution should honour the revised priority');
    assert.match((result.window_start || '').toLowerCase(), /june 3/, 'Window start should retain the earlier value');
    assert.match((result.window_end || '').toLowerCase(), /july 12/, 'Window end should match the newly supplied value');
    assert.match((result.machine_name || '').toLowerCase(), /conveyor/, 'Machine name should reflect initial user input');
});
