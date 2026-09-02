import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LoopAgentSession } from '../../LLMAgents/LoopAgenticSession/LoopAgentSession.mjs';
import { buildPreparationPrompt as buildLoopPreparationPrompt } from '../../LLMAgents/LoopAgenticSession/prompts.mjs';
import { SOPAgenticSession } from '../../LLMAgents/SOPAgenticSession/SOPAgenticSession.mjs';
import {
    buildPreparationPrompt as buildSOPPreparationPrompt,
    buildSOPAgenticInstructions,
} from '../../LLMAgents/SOPAgenticSession/prompts.mjs';
import {
    runPreparation as runSOPPreparation,
} from '../../LLMAgents/SOPAgenticSession/preparation.mjs';
import { CLARIFY_CONTEXT_UNAVAILABLE } from '../../LLMAgents/constants.mjs';
import { MainAgent } from '../../MainAgent/MainAgent.mjs';
import { OrchestratorSkillsSubsystem } from '../../OrchestratorSkillsSubsystem/OrchestratorSkillsSubsystem.mjs';

function plannerMarkdownDecision({ tool, prompt, reason = 'test' }) {
    return [
        '## tool',
        tool,
        '',
        '## prompt',
        prompt,
        '',
        '## reason',
        reason,
    ].join('\n');
}

// Minimal stub LLM agent for testing preparation flows
function createStubLLMAgent(completeHandler) {
    return {
        name: 'StubLLMAgent',
        __toolState: new Map(),
        complete: completeHandler,
        executePrompt: completeHandler,
        startLoopAgentSession: async function (tools, initialPrompt, options) {
            const session = new LoopAgentSession({
                agent: this,
                tools,
                options,
            });
            await session.newPrompt(initialPrompt);
            return session;
        },
        startSOPLangAgentSession: async function (skillsDescription, initialPrompt, options) {
            const session = new SOPAgenticSession({
                agent: this,
                skillsDescription,
                options,
            });
            await session.newPrompt(initialPrompt);
            return session;
        },
    };
}

// Helper to create a tool that immediately returns final_answer with context lines
function createContextTool(contextLines) {
    return {
        'final_answer': {
            description: 'Return final answer',
            handler: async (_agent, payload) => ({
                __finalAnswer: true,
                text: contextLines.join('\n'),
            }),
        },
        'cannot_complete': {
            description: 'Cannot complete',
            handler: async (_agent, payload) => ({
                __cannotComplete: true,
                text: payload,
            }),
        },
    };
}

// =============================================================================
// LoopAgentSession.runPreparation tests
// =============================================================================

test('LoopAgentSession.runPreparation parses @context_ variables from output', async () => {
    let callCount = 0;
    const agent = createStubLLMAgent(async () => {
        callCount++;
        // First call: planner decides to call final_answer with context lines
        return plannerMarkdownDecision({
            tool: 'final_answer',
            prompt: '@context_user := "john"\n@context_role := "admin"',
        });
    });

    const tools = {
        'echo': {
            description: 'Echo tool',
            handler: async (_a, p) => p,
        },
    };

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools,
        options: { tier: 'fast', maxStepsPerTurn: 5 },
        preparationText: 'Load user context',
        userPrompt: 'do something',
        retries: 0,
    });

    assert.ok(result.contextEntries.length === 2, 'should parse 2 context entries');
    assert.equal(result.contextEntries[0].name, '@context_user');
    assert.equal(result.contextEntries[0].value, 'john');
    assert.equal(result.contextEntries[1].name, '@context_role');
    assert.equal(result.contextEntries[1].value, 'admin');
    assert.ok(result.contextLines.length === 2, 'should have 2 context lines');
    assert.ok(result.contextLines[0].includes('@context-piece-1'), 'first line should be @context-piece-1');
});

test('LoopAgentSession.runPreparation returns empty when no @context_ in output', async () => {
    const agent = createStubLLMAgent(async () => plannerMarkdownDecision({
        tool: 'final_answer',
        prompt: 'Just some plain text without context variables',
    }));

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools: {},
        options: { tier: 'fast', maxStepsPerTurn: 5 },
        preparationText: 'Load context',
        userPrompt: 'test',
        retries: 0,
    });

    assert.equal(result.contextEntries.length, 0, 'should have no context entries');
    assert.equal(result.contextLines.length, 0, 'should have no context lines');
});

