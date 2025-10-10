/*
 * Test focus: Abort a useSkill session while the agent is still collecting parameters.
 *
 * Scenario outline:
 *   1. Kick off a deployment-planning skill; the agent tells the user which details are missing.
 *   2. The simulated user supplies the first two required parameters.
 *   3. Before remaining parameters are resolved, the user says “cancel”.
 *
 * Expectations:
 *   - The conversation log shows the initial business-language prompt listing missing data.
 *   - Cancellation propagates as an error mentioning the user’s intent.
 *   - No skill action executes (actionCalls remains empty).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const skillConfig = {
    specs: {
        name: 'deploy_update',
        humanDescription: 'a deployment plan for the retail point-of-sale systems',
        description: 'Coordinate deployment details before rolling out the update.',
        arguments: {
            store_group: { type: 'string', description: 'Store cluster receiving the update' },
            deployment_date: { type: 'string', description: 'Target deployment date' },
            change_window: { type: 'string', description: 'Maintenance window approval' },
        },
        requiredArguments: ['store_group', 'deployment_date'],
    },
    action: (args) => args,
    roles: ['operations'],
};

test('useSkill stops when the user cancels while clarifying parameters', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'DeploymentCoordinator',
        taskDescription: 'Prepare the POS rollout.',
        responses: [
            'Store group is East Coast flagships.',
            'Deployment date should be 3rd of next month.',
            'Actually cancel this rollout.',
        ],
        skillConfig,
        interceptExtraction: true,
    });

    assert.ok(scenario.error, 'Cancellation should propagate an error');
    assert.match(String(scenario.error?.message || scenario.error), /cancelled/i, 'Error should mention cancellation');
    assert.equal(scenario.actionCalls.length, 0, 'Action must not execute after cancellation');

    const combinedText = [
        scenario.logs.join('\n'),
        ...scenario.prompts,
    ].join('\n');
    assert.match(combinedText, /To continue I need the following details:/, 'Agent should still surface missing details before cancellation');
    assert.match(combinedText, /Maintenance window approval/i, 'Business language describing optional parameters should be present');
});
