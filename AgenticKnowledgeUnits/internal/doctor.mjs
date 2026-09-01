import path from 'node:path';
import { ALL_INDEX_FILES, ROOT_FILES, ROOT_LOCK_NAME } from './constants.mjs';
import { AKU_ERROR_CODES, AKUError } from './errors.mjs';

export class AKUDoctor {
    constructor(options = {}) {
        this.store = options.store;
        this.lockManager = options.lockManager;
        this.rebuildIndexes = options.rebuildIndexes;
    }

    async run(options = {}) {
        const autoRepair = options.autoRepair ?? true;
        const issues = [];
        let repaired = false;

        if (!(await this.store.exists())) {
            issues.push(issue(AKU_ERROR_CODES.AKU_NOT_FOUND, 'AKU has not been initialized', this.store.rootFile(ROOT_FILES.aku)));
            return { ok: false, repaired, rebuilt: false, issues };
        }

        await this.checkPending(issues);
        await this.checkMissingIndexes(issues);
        await this.checkParseableIndexes(issues);
        await this.checkChecksums(issues);
        await this.checkLocks(issues, autoRepair);

        const repairable = issues.some(item => [
            AKU_ERROR_CODES.AKU_TRANSACTION_PENDING,
            AKU_ERROR_CODES.AKU_CORRUPT_INDEX,
            AKU_ERROR_CODES.AKU_REBUILD_REQUIRED,
        ].includes(item.code));

        let rebuilt = false;
        if (autoRepair && repairable) {
            await this.removePendingMarkers(issues);
            await this.rebuildIndexes();
            rebuilt = true;
            repaired = true;
            for (const item of issues) {
                if ([
                    AKU_ERROR_CODES.AKU_TRANSACTION_PENDING,
                    AKU_ERROR_CODES.AKU_CORRUPT_INDEX,
                    AKU_ERROR_CODES.AKU_REBUILD_REQUIRED,
                ].includes(item.code)) {
                    item.repaired = true;
                }
            }
        }

        const unrepaired = issues.filter(item => !item.repaired);
        return {
            ok: unrepaired.length === 0,
            repaired,
            rebuilt,
            issues,
        };
    }

    async assertHealthy(options = {}) {
        const report = await this.run({ autoRepair: Boolean(options.autoRepair) });
        if (report.ok) {
            return report;
        }
        const pending = report.issues.find(item => item.code === AKU_ERROR_CODES.AKU_TRANSACTION_PENDING);
        if (pending) {
            throw new AKUError(
                AKU_ERROR_CODES.AKU_TRANSACTION_PENDING,
                'AKU has pending transaction markers; run doctor({ autoRepair: true }) or rebuildIndexes()',
                { report },
            );
        }
        throw new AKUError(
            AKU_ERROR_CODES.AKU_REBUILD_REQUIRED,
            'AKU indexes are missing, corrupt, or inconsistent; run doctor({ autoRepair: true }) or rebuildIndexes()',
            { report },
        );
    }

    async checkPending(issues) {
        const pending = await this.store.listPendingTransactions();
        for (const marker of pending) {
            issues.push(issue(AKU_ERROR_CODES.AKU_TRANSACTION_PENDING, 'Pending AKU transaction marker exists', marker));
        }
    }

    async checkMissingIndexes(issues) {
        const required = [ROOT_FILES.indexMeta, ...ALL_INDEX_FILES];
        for (const name of required) {
            try {
                await this.store.statOwned(this.store.rootFile(name));
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    issues.push(issue(AKU_ERROR_CODES.AKU_REBUILD_REQUIRED, `Missing AKU index file: ${name}`, this.store.rootFile(name)));
                    continue;
                }
                throw error;
            }
        }
    }

    async checkParseableIndexes(issues) {
        for (const name of ALL_INDEX_FILES) {
            try {
                if (name.endsWith('.jsonl')) {
                    await this.store.readRootJsonl(name, { allowMissing: true });
                } else {
                    await this.store.readRootJson(name, { allowMissing: true });
                }
            } catch (error) {
                issues.push(issue(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Corrupt AKU index file: ${name}`, this.store.rootFile(name), {
                    cause: error.message,
                }));
            }
        }
        try {
            await this.store.readRootJson(ROOT_FILES.indexMeta, { allowMissing: true });
        } catch (error) {
            issues.push(issue(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, 'Corrupt AKU index metadata', this.store.rootFile(ROOT_FILES.indexMeta), {
                cause: error.message,
            }));
        }
    }

    async checkChecksums(issues) {
        let meta;
        try {
            meta = await this.store.readRootJson(ROOT_FILES.indexMeta, { allowMissing: true });
        } catch {
            return;
        }
        if (!meta?.files) {
            return;
        }
        for (const [name, expected] of Object.entries(meta.files)) {
            try {
                const actual = await this.store.fileInfo(name);
                if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
                    issues.push(issue(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Checksum mismatch for ${name}`, this.store.rootFile(name), {
                        expected,
                        actual,
                    }));
                }
                if (typeof expected.records === 'number' && expected.records !== actual.records) {
                    issues.push(issue(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Record count mismatch for ${name}`, this.store.rootFile(name), {
                        expected,
                        actual,
                    }));
                }
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    issues.push(issue(AKU_ERROR_CODES.AKU_REBUILD_REQUIRED, `Missing AKU index file: ${name}`, this.store.rootFile(name)));
                } else if (error instanceof AKUError || error?.code === AKU_ERROR_CODES.AKU_CORRUPT_INDEX) {
                    issues.push(issue(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Corrupt AKU index file: ${name}`, this.store.rootFile(name), {
                        cause: error.message,
                    }));
                } else {
                    throw error;
                }
            }
        }
    }

    async checkLocks(issues, autoRepair) {
        const lockPaths = [path.join(this.store.akuRoot, ROOT_LOCK_NAME)];
        for (const kuId of await this.store.scanKUFolders()) {
            lockPaths.push(path.join(this.store.akuRoot, 'kus', kuId, ROOT_LOCK_NAME));
        }
        for (const lockPath of lockPaths) {
            try {
                await this.store.statOwned(lockPath);
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            if (await this.lockManager.isStale(lockPath)) {
                const item = issue(AKU_ERROR_CODES.AKU_STALE_LOCK, 'Stale AKU lock detected', lockPath);
                if (autoRepair) {
                    await this.lockManager.removeLockDirectory(lockPath);
                    item.repaired = true;
                }
                issues.push(item);
            }
        }
    }

    async removePendingMarkers(issues) {
        const pending = await this.store.listPendingTransactions();
        for (const marker of pending) {
            await this.store.removeOwned(marker, { force: true });
        }
        for (const item of issues) {
            if (item.code === AKU_ERROR_CODES.AKU_TRANSACTION_PENDING) {
                item.repaired = true;
            }
        }
    }
}

function issue(code, message, filePath, details = {}) {
    return {
        code,
        message,
        path: filePath,
        repaired: false,
        ...details,
    };
}
