import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgenticKnowledgeUnits } from '../../AgenticKnowledgeUnits/index.mjs';

test('public lifecycle covers KU records, search, pack, fork, discard, and delete', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-lifecycle-'));
    await fs.writeFile(path.join(rootDir, 'source.txt'), 'source');
    const aku = new AgenticKnowledgeUnits({ rootDir, actor: 'test' });

    assert.equal(await aku.exists(), false);
    await aku.initAKU({ name: 'lifecycle' });
    assert.equal(await aku.exists(), true);

    const ku = await aku.initKU({
        ku_name: 'Lifecycle KU',
        ku_type: 'implementation',
        tags: ['aku'],
        keywords: ['Lifecycle'],
        summary: 'Lifecycle search target',
        reusable_findings: ['Lifecycle finding'],
    });
    await aku.updateKUState(ku.ku_id, { append: 'Implemented deterministic AKU runtime.', summary: 'Updated lifecycle target' });
    await aku.setKUStatus(ku.ku_id, 'validated', 'tested');
    await aku.recordEvent(ku.ku_id, { event_type: 'checkpoint', summary: 'checkpoint event' });
    await aku.recordDocument(ku.ku_id, { title: 'Lifecycle Document', summary: 'document summary' });
    await aku.registerFile(ku.ku_id, { path: 'source.txt', summary: 'registered file' });
    await aku.recordResult(ku.ku_id, { title: 'Lifecycle Result', summary: 'result summary', status: 'accepted' });
    await aku.recordRun(ku.ku_id, { run_id: 'run_lifecycle', title: 'Lifecycle Run' });
    await aku.recordValidation(ku.ku_id, { validation_id: 'val_lifecycle', title: 'Lifecycle Validation' });
    await aku.ingestSession(ku.ku_id, { session_id: 'sess_lifecycle', summary: 'session packet' });
    await aku.discardSession(ku.ku_id, 'sess_lifecycle', 'not needed');

    const search = await aku.search('Lifecycle', { explain: true });
    assert.ok(search.results.length >= 3);
    const pack = await aku.buildContextPack('Lifecycle', { budgetChars: 2000 });
    assert.ok(pack.results.length >= 1);
    assert.equal((await aku.listKUs()).length, 1);
    assert.equal((await aku.listDocuments()).length, 1);
    assert.equal((await aku.listFiles()).length, 1);
    assert.ok((await aku.listResults()).length >= 3);

    const fork = await aku.forkKU(ku.ku_id);
    assert.equal(fork.parent_ku_id, ku.ku_id);
    await assert.rejects(
        () => aku.forkKU(ku.ku_id, { ku_id: fork.ku_id }),
        { code: 'AKU_ALREADY_EXISTS' },
    );
    await aku.discardKU(ku.ku_id, 'superseded');
    const normal = await aku.search('Lifecycle', { kuId: ku.ku_id });
    assert.equal(normal.results.length, 0);
    const audit = await aku.search('Lifecycle', { kuId: ku.ku_id, includeDiscarded: true });
    assert.ok(audit.results.length >= 1);
    await aku.deleteKU(fork.ku_id, { confirm: true });
    assert.equal((await aku.listKUs({ includeDiscarded: true })).some(item => item.ku_id === fork.ku_id), false);
});

test('explicit persistence root stores AKU state while file registration stays project-relative', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-project-'));
    const persistenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-private-'));
    await fs.writeFile(path.join(rootDir, 'source.txt'), 'source');
    const aku = new AgenticKnowledgeUnits({ rootDir, persistenceRoot, actor: 'test' });

    await aku.initAKU({ name: 'separated roots' });
    const ku = await aku.initKU({ ku_name: 'Project evidence' });
    await aku.registerFile(ku.ku_id, { path: 'source.txt', summary: 'registered project file' });

    const loaded = await aku.loadKU(ku.ku_id);
    assert.equal(loaded.files[0].path, 'source.txt');
    assert.equal(await fs.readFile(path.join(rootDir, 'source.txt'), 'utf8'), 'source');
    assert.equal(await fs.stat(path.join(persistenceRoot, 'aku.json')).then(stat => stat.isFile()), true);
    assert.equal(await fs.stat(path.join(persistenceRoot, 'search-index.jsonl')).then(stat => stat.isFile()), true);
    assert.equal(await fs.stat(path.join(persistenceRoot, 'kus', ku.ku_id, 'support', 'files.jsonl'))
        .then(stat => stat.isFile()), true);
    await assert.rejects(() => fs.stat(path.join(rootDir, '.aku')), { code: 'ENOENT' });
});
