import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainAgent } from '../../MainAgent/index.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-agent-additional-roots-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(project);
    fs.mkdirSync(managed);
    return { root, project, managed };
}

function writeSkill(root, name) {
    const directory = path.join(root, 'skills', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'cskill.md'), `# ${name}\n\n## Description\n${name} skill.\n`);
    return directory;
}

test('additional workspace roots are discovered and refreshed without changing the project root', (t) => {
    const { project, managed } = fixture(t);
    writeSkill(project, 'project-skill');
    const oldSkill = writeSkill(managed, 'managed-skill');
    const agent = new MainAgent({ startDir: project, additionalWorkspaceRoots: [managed] });
    t.after(() => agent.shutdown());
    assert.equal(agent.startDir, project);
    assert.ok(agent.getSkillRecord('managed-skill'));
    agent.disableSkills(['project-skill']);

    fs.rmSync(oldSkill, { recursive: true });
    writeSkill(managed, 'new-skill');
    const summary = agent.refreshSkills();
    assert.deepEqual(summary.added, ['new-skill-cskill']);
    assert.deepEqual(summary.removed, ['managed-skill-cskill']);
    assert.equal(agent.getSkillRecord('managed-skill'), null);
    assert.ok(agent.getSkillRecord('new-skill'));
    assert.equal(agent.getSkillRecord('project-skill').enabled, false);
});

test('overlapping roots do not register the same descriptor more than once', (t) => {
    const { root, project } = fixture(t);
    writeSkill(project, 'one-skill');
    const agent = new MainAgent({ startDir: root, additionalWorkspaceRoots: [project, root, project] });
    t.after(() => agent.shutdown());
    assert.equal(agent.getSkills().length, 1);
    assert.deepEqual(agent._duplicateSkillEvents, []);
    assert.deepEqual(agent.refreshSkills().added, []);
    assert.deepEqual(agent._duplicateSkillEvents, []);
});

test('the root resolver revalidates before refresh and leaves the catalog intact on failure', (t) => {
    const { project, managed } = fixture(t);
    writeSkill(managed, 'safe-skill');
    let allowed = true;
    let calls = 0;
    const agent = new MainAgent({
        startDir: project,
        additionalWorkspaceRoots: () => {
            calls += 1;
            if (!allowed) throw new Error('Unsafe managed root');
            return [managed];
        },
    });
    t.after(() => agent.shutdown());
    allowed = false;
    assert.throws(() => agent.refreshSkills(), /Unsafe managed root/);
    assert.equal(calls, 2);
    assert.ok(agent.getSkillRecord('safe-skill'));
    allowed = true;
    assert.deepEqual(agent.refreshSkills().added, []);
});

test('invalid additional root inputs fail explicitly', (t) => {
    const { project } = fixture(t);
    for (const additionalWorkspaceRoots of ['not-an-array', [''], [null], () => Promise.resolve([])]) {
        assert.throws(() => new MainAgent({ startDir: project, additionalWorkspaceRoots }), TypeError);
    }
});
