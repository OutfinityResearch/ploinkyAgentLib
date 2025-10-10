/*
 * Test focus: Prove the agent can speak with the user using readable labels while translating
 * everything back to technical identifiers before invoking the skill action.
 *
 * Scenario outline:
 *   1. Load a mapping file that pairs warehouse/SKU display names with their internal IDs.
 *   2. The simulated user refers to the entities by friendly names (e.g., “Berlin Central Warehouse”).
 *   3. The manual override injects enumerator options plus presenter logic so prompts and
 *      confirmations echo the human-facing labels.
 *   4. Once the user confirms, the actual skill action should receive only the technical IDs.
 *
 * Expectations:
 *   - Missing-argument prompts and confirmation summaries mention the human-friendly labels.
 *   - The resulting payload and action invocation use the ID values from the mapping file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUseSkillScenario } from './helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mappingPath = path.join(__dirname, 'fixtures', 'inventoryMapping.json');

const mappingData = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

const skillConfig = {
    specs: {
        name: 'assign_inventory_transfer',
        humanDescription: 'an inventory transfer assignment between warehouses',
        description: 'Route inventory to the correct destination using internal identifiers.',
        arguments: {
            source_warehouse_id: { type: 'string', description: 'Origin warehouse' },
            destination_warehouse_id: { type: 'string', description: 'Destination warehouse' },
            sku_id: { type: 'string', description: 'SKU to transfer' },
            quantity: { type: 'integer', description: 'Quantity to move' },
        },
        requiredArguments: ['source_warehouse_id', 'destination_warehouse_id', 'sku_id', 'quantity'],
    },
    roles: ['logistics'],
    action: (args) => args,
};

function attachMapping({ agent, skillConfig: specs }) {
    const { sourceWarehouses, destinationWarehouses, skus } = mappingData;

    const mapSection = (entries) => ({
        idToDisplay: new Map(Object.entries(entries).map(([display, meta]) => [meta.id, display])),
        displayToId: new Map(Object.entries(entries).map(([display, meta]) => [display.toLowerCase(), meta.id])),
    });

    const sources = mapSection(sourceWarehouses);
    const destinations = mapSection(destinationWarehouses);
    const skuMap = mapSection(skus);

    const argumentConfigs = {
        source_warehouse_id: sources,
        destination_warehouse_id: destinations,
        sku_id: skuMap,
    };

    Object.entries(argumentConfigs).forEach(([key, maps]) => {
        const originalPresenter = specs.arguments[key].presenter;

        specs.arguments[key].options = Array.from(maps.idToDisplay.entries()).map(([id, display]) => ({
            label: display,
            value: id,
        }));

        specs.arguments[key].presenter = (value) => {
            const found = maps.idToDisplay.get(value);
            return found || (originalPresenter ? originalPresenter(value) : value);
        };
    });
}

test('useSkill maps between human-friendly names and technical IDs', async () => {
    const responses = [
        'Source warehouse is Berlin Central Warehouse.',
        'Destination should be Munich Flagship Store.',
        'Transfer the Skyline Display Units.',
        'We need 25 units.',
        'accept',
    ];

    const scenario = await runUseSkillScenario({
        agentName: 'InventoryCoordinator',
        taskDescription: 'Move the skyline display units from Berlin central to Munich flagship.',
        responses,
        skillConfig,
        interceptExtraction: 2,
        manualOverrides: attachMapping,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should execute once on acceptance');

    const confirmationPrompts = scenario.prompts.filter((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmationPrompts.length >= 2, 'Agent should show at least one confirmation prompt');

    confirmationPrompts.forEach((prompt) => {
        assert.match(prompt, /Berlin Central Warehouse/i, 'Confirmation should use display name for source');
        assert.match(prompt, /Munich Flagship Store/i, 'Confirmation should use display name for destination');
        assert.match(prompt, /Skyline Display Units/i, 'Confirmation should use display name for SKU');
    });

    const args = scenario.actionCalls[0];
    assert.equal(args.source_warehouse_id, mappingData.sourceWarehouses['Berlin Central Warehouse'].id);
    assert.equal(args.destination_warehouse_id, mappingData.destinationWarehouses['Munich Flagship Store'].id);
    assert.equal(args.sku_id, mappingData.skus['Skyline Display Units'].id);
    assert.equal(args.quantity, 25);
});
