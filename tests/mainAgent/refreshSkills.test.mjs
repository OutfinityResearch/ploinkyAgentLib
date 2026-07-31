import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MainAgent } from '../../MainAgent/index.mjs';
import { LoopAgentSession } from '../../LLMAgents/LoopAgenticSession/LoopAgentSession.mjs';
import { SOPAgenticSession } from '../../LLMAgents/SOPAgenticSession/SOPAgenticSession.mjs';

const tempDirs = [];

function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join('/tmp', prefix));
    tempDirs.push(dir);
    return dir;
}

function writeCSkill(root, name, description = name) {
    const skillDir = path.join(root, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'cskill.md'), `# ${name}

## Description
${description}
`);
    return skillDir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('MainAgent.refreshSkills', () => {
    it('disables and enables named skills while retaining them in the catalog', async () => {
        const workspace = makeTempDir('mainagent-enabled-state-');
        writeCSkill(workspace, 'alpha', 'Alpha skill.');
        writeCSkill(workspace, 'beta', 'Beta skill.');

        const agent = new MainAgent({ startDir: workspace });
        const session = new LoopAgentSession({
            agent: agent.llmAgent,
            tools: agent._buildToolsForSession(),
        });
        agent._session = session;

        const disabled = agent.disableSkills(['alpha']);
        assert.deepEqual(disabled.map((skill) => skill.name), ['alpha-cskill']);
        assert.equal(agent.getSkillRecord('alpha').enabled, false);
        assert.equal(agent.getSkills().length, 2);
        assert.equal(session.tools.alpha, undefined);
        assert.ok(session.tools.beta);
        await assert.rejects(
            () => agent.executeSkill('alpha', 'input'),
            /alpha-cskill.*disabled/,
        );

        agent.enableSkills(['alpha-cskill']);
        assert.equal(agent.getSkillRecord('alpha').enabled, true);
        assert.ok(session.tools.alpha);
    });

    it('validates a complete batch before changing any skill state', () => {
        const workspace = makeTempDir('mainagent-enabled-atomic-');
        writeCSkill(workspace, 'alpha', 'Alpha skill.');
        const agent = new MainAgent({ startDir: workspace });

        assert.throws(() => agent.disableSkills(['alpha', 'missing']), /Unknown skill/);
        assert.equal(agent.getSkillRecord('alpha').enabled, true);
        assert.throws(() => agent.disableSkills('alpha'), /array/);
    });

    it('preserves disabled state across workspace refresh and enables new skills by default', () => {
        const workspace = makeTempDir('mainagent-enabled-refresh-');
        writeCSkill(workspace, 'alpha', 'Alpha skill.');
        const agent = new MainAgent({ startDir: workspace });
        agent.disableSkills(['alpha']);

        writeCSkill(workspace, 'beta', 'Beta skill.');
        agent.refreshSkills();

        assert.equal(agent.getSkillRecord('alpha').enabled, false);
        assert.equal(agent.getSkillRecord('beta').enabled, true);
    });

    it('registers new workspace skills and refreshes current loop session tools in place', () => {
        const workspace = makeTempDir('mainagent-refresh-');
        writeCSkill(workspace, 'alpha', 'Alpha skill.');

        const agent = new MainAgent({ startDir: workspace });
        const session = new LoopAgentSession({
            agent: agent.llmAgent,
            tools: agent._buildToolsForSession(),
        });
        session.history.push({ type: 'user', prompt: 'previous context' });
        agent._session = session;

        writeCSkill(workspace, 'beta', 'Beta skill.');
        const summary = agent.refreshSkills();

        assert.equal(agent._session, session);
        assert.ok(agent.getSkillRecord('beta'));
        assert.ok(session.tools.beta);
        assert.ok(session.tools.alpha);
        assert.deepEqual(summary.added, ['beta-cskill']);
        assert.ok(session.history.some((entry) => entry?.type === 'system' && entry?.event === 'tools_refreshed'));
        assert.ok(session.history.some((entry) => entry?.prompt === 'previous context'));
    });

    it('removes deleted workspace skills and stale aliases', () => {
        const workspace = makeTempDir('mainagent-refresh-remove-');
        const alphaDir = writeCSkill(workspace, 'alpha', 'Alpha skill.');
        writeCSkill(workspace, 'beta', 'Beta skill.');

        const agent = new MainAgent({ startDir: workspace });
        const session = new LoopAgentSession({
            agent: agent.llmAgent,
            tools: agent._buildToolsForSession(),
        });
        agent._session = session;

        fs.rmSync(alphaDir, { recursive: true, force: true });
        const summary = agent.refreshSkills();

        assert.equal(agent.getSkillRecord('alpha'), null);
        assert.equal(agent.getSkillRecord('alpha-cskill'), null);
        assert.equal(session.tools.alpha, undefined);
        assert.deepEqual(summary.removed, ['alpha-cskill']);
        assert.ok(session.tools.beta);
    });

    it('preserves non-workspace registered skills during refresh', () => {
        const workspace = makeTempDir('mainagent-refresh-preserve-');
        const externalRoot = makeTempDir('mainagent-refresh-external-');
        writeCSkill(workspace, 'workspace-skill', 'Workspace skill.');
        const externalSkillDir = writeCSkill(externalRoot, 'external-skill', 'External skill.');

        const agent = new MainAgent({ startDir: workspace });
        agent._registerSkill({
            name: 'external-skill-cskill',
            shortName: 'external-skill',
            type: 'cskill',
            descriptor: null,
            filePath: path.join(externalSkillDir, 'cskill.md'),
            skillDir: externalSkillDir,
            preparedConfig: null,
            isInternal: true,
        });

        agent.refreshSkills();

        assert.ok(agent.getSkillRecord('workspace-skill'));
        assert.ok(agent.getSkillRecord('external-skill'));
    });
});

