/*
 * Test focus: Walk through an incident-reporting flow where the agent must repeatedly ask for
 * missing information until all required arguments are supplied.
 *
 * Scenario outline:
 *   1. The agent explains which details it still needs (incident title, severity, optional team).
 *   2. The user responds with each requirement in natural language: first the title, then the
 *      severity, followed by an optional assigned team.
 *   3. After collecting everything, the agent presents a business-language summary and awaits
 *      confirmation.
 *   4. The user replies “accept”, signalling that execution should proceed.
 *
 * Expectations:
 *   - The missing-details prompt references each argument using human-readable wording.
 *   - Optional fields are mentioned separately from required ones.
 *   - The confirmation narrative reiterates the gathered values without technical jargon.
 *   - The action receives exactly the resolved values (“Warehouse printer outage”, severity “high”).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUseSkillScenario } from './helpers.mjs';

const skillConfig = {
    specs: {
        name: 'file_incident',
        humanDescription: 'a support incident record for the warehouse printers',
        description: 'File a support incident so the warehouse printers can be restored.',
        arguments: {
            incident_title: { type: 'string', description: 'Short incident headline' },
            severity: {
                type: 'string',
                description: 'Incident severity level',
                enumerator: () => [
                    { label: 'Low', value: 'low' },
                    { label: 'Medium', value: 'medium' },
                    { label: 'High', value: 'high' },
                ],
            },
            assigned_team: { type: 'string', description: 'Team that will follow up on the incident' },
        },
        requiredArguments: ['incident_title', 'severity'],
    },
    action: (args) => args,
    roles: ['support'],
};

test('useSkill asks for missing parameters in business language and confirms execution summary', async () => {
    const scenario = await runUseSkillScenario({
        agentName: 'IncidentCoordinator',
        taskDescription: 'The packaging printers keep jamming and nothing gets printed.',
        responses: [
            'Incident title is Warehouse printer outage.',
            'Severity should be high.',
            'Assigned team is warehouse support.',
            'accept',
        ],
        skillConfig,
        interceptExtraction: true,
    });

    assert.ifError(scenario.error);
    assert.equal(scenario.actionCalls.length, 1, 'Action should run once after confirmation');

    const collectedText = scenario.logs.join('\n');
    const missingMessages = collectedText.match(/To continue I need the following details:/g) || [];
    assert.ok(missingMessages.length >= 1, 'Agent should surface missing details to the user');
    assert.match(collectedText, /Incident Title/i, 'Business-friendly incident title should be mentioned');
    assert.match(collectedText, /Incident severity level/i, 'Severity description should be present');
    assert.match(collectedText, /Optional details you may add: Assigned Team/i, 'Optional arguments should be suggested separately');
    assert.ok(!/skill/i.test(collectedText), 'Prompt should avoid technical terminology like "skill"');

    const confirmationPrompt = scenario.prompts.find((prompt) => prompt.includes('About to apply'));
    assert.ok(confirmationPrompt, 'Confirmation narrative should be presented before execution');
    assert.ok(confirmationPrompt.includes('a support incident record for the warehouse printers'), 'Confirmation should describe the business action');
    assert.ok(confirmationPrompt.includes('Incident Title'), 'Confirmation should list the incident title');
    assert.ok(confirmationPrompt.includes('Severity'), 'Confirmation should list severity');
    assert.ok(!/skill/i.test(confirmationPrompt), 'Confirmation should avoid the word "skill"');

    const result = scenario.result;
    assert.match(result.incident_title.toLowerCase(), /printer/, 'Result should reflect captured incident title');
    assert.equal(result.severity.toLowerCase(), 'high', 'Result should retain the stated severity');
});
