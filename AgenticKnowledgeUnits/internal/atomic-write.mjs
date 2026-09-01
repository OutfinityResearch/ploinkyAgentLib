import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PENDING_DIRNAME } from './constants.mjs';
import { AKUError } from './errors.mjs';
import { retryFsOperation } from './locking.mjs';
import { assertSafePersistencePath } from './paths.mjs';
import { isoNow } from './schemas.mjs';

export class AtomicFileWriter {
    constructor(options = {}) {
        this.akuRoot = options.akuRoot;
        this.actor = options.actor ?? 'unknown';
        this.clock = options.clock ?? (() => new Date());
        this.strictFsync = Boolean(options.strictFsync);
    }

    async transaction(label, callback) {
        const txnId = `txn_${Date.now()}_${randomBytes(4).toString('hex')}`;
        const pendingDir = path.join(this.akuRoot, PENDING_DIRNAME);
        const pendingPath = path.join(pendingDir, `${txnId}.json`);
        await assertSafePersistencePath(this.akuRoot, pendingDir);
        await fs.mkdir(pendingDir, { recursive: true });
        await assertSafePersistencePath(this.akuRoot, pendingDir);
        await this.writePendingMarker(pendingPath, label, txnId);
        let completed = false;
        const api = {
            txnId,
            pendingPath,
            replaceFile: (targetPath, content) => this.replaceFile(targetPath, content, txnId),
            writeJson: (targetPath, value) => this.replaceFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, txnId),
            writeJsonl: (targetPath, records) => {
                const content = records.length ? `${records.map(record => JSON.stringify(record)).join('\n')}\n` : '';
                return this.replaceFile(targetPath, content, txnId);
            },
        };
        try {
            const result = await callback(api);
            completed = true;
            await retryFsOperation(async () => {
                await assertSafePersistencePath(this.akuRoot, pendingPath);
                await fs.unlink(pendingPath);
            });
            return result;
        } finally {
            if (completed) {
                await this.syncParentDirectory(pendingDir);
            }
        }
    }

    async writePendingMarker(pendingPath, label, txnId) {
        const marker = {
            transaction_id: txnId,
            label,
            actor: this.actor,
            pid: process.pid,
            created_at: isoNow(this.clock),
        };
        await assertSafePersistencePath(this.akuRoot, pendingPath);
        const handle = await fs.open(pendingPath, 'wx');
        try {
            await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
            await this.syncHandle(handle);
        } finally {
            await handle.close();
        }
        await this.syncParentDirectory(path.dirname(pendingPath));
    }

    async replaceFile(targetPath, content, txnId = 'txn') {
        await assertSafePersistencePath(this.akuRoot, targetPath);
        await assertSafePersistencePath(this.akuRoot, path.dirname(targetPath));
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await assertSafePersistencePath(this.akuRoot, path.dirname(targetPath));
        const tempPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${txnId}.${randomBytes(4).toString('hex')}.tmp`,
        );
        await assertSafePersistencePath(this.akuRoot, tempPath);
        const handle = await fs.open(tempPath, 'wx');
        try {
            await handle.writeFile(content, 'utf8');
            await this.syncHandle(handle);
        } finally {
            await handle.close();
        }
        await retryFsOperation(async () => {
            await assertSafePersistencePath(this.akuRoot, tempPath);
            await assertSafePersistencePath(this.akuRoot, targetPath);
            await fs.rename(tempPath, targetPath);
        });
        await this.syncParentDirectory(path.dirname(targetPath));
    }

    async syncHandle(handle) {
        try {
            await handle.sync();
        } catch (error) {
            if (error instanceof AKUError || this.strictFsync) {
                throw error;
            }
        }
    }

    async syncParentDirectory(directoryPath) {
        let handle;
        try {
            await assertSafePersistencePath(this.akuRoot, directoryPath);
            handle = await fs.open(directoryPath, 'r');
            await handle.sync();
        } catch (error) {
            if (error instanceof AKUError || this.strictFsync) {
                throw error;
            }
        } finally {
            if (handle) {
                await handle.close();
            }
        }
    }
}
