import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicFileWriter } from '../../AgenticKnowledgeUnits/internal/atomic-write.mjs';
import { AKUFileStore } from '../../AgenticKnowledgeUnits/internal/storage.mjs';
import { resolveSafeRelative } from '../../AgenticKnowledgeUnits/internal/paths.mjs';
import { AgenticKnowledgeUnits, AKUError } from '../../AgenticKnowledgeUnits/index.mjs';

async function tempRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'aku-storage-'));
}

test('storage creates directories and round-trips JSON and JSONL atomically', async () => {
    const rootDir = await tempRoot();
    const store = new AKUFileStore({ rootDir });
    await store.ensureBaseLayout();
    const writer = new AtomicFileWriter({ akuRoot: store.akuRoot });

    await writer.transaction('storage-test', async (tx) => {
        await tx.writeJson(store.rootFile('sample.json'), { ok: true });
        await tx.writeJsonl(store.rootFile('sample.jsonl'), [{ a: 1 }, { b: 2 }]);
    });

    assert.deepEqual(await store.readJson(store.rootFile('sample.json')), { ok: true });
    assert.deepEqual(await store.readJsonl(store.rootFile('sample.jsonl')), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(await store.listPendingTransactions(), []);
});

test('explicit persistence root keeps AKU files separate from project files', async () => {
    const rootDir = await tempRoot();
    const persistenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-persistence-'));
    const store = new AKUFileStore({ rootDir, persistenceRoot });

    await store.ensureBaseLayout();

    assert.equal(store.rootDir, path.resolve(rootDir));
    assert.equal(store.akuRoot, path.resolve(persistenceRoot));
    assert.equal(await fs.stat(path.join(persistenceRoot, 'pending')).then(stat => stat.isDirectory()), true);
    await assert.rejects(() => fs.stat(path.join(rootDir, '.aku')), { code: 'ENOENT' });
});

test('explicit persistence root rejects a symlink escape', async () => {
    const rootDir = await tempRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-outside-'));
    const linkedRoot = path.join(rootDir, 'linked-persistence');
    await fs.symlink(outside, linkedRoot);
    const store = new AKUFileStore({ rootDir, persistenceRoot: path.join(linkedRoot, 'aku') });

    await assert.rejects(() => store.ensureBaseLayout(), AKUError);
    await assert.rejects(() => fs.stat(path.join(outside, 'aku')), { code: 'ENOENT' });
});

test('explicit persistence root rejects a symlink at the shared project ancestor', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-linked-ancestor-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aku-linked-target-'));
    await fs.mkdir(path.join(outside, 'project'));
    const linkedWorkspace = path.join(base, 'workspace');
    await fs.symlink(outside, linkedWorkspace);
    const store = new AKUFileStore({
        rootDir: path.join(linkedWorkspace, 'project'),
        persistenceRoot: path.join(linkedWorkspace, 'aku'),
    });

    await assert.rejects(() => store.ensureBaseLayout(), AKUError);
    await assert.rejects(() => fs.stat(path.join(outside, 'aku')), { code: 'ENOENT' });
});

test('explicit persistence root rejects a symlink alias to the legacy .aku path on reads and recovery', async () => {
    const rootDir = await tempRoot();
    const actualRoot = path.join(rootDir, 'actual-aku');
    const initial = new AgenticKnowledgeUnits({ rootDir, persistenceRoot: actualRoot, actor: 'test' });
    await initial.initAKU();
    await fs.symlink(actualRoot, path.join(rootDir, '.aku'));
    const aliased = new AgenticKnowledgeUnits({
        rootDir,
        persistenceRoot: path.join(rootDir, '.aku'),
        actor: 'test',
    });

    await assert.rejects(() => aliased.exists(), AKUError);
    await assert.rejects(() => aliased.loadAKU(), AKUError);
    await assert.rejects(() => aliased.doctor({ autoRepair: true }), AKUError);
});

test('storage rejects symlinked pending and kus directories before scanning or writing', async () => {
    const rootDir = await tempRoot();
    const outside = await tempRoot();
    const store = new AKUFileStore({ rootDir });
    await store.ensureBaseLayout();

    await fs.rm(path.join(store.akuRoot, 'pending'), { recursive: true });
    await fs.symlink(outside, path.join(store.akuRoot, 'pending'));
    await assert.rejects(() => store.listPendingTransactions(), AKUError);
    await assert.rejects(() => store.ensureBaseLayout(), AKUError);

    await fs.unlink(path.join(store.akuRoot, 'pending'));
    await fs.mkdir(path.join(store.akuRoot, 'pending'));
    await fs.rm(path.join(store.akuRoot, 'kus'), { recursive: true });
    await fs.symlink(outside, path.join(store.akuRoot, 'kus'));
    await assert.rejects(() => store.scanKUFolders(), AKUError);
    await assert.rejects(() => store.ensureBaseLayout(), AKUError);
});

test('safe relative path resolution rejects traversal, absolute paths, and symlinks', async () => {
    const rootDir = await tempRoot();
    await fs.writeFile(path.join(rootDir, 'safe.txt'), 'ok');
    await fs.symlink('/tmp', path.join(rootDir, 'linked'));

    const safe = await resolveSafeRelative(rootDir, 'safe.txt');
    assert.equal(safe.relative, 'safe.txt');

    await assert.rejects(() => resolveSafeRelative(rootDir, '../escape.txt'), AKUError);
    await assert.rejects(() => resolveSafeRelative(rootDir, path.join(rootDir, 'safe.txt')), AKUError);
    await assert.rejects(() => resolveSafeRelative(rootDir, 'linked/outside.txt'), AKUError);
});
