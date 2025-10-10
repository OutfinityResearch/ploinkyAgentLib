/*
 * Test focus: Allow the user to change their mind about previously supplied values while also
 * introducing new information in the same reply.
 *
 * Scenario outline:
 *   1. The user steps through a rotation-planning dialogue providing project code, location,
 *      start/end dates, and an initial supervisor.
 *   2. Later, the user says “Actually make supervisor Alex Smith and add backup supervisor
 *      Jordan Lee.” — this single message should both replace the old supervisor and add a new
 *      backup supervisor parameter.
 *   3. The agent regenerates its confirmation summary to reflect the revised leadership team
 *      before final acceptance.
 *
 * Expectations:
 *   - Earlier confirmation prompts reference the original supervisor (Maria Gomez).
 *   - A subsequent confirmation prompt references the updated supervisor plus the new backup.
 *   - The executed payload includes the updated supervisor, backup supervisor, and the latest
 *     priority value shared before acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const skillConfig = {
    specs: {
        name: 'schedule_project_rotation',
        humanDescription: 'a project rotation schedule for the engineering team',
        description: 'Schedule a rotation, capturing timing and leadership.',
        arguments: {
            project_code: { type: 'string', description: 'Internal project identifier' },
            location: { type: 'string', description: 'Primary office location' },
            start_date: { type: 'string', description: 'Rotation start date' },
            end_date: { type: 'string', description: 'Rotation end date' },
            supervisor: { type: 'string', description: 'Primary supervisor overseeing the rotation' },
            backup_supervisor: { type: 'string', description: 'Backup supervisor for coverage' },
            priority: {
                type: 'string',
                description: 'Urgency level for the rotation',
                enumerator: () => [
                    { label: 'Low', value: 'low' },
                    { label: 'Medium', value: 'medium' },
                    { label: 'High', value: 'high' },
                ],
            },
        },
        requiredArguments: ['project_code', 'location', 'start_date', 'end_date', 'supervisor'],
    },
    action: (args) => args,
    roles: ['operations'],
};

test('useSkill allows users to revise a prior parameter while adding a new one', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'RotationPlanner',
        taskDescription: 'Line up the Phoenix rotation for engineering.',
        responses: [
            'Project code is Phoenix-21.',
            'Location should be Berlin office.',
            'We start on June 3rd.',
            'We wrap up July 12th.',
            'Supervisor is Maria Gomez.',
            'Actually make supervisor Alex Smith and add backup supervisor Jordan Lee.',
            'Priority should be medium.',
            'accept',
        ],
        skillConfig,
        interceptExtraction: true,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should execute once after final confirmation');

    const prompts = scenario.prompts || [];
    const initialSummaryIndex = prompts.findIndex(prompt => /Maria Gomez/i.test(prompt));
    assert.ok(initialSummaryIndex >= 0, 'A confirmation should mention the original supervisor before changes');

    const revisedSummaryIndex = prompts.findIndex((prompt, index) => index > initialSummaryIndex && /Alex Smith/i.test(prompt));
    assert.ok(revisedSummaryIndex >= 0, 'A later confirmation should reflect the revised supervisor');

    const finalSummary = prompts[prompts.length - 1] || '';
    assert.match(finalSummary, /Alex Smith/i, 'Final summary should reflect the revised supervisor');
    assert.match(finalSummary, /Jordan Lee/i, 'Final summary should include the added backup supervisor');
    assert.match(finalSummary, /Priority: medium/i, 'Final summary should capture the priority provided at confirmation');

    const transcriptText = scenario.transcript.map(({ prompt, reply }) => `${prompt}\n${reply}`).join('\n');
    assert.match(transcriptText, /make supervisor Alex Smith/i, 'Transcript should show the user revising the supervisor');
    assert.match(transcriptText, /backup supervisor Jordan Lee/i, 'Transcript should show the user adding a backup supervisor');

    const result = scenario.result;
    assert.equal(result.project_code, 'Phoenix-21');
    assert.match((result.location || '').toLowerCase(), /berlin/, 'Location should mention Berlin');
    assert.ok(result.start_date && typeof result.start_date === 'string', 'Start date should be captured');
    assert.ok(result.end_date && typeof result.end_date === 'string', 'End date should be captured');
    assert.match(String(result.supervisor || ''), /Alex Smith/i);
    assert.match(JSON.stringify(result), /Jordan Lee/i);
    assert.equal((result.priority || '').toLowerCase(), 'medium');
});
