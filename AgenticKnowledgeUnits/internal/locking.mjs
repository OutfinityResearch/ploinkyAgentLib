import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { KUS_DIRNAME, LOCK_DEFAULTS, RETRY_DEFAULTS, ROOT_LOCK_NAME } from './constants.mjs';
import { AKU_ERROR_CODES, AKUError } from './errors.mjs';
import { assertSafePersistencePath } from './paths.mjs';
import { isoNow, validateKuId } from './schemas.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class AKULockManager {
    constructor(options = {}) {
        this.akuRoot = options.akuRoot;
        this.actor = options.actor ?? 'unknown';
        this.clock = options.clock ?? (() => new Date());
        this.timeoutMs = options.timeoutMs ?? LOCK_DEFAULTS.timeoutMs;
        this.staleMs = options.staleMs ?? LOCK_DEFAULTS.staleMs;
        this.refreshMs = options.refreshMs ?? LOCK_DEFAULTS.refreshMs;
    }

    lockPath(scope, kuId) {
        if (scope === 'root') {
            return path.join(this.akuRoot, ROOT_LOCK_NAME);
        }
        if (scope === 'ku') {
            validateKuId(kuId);
            return path.join(this.akuRoot, KUS_DIRNAME, kuId, ROOT_LOCK_NAME);
        }
        throw new AKUError(AKU_ERROR_CODES.AKU_SCHEMA_ERROR, `Unknown lock scope: ${scope}`, { scope });
    }

    async acquire(scope, options = {}) {
        const lockPath = this.lockPath(scope, options.kuId);
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const staleMs = options.staleMs ?? this.staleMs;
        const started = Date.now();
        let attempt = 0;

        while (true) {
            try {
                await assertSafePersistencePath(this.akuRoot, lockPath);
                await fs.mkdir(lockPath);
                await assertSafePersistencePath(this.akuRoot, lockPath);
                const lock = {
                    scope,
                    kuId: options.kuId ?? null,
                    path: lockPath,
                    label: options.label ?? scope,
                    owner: this.actor,
                    pid: process.pid,
                    hostname: os.hostname(),
                    created_at: isoNow(this.clock),
                    refreshed_at: isoNow(this.clock),
                };
                await this.writeMetadata(lock);
                lock.refreshTimer = this.startAutoRefresh(lock);
                return lock;
            } catch (error) {
                if (error?.code !== 'EEXIST') {
                    throw error;
                }
                if (await this.isStale(lockPath, staleMs)) {
                    await this.removeLockDirectory(lockPath);
                    continue;
                }
                if (Date.now() - started >= timeoutMs) {
                    throw new AKUError(AKU_ERROR_CODES.AKU_LOCK_TIMEOUT, `Timed out acquiring ${scope} AKU lock`, {
                        scope,
                        kuId: options.kuId ?? null,
                        lockPath,
                        timeoutMs,
                    });
                }
                const backoff = RETRY_DEFAULTS.backoffMs[Math.min(attempt, RETRY_DEFAULTS.backoffMs.length - 1)];
                attempt += 1;
                await sleep(backoff);
            }
        }
    }

    async acquireRootAndKU(kuId, label) {
        const rootLock = await this.acquire('root', { label });
        try {
            const kuLock = await this.acquire('ku', { kuId, label });
            return [rootLock, kuLock];
        } catch (error) {
            await this.release(rootLock);
            throw error;
        }
    }

    async writeMetadata(lock) {
        const metadataPath = path.join(lock.path, 'metadata.json');
        await assertSafePersistencePath(this.akuRoot, lock.path);
        await assertSafePersistencePath(this.akuRoot, metadataPath);
        const metadata = {
            owner: lock.owner,
            pid: lock.pid,
            hostname: lock.hostname,
            created_at: lock.created_at,
            refreshed_at: lock.refreshed_at,
            operation: lock.label,
            scope: lock.scope,
            ku_id: lock.kuId,
        };
        await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    }

    startAutoRefresh(lock) {
        const timer = setInterval(() => {
            this.refresh(lock).catch(() => {});
        }, this.refreshMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        return timer;
    }

    async refresh(lock) {
        lock.refreshed_at = isoNow(this.clock);
        await this.writeMetadata(lock);
    }

    async release(lock) {
        if (!lock) {
            return;
        }
        if (lock.refreshTimer) {
            clearInterval(lock.refreshTimer);
        }
        await this.removeLockDirectory(lock.path);
    }

    async releaseAll(locks) {
        for (const lock of [...locks].reverse()) {
            await this.release(lock);
        }
    }

    async isStale(lockPath, staleMs = this.staleMs) {
        try {
            await assertSafePersistencePath(this.akuRoot, lockPath);
            const stat = await fs.stat(lockPath);
            const mtimeAge = Date.now() - stat.mtimeMs;
            const metadata = await readMetadata(lockPath, this.akuRoot);
            const refreshed = metadata?.refreshed_at ? Date.parse(metadata.refreshed_at) : stat.mtimeMs;
            const metadataAge = Date.now() - refreshed;
            return mtimeAge > staleMs && metadataAge > staleMs;
        } catch (error) {
            if (error instanceof AKUError) throw error;
            if (error?.code === 'ENOENT') {
                return false;
            }
            return false;
        }
    }

    async removeLockDirectory(lockPath) {
        await retryFsOperation(async () => {
            await assertSafePersistencePath(this.akuRoot, lockPath);
            await fs.rm(lockPath, { recursive: true, force: true });
        });
    }
}

export async function readMetadata(lockPath, akuRoot = path.dirname(lockPath)) {
    try {
        await assertSafePersistencePath(akuRoot, lockPath);
        await assertSafePersistencePath(akuRoot, path.join(lockPath, 'metadata.json'));
        const text = await fs.readFile(path.join(lockPath, 'metadata.json'), 'utf8');
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof AKUError) throw error;
        return null;
    }
}

export async function retryFsOperation(operation, options = {}) {
    const attempts = options.attempts ?? RETRY_DEFAULTS.attempts;
    const backoffMs = options.backoffMs ?? RETRY_DEFAULTS.backoffMs;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const backoff = backoffMs[Math.min(attempt, backoffMs.length - 1)];
            await sleep(backoff);
        }
    }
    throw lastError;
}