describe('Agentic session tool replacement', () => {
    it('LoopAgentSession.replaceTools keeps conversation state and records refresh event', () => {
        const agent = { name: 'stub', __toolState: new Map() };
        const session = new LoopAgentSession({
            agent,
            tools: {
                alpha: { description: 'Alpha', handler: async () => 'alpha' },
            },
        });
        session.history.push({ type: 'user', prompt: 'hello' });
        session.toolVars.set('alpha-res-1', 'value');
        session.lastAnswer = 'previous';

        session.replaceTools({
            beta: { description: 'Beta', handler: async () => 'beta' },
        }, {
            added: ['beta-cskill'],
            removed: ['alpha-cskill'],
        });

        assert.equal(session.tools.alpha, undefined);
        assert.ok(session.tools.beta);
        assert.ok(session.tools.final_answer);
        assert.equal(session.toolVars.get('alpha-res-1'), 'value');
        assert.equal(session.lastAnswer, 'previous');
        assert.ok(session.history.some((entry) => entry?.event === 'tools_refreshed'));
    });

    it('SOPAgenticSession.replaceSkillSurface keeps plan state and updates planner/execution surface', async () => {
        const agent = { name: 'stub', __toolState: new Map() };
        const session = new SOPAgenticSession({
            agent,
            skillsDescription: {
                alpha: 'Alpha skill',
            },
            options: {
                commandsRegistry: {
                    executeCommand: async (_payload, responder) => responder.success('alpha'),
                    listCommands: () => [{ name: 'alpha', description: 'Alpha skill' }],
                },
            },
        });
        session.currentPlan = '@result alpha';
        session.history.push({ prompt: 'previous', plan: session.currentPlan });

        session.replaceSkillSurface({
            skillsDescription: {
                beta: 'Beta skill',
            },
            commandsRegistry: {
                executeCommand: async (_payload, responder) => responder.success('beta'),
                listCommands: () => [{ name: 'beta', description: 'Beta skill' }],
            },
        }, {
            added: ['beta-cskill'],
            removed: ['alpha-cskill'],
        });

        const planCommands = session.planCommandsRegistry.listCommands().map((entry) => entry.name);
        const executionCommands = session.commandsRegistry.listCommands().map((entry) => entry.name);

        assert.equal(session.currentPlan, '@result alpha');
        assert.ok(session.history.some((entry) => entry?.event === 'tools_refreshed'));
        assert.ok(planCommands.includes('beta'));
        assert.ok(!planCommands.includes('alpha'));
        assert.ok(executionCommands.includes('beta'));
        assert.ok(!executionCommands.includes('alpha'));
    });
});
