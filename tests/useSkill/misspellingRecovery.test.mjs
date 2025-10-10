/*
 * Test focus: Demonstrate that slight misspellings in enumerated inputs can still be resolved
 * via the fuzzy search performed by the skill registry.
 *
 * Scenario outline:
 *   1. We expose three warehouses via enumerator options, e.g., “Berlin Central Warehouse”.
 *   2. The agent asks for the warehouse; the user types “berlin central warehous” (missing the
 *      trailing ‘e’).
 *   3. FlexSearch matching resolves the typo to the correct option, and the agent proceeds with
 *      the technical identifier.
 *   4. The confirmation prompt speaks the clean, human-friendly label while the action receives
 *      the internal code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const warehouses = [
    { label: 'Berlin Central Warehouse', value: 'WH-DE-01' },
    { label: 'Munich Flagship Depot', value: 'WH-DE-09' },
    { label: 'Hamburg River Hub', value: 'WH-DE-12' },
];

const warehouseById = new Map(warehouses.map((entry) => [entry.value, entry.label]));

const skillConfig = {
    specs: {
        name: 'schedule_resupply',
        humanDescription: 'a resupply plan for retail warehouses',
        description: 'Identify the warehouse to restock using internal identifiers.',
        arguments: {
            target_warehouse_id: {
                type: 'string',
                description: 'Warehouse to restock',
                options: warehouses,
                presenter: (value) => warehouseById.get(value) || value,
            },
            quantity: { type: 'integer', description: 'Units to dispatch' },
        },
        requiredArguments: ['target_warehouse_id', 'quantity'],
    },
    roles: ['logistics'],
    action: (args) => args,
};

test('useSkill recovers from small misspellings in enumerated values', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'ResupplyPlanner',
        taskDescription: 'Restock the flagship stores.',
        responses: [
            'Target warehouse is berlin central warehous.',
            'Quantity should be 40.',
            'accept',
        ],
        skillConfig,
        interceptExtraction: 1,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should run once after acceptance');

    const confirmation = scenario.prompts.find((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmation, 'A confirmation prompt should be presented');
    assert.match(confirmation, /Berlin Central Warehouse/i, 'Confirmation should use the cleaned-up label');

    const result = scenario.result;
    assert.equal(result.target_warehouse_id, 'WH-DE-01');
    assert.equal(result.quantity, 40);

    const callArgs = scenario.actionCalls[0];
    assert.equal(callArgs.target_warehouse_id, 'WH-DE-01');
    assert.equal(callArgs.quantity, 40);
});