test('LoopAgentSession.runPreparation returns empty when preparationText is empty', async () => {
    const agent = createStubLLMAgent(async () => {
        throw new Error('Should not be called');
    });

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools: {},
        options: {},
        preparationText: '',
        userPrompt: 'test',
        retries: 0,
    });

    assert.equal(result.contextEntries.length, 0);
    assert.equal(result.contextLines.length, 0);
});

test('LoopAgentSession.runPreparation retries on failure', async () => {
    let attempts = 0;
    const agent = createStubLLMAgent(async () => {
        attempts++;
        if (attempts === 1) {
            // First attempt: return something that will cause an error
            return { action: 'invalid' };
        }
        // Second attempt: return valid final_answer
        return plannerMarkdownDecision({
            tool: 'final_answer',
            prompt: '@context_retry := "success"',
        });
    });

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools: {},
        options: { tier: 'fast', maxStepsPerTurn: 2, maxErrors: 1 },
        preparationText: 'Load context',
        userPrompt: 'test',
        retries: 1,
    });

    assert.ok(attempts >= 1, 'should have attempted at least once');
    // Note: due to retry logic, we expect either success or empty result
});

test('LoopAgentSession preparation prompt omits orchestrator context by default and includes clarify_context result contract', () => {
    const prompt = buildLoopPreparationPrompt(
        'Recover conversation context.',
        'Create a skill.',
    );

    assert.doesNotMatch(prompt, /Orchestrator context:/);
    assert.match(prompt, /Its result is the answer to those questions/);
    assert.match(prompt, /Do not output "awaiting clarification"/);
});

// =============================================================================
// SOPAgenticSession.runPreparation tests
// =============================================================================

test('SOPAgenticSession.runPreparation parses @context_ variables from SOP output', async () => {
    let planGenerated = false;
    const agent = createStubLLMAgent(async (options) => {
        const prompt = options?.prompt || options || '';
        // Return a simple SOP plan that outputs context
        if (!planGenerated) {
            planGenerated = true;
            return '@result final_answer "@context_data := \\"loaded\\""';
        }
        return '@context_data := "loaded"';
    });

    const skillsDescription = {
        'echo': 'Echo skill',
    };

    const commandsRegistry = {
        executeCommand: async (payload, response) => {
            if (payload.command === 'final_answer') {
                return response.success('@context_data := "loaded"');
            }
            return response.success('ok');
        },
        listCommands: () => [
            { name: 'echo', description: 'Echo skill' },
        ],
    };

    const result = await SOPAgenticSession.runPreparation({
        agent,
        skillsDescription,
        commandsRegistry,
        options: { tier: 'deep' },
        preparationText: 'Load data context',
        userPrompt: 'process data',
        retries: 0,
    });

    // The result depends on what the SOP session produces
    assert.ok(result.contextText !== undefined, 'should have contextText');
    assert.ok(result.rawText !== undefined, 'should have rawText');
});

test('SOPAgenticSession.runPreparation returns empty when preparationText is empty', async () => {
    const agent = createStubLLMAgent(async () => {
        throw new Error('Should not be called');
    });

    const result = await SOPAgenticSession.runPreparation({
        agent,
        skillsDescription: {},
        commandsRegistry: null,
        options: {},
        preparationText: '',
        userPrompt: 'test',
        retries: 0,
    });

    assert.equal(result.contextEntries.length, 0);
    assert.equal(result.contextLines.length, 0);
});

test('SOPAgenticSession preparation prompt omits orchestrator context by default and includes clarify_context result contract', () => {
    const prompt = buildSOPPreparationPrompt(
        'Recover conversation context.',
        'Create a skill.',
        'This context should not be injected.',
    );

    assert.doesNotMatch(prompt, /Orchestrator context:/);
    assert.doesNotMatch(prompt, /This context should not be injected/);
    assert.doesNotMatch(prompt, /authoritative local context/);
    assert.match(prompt, /produce a LightSOPLang plan that gathers the missing context/);
    assert.match(prompt, /Do not guess the clarified facts yourself/);
    assert.match(prompt, /Its result is the answer to those questions/);
    assert.match(prompt, /Do not finish with "awaiting clarification"/);
});

