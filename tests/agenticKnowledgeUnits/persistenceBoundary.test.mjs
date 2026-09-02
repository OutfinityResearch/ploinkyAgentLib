import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgenticKnowledgeUnits } from '../../AgenticKnowledgeUnits/index.mjs';

async function fixture(t) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aku-persistence-boundary-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'workspace');
    const dataRoot = path.join(workspace, '.data');
    const rootDir = path.join(dataRoot, 'achilles-cli', 'repos', 'project');
    const persistenceRoot = path.join(dataRoot, 'achilles-cli', 'aku');
    const movedData = path.join(workspace, '.ploinky', 'unexpected-state');
    await fs.mkdir(rootDir, { recursive: true });
    const aku = new AgenticKnowledgeUnits({ rootDir, persistenceRoot, actor: 'boundary-test' });
    const replaceDataRoot = async () => {
        await fs.mkdir(path.dirname(movedData), { recursive: true });
        await fs.rename(dataRoot, movedData);
        await fs.symlink(movedData, dataRoot);
    };
    return { aku, base, workspace, rootDir, persistenceRoot, movedData, replaceDataRoot };
}

async function snapshot(root) {
    const files = {};
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(entryPath);
            else files[path.relative(root, entryPath)] = await fs.readFile(entryPath, 'utf8');
        }
    }
    await visit(root);
    return files;
}

test('AKU rejects replacement above the common project/storage ancestor before initialization', async (t) => {
    const { aku, movedData, replaceDataRoot } = await fixture(t);
    await replaceDataRoot();

    await assert.rejects(() => aku.initAKU(), { code: 'AKU_PATH_ESCAPE' });
    await assert.rejects(() => fs.stat(path.join(movedData, 'achilles-cli', 'aku')), { code: 'ENOENT' });
});

test('loaded AKU rejects reads, repair, mutations, lock refresh, and removal after an ancestor changes', async (t) => {
    const { aku, movedData, replaceDataRoot } = await fixture(t);
    await aku.initAKU();
    const ku = await aku.initKU({ ku_name: 'Boundary KU', summary: 'preserve stored state' });
    const lock = await aku.lockManager.acquire('root');
    clearInterval(lock.refreshTimer);
    await replaceDataRoot();
    const before = await snapshot(movedData);
    const operations = [
        () => aku.exists(),
        () => aku.loadAKU(),
        () => aku.doctor({ autoRepair: true }),
        () => aku.recordDocument(ku.ku_id, { title: 'Blocked', summary: 'must not persist' }),
        () => aku.deleteKU(ku.ku_id, { confirm: true }),
        () => aku.writer.replaceFile(aku.store.rootFile('unexpected.json'), '{}\n'),
        () => aku.store.removeOwned(aku.store.kuDir(ku.ku_id), { recursive: true }),
        () => aku.lockManager.refresh(lock),
        () => aku.lockManager.release(lock),
    ];
    for (const operation of operations) {
        await assert.rejects(operation, { code: 'AKU_PATH_ESCAPE' });
    }
    assert.deepEqual(await snapshot(movedData), before);
});

test('an open transaction rechecks its canonical root before writing the next record', async (t) => {
    const { aku, movedData, replaceDataRoot } = await fixture(t);
    await aku.initAKU();
    let before;
    await assert.rejects(() => aku.writer.transaction('boundary-swap', async (tx) => {
        await replaceDataRoot();
        before = await snapshot(movedData);
        await tx.writeJson(aku.store.rootFile('unexpected.json'), { blocked: true });
    }), { code: 'AKU_PATH_ESCAPE' });
    assert.deepEqual(await snapshot(movedData), before);
});

test('a pre-existing canonical alias above the workspace remains supported', async (t) => {
    const { base, workspace } = await fixture(t);
    const alias = path.join(base, 'alias');
    await fs.symlink(base, alias);
    const rootDir = path.join(alias, 'workspace', 'project');
    const persistenceRoot = path.join(alias, 'workspace', '.data', 'agent', 'aku');
    await fs.mkdir(rootDir);
    await fs.writeFile(path.join(rootDir, 'evidence.txt'), 'project artifact');
    const aku = new AgenticKnowledgeUnits({ rootDir, persistenceRoot });
    await aku.initAKU();
    const ku = await aku.initKU({ ku_name: 'Aliased workspace', summary: 'canonical ancestor remains stable' });
    await aku.registerFile(ku.ku_id, { path: 'evidence.txt' });

    assert.equal(await aku.exists(), true);
    assert.equal((await aku.loadKU(ku.ku_id)).files[0].path, 'evidence.txt');
    assert.equal(await fs.readFile(path.join(workspace, 'project', 'evidence.txt'), 'utf8'), 'project artifact');
});
