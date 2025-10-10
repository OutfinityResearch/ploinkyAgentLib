/*
 * Test focus: Handle a cancellation that arrives during the confirmation prompt.
 *
 * Scenario outline:
 *   1. The agent gathers all required fields for a purchase approval request.
 *   2. Just before executing, the agent summarises the action and asks the user to confirm.
 *   3. The user responds with “cancel”, indicating they no longer want to proceed.
 *
 * Expectations:
 *   - The transcript contains at least one confirmation prompt describing the business action.
 *   - Cancellation raises a dedicated error message and the skill action is never invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const skillConfig = {
    specs: {
        name: 'approve_purchase',
        humanDescription: 'a purchase approval request for operations',
        description: 'Approve a purchase so the operations team can proceed.',
        arguments: {
            item_name: { type: 'string', description: 'Item awaiting approval' },
            amount: { type: 'string', description: 'Total amount to approve' },
        },
        requiredArguments: ['item_name', 'amount'],
    },
    action: (args) => args,
    roles: ['finance'],
};

test('useSkill stops execution when the user cancels at confirmation time', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'PurchaseApprover',
        taskDescription: 'Operations needs approval to buy new barcode scanners.',
        responses: [
            'Item name is industrial barcode scanners.',
            'Amount should be 2400 USD.',
            'cancel',
        ],
        skillConfig,
        interceptExtraction: true,
    });

    assert.ok(scenario.error, 'Cancelling should surface an error');
    assert.ok(scenario.error instanceof Error || typeof scenario.error.message === 'string', 'Error should provide a message');
    assert.match(scenario.error.message, /cancelled/i, 'Error message should indicate cancellation');
    assert.equal(scenario.actionCalls.length, 0, 'Action should not execute after cancellation');

    const confirmationPrompt = scenario.prompts.find((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmationPrompt, 'Confirmation prompt should have been presented');
    assert.ok(confirmationPrompt.toLowerCase().includes('purchase approval'), 'Confirmation should frame the business operation');
});