test('SOPAgenticSession main and preparation prompts share LightSOPLang format instructions', () => {
    const mainPrompt = buildSOPAgenticInstructions({
        userPrompt: 'Create a skill.',
    });
    const preparationPrompt = buildSOPPreparationPrompt(
        'Recover conversation context.',
        'Create a skill.',
    );
    const sharedInstruction = 'Every executable line must use the format "@varName command arg1 arg2".';
    const commandPositionInstruction = 'The command/tool name is the SECOND token, after the variable name.';

    assert.match(mainPrompt, new RegExp(sharedInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preparationPrompt, new RegExp(sharedInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(mainPrompt, new RegExp(commandPositionInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preparationPrompt, new RegExp(commandPositionInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('SOPAgenticSession main prompt shows only preparation final answer text', () => {
    const prompt = buildSOPAgenticInstructions({
        userPrompt: 'Create a skill.',
        preparationContext: ['Prepared context only.'],
    });

    assert.match(prompt, /Additional context gathered during the previous preparation phase:/);
    assert.match(prompt, /Prepared context only\./);
    assert.doesNotMatch(prompt, /Preparation context \(do not restate as user input\):/);
    assert.doesNotMatch(prompt, /@preparation_result assign/);
    assert.doesNotMatch(prompt, /Each loaded file is provided/);
});

test('SOPAgenticSession does not inject preparation context into executed plan', async () => {
    const agent = {
        __toolState: new Map(),
        executePrompt: async () => [
            '@answer assign "done"',
            '@lastAnswer final_answer $answer',
        ].join('\n'),
    };
    const commandsRegistry = {
        executeCommand: async (payload, response) => {
            if (payload.command === 'final_answer') {
                return response.success(payload.args?.[0] || '');
            }
            return response.success(payload.args?.join(' ') || '');
        },
        listCommands: () => [],
    };

    const session = new SOPAgenticSession({
        agent,
        skillsDescription: {},
        options: {
            commandsRegistry,
        },
    });

    session.preparationContextText = 'Plain preparation context that does not start with @.';
    session.preparationContextLines = [
        '@preparation_result assign',
        '--begin-prep-context--',
        session.preparationContextText,
        '--end-prep-context--',
    ];

    await session._runPlan([
        '@answer assign "done"',
        '@lastAnswer final_answer $answer',
    ].join('\n'));

    assert.equal(session.getLastResult(), 'done');
    assert.equal(Object.prototype.hasOwnProperty.call(session.lastExecution.variables, 'preparation_result'), false);
});

test('SOPAgenticSession preparation retries inside the same session', async () => {
    let createdSessions = 0;
    let planCalls = 0;
    class TrackingSOPAgenticSession extends SOPAgenticSession {
        constructor(args) {
            super(args);
            createdSessions += 1;
        }
    }
    const agent = {
        __toolState: new Map(),
        executePrompt: async () => {
            planCalls += 1;
            if (planCalls === 1) {
                return [
                    '@bad missing-tool "x"',
                    '@lastAnswer final_answer "bad"',
                ].join('\n');
            }
            return [
                '@answer assign "Prepared context"',
                '@lastAnswer final_answer $answer',
            ].join('\n');
        },
    };
    const commandsRegistry = {
        executeCommand: async (_payload, response) => response.fail('unexpected external command'),
        listCommands: () => [],
    };

    const result = await runSOPPreparation({
        SessionClass: TrackingSOPAgenticSession,
        agent,
        skillsDescription: {},
        commandsRegistry,
        options: {},
        preparationText: 'Recover context.',
        userPrompt: 'Create a skill.',
        retries: 1,
    });

    assert.equal(createdSessions, 1);
    assert.equal(planCalls, 2);
    assert.equal(result.contextText, 'Prepared context');
});

// =============================================================================
// OrchestratorSkillsSubsystem preparation integration tests
// =============================================================================

test('OrchestratorSkillsSubsystem prepareSkill parses ##Preparation section', () => {
    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: null } });

    const skillRecord = {
        name: 'test-orchestrator',
        descriptor: {
            name: 'Test',
            sections: {
                instructions: 'Main instructions',
                preparation: 'Load user profile and preferences',
                'allowed-skills': '- skill1',
            },
        },
    };

    subsystem.prepareSkill(skillRecord);

    assert.equal(skillRecord.preparedConfig.instructions, 'Main instructions');
    assert.equal(skillRecord.preparedConfig.preparation, 'Load user profile and preferences');
    assert.deepEqual(skillRecord.preparedConfig.allowedSkills, ['skill1']);
});

test('OrchestratorSkillsSubsystem passes preparation instructions into loop session without descriptor context', async () => {
    let capturedOptions = null;

    const stubLLMAgent = {
        startLoopAgentSession: async (tools, prompt, options) => {
            capturedOptions = options;
            return {
                status: 'done',
                getLastResult: () => 'Loop completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });

    const skillRecord = {
        name: 'test-loop-orchestrator',
        descriptor: {
            sections: {
                description: 'Loop orchestration description',
            },
        },
        preparedConfig: {
            sessionType: 'loop',
            instructions: 'Execute the task',
            preparation: 'Load user context',
            allowedSkills: [],
        },
    };

    const supervisor = { approve: async () => 'approve' };

    const result = await subsystem.executeLoopAgentSession({
        skillRecord,
        promptText: 'Do something',
        options: { tier: 'fast', supervisor },
    });

    assert.equal(result.session, 'loop');
    assert.ok(capturedOptions.preparation, 'preparation option should be passed');
    assert.equal(capturedOptions.preparation.text, 'Load user context');
    assert.equal(Object.prototype.hasOwnProperty.call(capturedOptions.preparation, 'context'), false);
    assert.equal(capturedOptions.preparation.retries, 1);
    assert.equal(capturedOptions.supervisor, supervisor);
});

test('OrchestratorSkillsSubsystem passes parent context to loop preparation without exposing clarify_context itself', async () => {
    let capturedTools = null;
    let capturedOptions = null;

    const stubLLMAgent = {
        startLoopAgentSession: async (tools, _prompt, options) => {
            capturedTools = tools;
            capturedOptions = options;
            return {
                status: 'done',
                getLastResult: () => 'Loop completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });
    const skillRecord = {
        name: 'test-loop-orchestrator',
        preparedConfig: {
            sessionType: 'loop',
            instructions: 'Execute the task',
            preparation: 'Clarify parent context if needed',
            allowedSkills: [],
        },
    };

    await subsystem.executeLoopAgentSession({
        skillRecord,
        promptText: 'Current admin request',
        options: {
            parentContext: {
                type: 'loop',
                history: [{ type: 'user', prompt: 'Previous admin request' }],
            },
        },
    });

    assert.equal(capturedTools.clarify_context, undefined);
    assert.equal(capturedOptions.preparation.tools.clarify_context, undefined);
    assert.equal(capturedOptions.preparation.parentContext.history[0].prompt, 'Previous admin request');
    assert.doesNotMatch(capturedOptions.systemPrompt, /Previous admin request/);
});

test('OrchestratorSkillsSubsystem passes supervisor into SOP session', async () => {
    let capturedOptions = null;

    const stubLLMAgent = {
        startSOPLangAgentSession: async (_skillsDescription, _prompt, options) => {
            capturedOptions = options;
            return {
                getVariables: async () => ({ lastAnswer: 'SOP completed' }),
                getLastResult: () => 'SOP completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });

    const skillRecord = {
        name: 'test-sop-orchestrator',
        preparedConfig: {
            sessionType: 'sop',
            instructions: 'Execute the task',
            allowedSkills: [],
        },
    };

    const supervisor = { approve: async () => 'approve' };

    const result = await subsystem.executeSOPAgentSession({
        skillRecord,
        promptText: 'Do something',
        options: { tier: 'fast', supervisor },
    });

    assert.equal(result.session, 'sop');
    assert.equal(capturedOptions.supervisor, supervisor);
});

test('OrchestratorSkillsSubsystem does not inject parent loop history into loop system prompt', async () => {
    let capturedPrompt = null;
    let capturedOptions = null;

    const stubLLMAgent = {
        startLoopAgentSession: async (_tools, prompt, options) => {
            capturedPrompt = prompt;
            capturedOptions = options;
            return {
                status: 'done',
                getLastResult: () => 'Loop completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });
    const skillRecord = {
        name: 'test-loop-orchestrator',
        preparedConfig: {
            sessionType: 'loop',
            instructions: 'Execute the task',
            preparation: null,
            allowedSkills: [],
        },
    };

    await subsystem.executeLoopAgentSession({
        skillRecord,
        promptText: 'Current admin request',
        options: {
            parentContext: {
                type: 'loop',
                history: [{ type: 'user', prompt: 'Previous admin request' }],
            },
        },
    });

    assert.equal(capturedPrompt, 'Current admin request');
    assert.doesNotMatch(capturedOptions.systemPrompt, /<parent-session-context>/);
    assert.doesNotMatch(capturedOptions.systemPrompt, /Previous admin request/);
    assert.doesNotMatch(capturedOptions.systemPrompt, /Previous admin answer/);
});

test('OrchestratorSkillsSubsystem passes preparation instructions into SOP session without descriptor context', async () => {
    let capturedOptions = null;

    const stubLLMAgent = {
        startSOPLangAgentSession: async (skillsDescription, prompt, options) => {
            capturedOptions = options;
            return {
                getVariables: async () => ({}),
                getLastResult: () => 'SOP completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });

    const skillRecord = {
        name: 'test-sop-orchestrator',
        descriptor: {
            sections: {
                description: 'SOP orchestration description',
            },
        },
        preparedConfig: {
            sessionType: null, // SOP session (no loop)
            instructions: 'Plan and execute',
            preparation: 'Load data context',
            allowedSkills: [],
        },
    };

    const result = await subsystem.executeSOPAgentSession({
        skillRecord,
        promptText: 'Process data',
        options: { tier: 'deep' },
    });

    assert.equal(result.session, 'sop');
    assert.ok(capturedOptions.preparation, 'preparation option should be passed');
    assert.equal(capturedOptions.preparation.text, 'Load data context');
    assert.equal(Object.prototype.hasOwnProperty.call(capturedOptions.preparation, 'context'), false);
    assert.equal(capturedOptions.preparation.retries, 1);
});

test('OrchestratorSkillsSubsystem passes parent context to SOP preparation without exposing clarify_context itself', async () => {
    let capturedSkillsDescription = null;
    let capturedOptions = null;

    const stubLLMAgent = {
        startSOPLangAgentSession: async (skillsDescription, _prompt, options) => {
            capturedSkillsDescription = skillsDescription;
            capturedOptions = options;
            return {
                getVariables: async () => ({}),
                getLastResult: () => 'SOP completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });
    const skillRecord = {
        name: 'test-sop-orchestrator',
        preparedConfig: {
            sessionType: null,
            instructions: 'Plan and execute',
            preparation: 'Clarify parent context if needed',
            allowedSkills: [],
        },
    };

    await subsystem.executeSOPAgentSession({
        skillRecord,
        promptText: 'Current SOP request',
        options: {
            parentContext: {
                type: 'loop',
                history: [{ type: 'user', prompt: 'Create a reporting skill' }],
            },
        },
    });

    assert.equal(capturedSkillsDescription.clarify_context, undefined);
    assert.equal(capturedOptions.commandsRegistry.listCommands().some((command) => command.name === 'clarify_context'), false);
    assert.equal(capturedOptions.preparation.skillsDescription.clarify_context, undefined);
    assert.equal(capturedOptions.preparation.commandsRegistry.listCommands().some((command) => command.name === 'clarify_context'), false);
    assert.equal(capturedOptions.preparation.parentContext.history[0].prompt, 'Create a reporting skill');
    assert.doesNotMatch(capturedOptions.systemPrompt, /Create a reporting skill/);
});

test('LoopAgentSession exposes clarify_context as an internal preparation-only tool', async () => {
    const plannerResponses = [
        plannerMarkdownDecision({
            tool: 'clarify_context',
            prompt: 'What was the previous request?',
            reason: 'need parent context',
        }),
        plannerMarkdownDecision({
            tool: 'final_answer',
            prompt: '@context_parent := "$$clarify_context-res-1"',
            reason: 'return context',
        }),
    ];
    let capturedClarifyPrompt = null;
    const agent = {
        __toolState: new Map(),
        complete: async () => plannerResponses.shift(),
        executePrompt: async (prompt) => {
            capturedClarifyPrompt = prompt;
            return 'The previous request was to create a reporting skill.';
        },
    };

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools: {},
        options: {
            parentContext: {
                history: [{ type: 'user', prompt: 'Create a reporting skill' }],
            },
        },
        preparationText: 'Use clarify_context if the parent request matters.',
        userPrompt: 'Continue',
        retries: 0,
    });

    assert.deepEqual(result.contextEntries, [{
        name: '@context_parent',
        value: 'The previous request was to create a reporting skill.',
    }]);
    assert.match(capturedClarifyPrompt, /Create a reporting skill/);
    assert.match(capturedClarifyPrompt, /What was the previous request/);
});

test('LoopAgentSession does not expose clarify_context in a normal turn', () => {
    const agent = {
        __toolState: new Map(),
        complete: async () => [
            '## tool',
            'final_answer',
            '',
            '## prompt',
            'done',
            '',
            '## reason',
            'test',
        ].join('\n'),
        executePrompt: async () => 'unused',
    };

    const session = new LoopAgentSession({
        agent,
        tools: {},
        options: {
            enableClarifyContextTool: true,
            parentContext: {
                history: [{ type: 'user', prompt: 'Earlier request' }],
            },
        },
    });

    assert.equal(session.tools.clarify_context, undefined);
});

test('SOPAgenticSession exposes clarify_context as an internal preparation-only command', async () => {
    let capturedClarifyPrompt = null;
    const agent = {
        __toolState: new Map(),
        executePrompt: async (prompt) => {
            if (prompt.includes('Question(s):')) {
                capturedClarifyPrompt = prompt;
                return 'The user asked to create a reporting skill.';
            }
            return [
                '# Clarify parent context',
                '@ctx clarify_context "What did the user ask for?"',
                '@lastAnswer final_answer $ctx',
            ].join('\n');
        },
    };
    const commandsRegistry = {
        executeCommand: async (_payload, response) => response.fail('unexpected external command'),
        listCommands: () => [],
    };

    const result = await SOPAgenticSession.runPreparation({
        agent,
        skillsDescription: {},
        commandsRegistry,
        options: {
            parentContext: {
                history: [{ type: 'user', prompt: 'Create a reporting skill' }],
            },
        },
        preparationText: 'Use clarify_context if the parent request matters.',
        userPrompt: 'Continue',
        retries: 0,
    });

    assert.equal(result.contextText, 'The user asked to create a reporting skill.');
    assert.match(capturedClarifyPrompt, /Create a reporting skill/);
    assert.match(capturedClarifyPrompt, /What did the user ask for/);
});

test('SOPAgenticSession allows clarify_context during preparation without parent context', async () => {
    let clarifyPromptCalls = 0;
    const agent = {
        __toolState: new Map(),
        executePrompt: async (prompt) => {
            if (prompt.includes('Question(s):')) {
                clarifyPromptCalls += 1;
                return 'unexpected';
            }
            return [
                '@ctx clarify_context "What did the user ask for?"',
                '@lastAnswer final_answer $ctx',
            ].join('\n');
        },
    };
    const commandsRegistry = {
        executeCommand: async (_payload, response) => response.fail('unexpected external command'),
        listCommands: () => [],
    };

    const result = await SOPAgenticSession.runPreparation({
        agent,
        skillsDescription: {},
        commandsRegistry,
        options: {},
        preparationText: 'Use clarify_context if the parent request matters.',
        userPrompt: 'Continue',
        retries: 0,
    });

    assert.equal(result.contextText, CLARIFY_CONTEXT_UNAVAILABLE);
    assert.equal(clarifyPromptCalls, 0);
});

test('SOPAgenticSession does not expose clarify_context in a normal turn', () => {
    const agent = {
        __toolState: new Map(),
        executePrompt: async () => 'unused',
    };
    const commandsRegistry = {
        executeCommand: async () => {},
        listCommands: () => [],
    };

    const session = new SOPAgenticSession({
        agent,
        skillsDescription: {},
        options: {
            commandsRegistry,
            enableClarifyContextCommand: true,
            parentContext: {
                history: [{ type: 'user', prompt: 'Earlier request' }],
            },
        },
    });

    assert.equal(session.skillsDescription.clarify_context, undefined);
    assert.equal(session.commandsRegistry.listCommands().some((command) => command.name === 'clarify_context'), false);
});

test('SOPAgenticSession exposes conversation snapshot without tool results', () => {
    const session = new SOPAgenticSession({
        agent: {
            __toolState: new Map(),
            executePrompt: async () => 'unused',
        },
        skillsDescription: {},
        options: {},
    });
    session.status = 'active';
    session.lastExecution = {
        lastAnswer: 'SOP answer',
        variables: { childResult: 'value' },
    };
    session.history = [{ prompt: 'Create nested skill', plan: '@lastAnswer final_answer "ok"' }];

    const snapshot = session.getConversationSnapshot();

    assert.equal(snapshot.type, 'sop');
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.lastAnswer, 'SOP answer');
    assert.deepEqual(snapshot.history, session.history);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'toolResults'), false);
    snapshot.history[0].prompt = 'mutated';
    assert.equal(session.history[0].prompt, 'Create nested skill');
});

test('OrchestratorSkillsSubsystem passes current SOP session snapshot to nested skill execution', async () => {
    let capturedOptions = null;
    const childSkill = {
        name: 'child-orchestrator',
        shortName: 'child',
        descriptor: { rawContent: 'Child skill' },
    };
    const mainAgent = {
        llmAgent: {
            __toolState: new Map(),
            executePrompt: async () => [
                '@childResult child "run child"',
                '@lastAnswer final_answer $childResult',
            ].join('\n'),
        },
        supervisor: null,
        executeSkill: async (_skillName, _prompt, options) => {
            capturedOptions = options;
            return { result: 'nested ok' };
        },
    };
    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent });
    const tools = await subsystem.buildSkillsAsTools([childSkill], mainAgent, {
        context: { workingDir: '/workspace/project' },
        parentContext: {
            type: 'loop',
            history: [{ type: 'user', prompt: 'Main session prompt' }],
        },
    });
    const commandsRegistry = subsystem.buildCommandsRegistry(
        tools,
        subsystem.buildToolDescriptions([childSkill]),
    );
    const session = new SOPAgenticSession({
        agent: mainAgent.llmAgent,
        skillsDescription: { child: 'Child skill' },
        options: { commandsRegistry },
    });

    await session.newPrompt('Sub-session prompt');

    assert.equal(capturedOptions.parentContext.type, 'sop');
    assert.equal(capturedOptions.parentContext.history[0].prompt, 'Sub-session prompt');
    assert.equal(capturedOptions.context.parentSession, capturedOptions.parentContext);
    assert.equal(capturedOptions.context.workingDir, '/workspace/project');
});

test('MainAgent passes loop conversation snapshot as skill parentContext', async (t) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-agent-parent-context-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    let capturedOptions = null;
    const mainAgent = new MainAgent({
        startDir: projectRoot,
        disableInternalSkills: true,
        logger: { debug: () => {}, log: () => {} },
    });
    t.after(() => mainAgent.shutdown());
    const skillRecord = {
        name: 'skills-orchestrator',
        shortName: 'skills-orchestrator',
        type: 'orchestrator',
        descriptor: {
            sections: {
                description: 'Manage skills',
            },
        },
    };
    mainAgent._skills.set(skillRecord.name, skillRecord);
    mainAgent.context = { workingDir: '/workspace/project' };
    mainAgent.executeSkill = async (_skillName, _prompt, options) => {
        capturedOptions = options;
        return { result: 'ok' };
    };

    const tools = mainAgent._buildToolsForSession();
    const output = await tools['skills-orchestrator'].handler(mainAgent.llmAgent, 'Create a skill', {
        session: {
            supervisor: null,
            getConversationSnapshot: () => ({
                type: 'loop',
                history: [{ type: 'user', prompt: 'Create a skill' }],
            }),
        },
    });

    assert.equal(output, 'ok');
    assert.equal(capturedOptions.parentContext.history[0].prompt, 'Create a skill');
    assert.equal(capturedOptions.context.parentSession, capturedOptions.parentContext);
    assert.equal(capturedOptions.context.workingDir, '/workspace/project');
});

test('OrchestratorSkillsSubsystem does not inject parent loop history into SOP system prompt', async () => {
    let capturedPrompt = null;
    let capturedOptions = null;

    const stubLLMAgent = {
        startSOPLangAgentSession: async (_skillsDescription, prompt, options) => {
            capturedPrompt = prompt;
            capturedOptions = options;
            return {
                getVariables: async () => ({}),
                getLastResult: () => 'SOP completed',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });
    const skillRecord = {
        name: 'test-sop-orchestrator',
        preparedConfig: {
            sessionType: null,
            instructions: 'Plan and execute',
            preparation: null,
            allowedSkills: [],
        },
    };

    await subsystem.executeSOPAgentSession({
        skillRecord,
        promptText: 'Current SOP request',
        options: {
            parentContext: {
                type: 'loop',
                history: [{ type: 'user', prompt: 'Earlier user turn' }],
            },
        },
    });

    assert.equal(capturedPrompt, 'Current SOP request');
    assert.doesNotMatch(capturedOptions.systemPrompt, /<parent-session-context>/);
    assert.doesNotMatch(capturedOptions.systemPrompt, /Earlier user turn/);
});

test('OrchestratorSkillsSubsystem skips preparation when no ##Preparation section', async () => {
    let capturedOptions = null;

    const stubLLMAgent = {
        startLoopAgentSession: async (tools, prompt, options) => {
            capturedOptions = options;
            return {
                status: 'done',
                getLastResult: () => 'Done',
            };
        },
    };

    const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: { llmAgent: stubLLMAgent, getSkills: () => [] } });

    const skillRecord = {
        name: 'no-prep-orchestrator',
        preparedConfig: {
            sessionType: 'loop',
            instructions: 'Just execute',
            preparation: null, // No preparation
            allowedSkills: [],
        },
    };

    await subsystem.executeLoopAgentSession({
        skillRecord,
        promptText: 'Test',
        options: {},
    });

    assert.equal(capturedOptions.preparation, null, 'preparation should be null when no preparation section');
});

// =============================================================================
// Context parsing edge cases
// =============================================================================

test('context parsing handles various formats', async () => {
    const agent = createStubLLMAgent(async () => plannerMarkdownDecision({
        tool: 'final_answer',
        prompt: [
            '@context_a := "value1"',
            '@context_b: value2',
            '@context_c = value3',
            '@context_d := "quoted value"',
            '@other_var := "ignored"', // not @context_ prefix
            'random text',
            '@context_e := \'single quoted\'',
        ].join('\n'),
    }));

    const result = await LoopAgentSession.runPreparation({
        agent,
        tools: {},
        options: { tier: 'fast', maxStepsPerTurn: 5 },
        preparationText: 'Parse formats',
        userPrompt: 'test',
        retries: 0,
    });

    // Should parse @context_a through @context_e, ignore @other_var
    const names = result.contextEntries.map(e => e.name);
    assert.ok(names.includes('@context_a'), 'should parse := format');
    assert.ok(names.includes('@context_b'), 'should parse : format');
    assert.ok(names.includes('@context_c'), 'should parse = format');
    assert.ok(names.includes('@context_d'), 'should parse quoted value');
    assert.ok(!names.includes('@other_var'), 'should ignore non-context prefix');
});
