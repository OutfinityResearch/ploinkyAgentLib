import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    ALL_INDEX_FILES,
    KUS_DIRNAME,
    KU_DIRECTORIES,
    KU_FILES,
    PENDING_DIRNAME,
    ROOT_FILES,
} from './constants.mjs';
import { AKU_ERROR_CODES, AKUError } from './errors.mjs';
import { validateKuId } from './schemas.mjs';
import {
    assertNoSymlinkInExistingPath,
    createPersistencePathGuard,
    assertSafeIdSegment,
    normalizeRelativePath,
    projectDisplayPath,
    resolvePersistenceRoot,
    resolveRootDir,
    resolveSafeRelative,
} from './paths.mjs';

export class AKUFileStore {
    constructor(options = {}) {
        this.rootDir = resolveRootDir(options.rootDir);
        this.akuRoot = resolvePersistenceRoot(options.persistenceRoot, this.rootDir);
        this.pathGuard = createPersistencePathGuard(this.akuRoot, this.rootDir);
        this.allowSensitivePaths = Boolean(options.allowSensitivePaths);
    }

    rootFile(name) {
        return path.join(this.akuRoot, name);
    }

    kuRoot() {
        return path.join(this.akuRoot, KUS_DIRNAME);
    }

    kuDir(kuId) {
        validateKuId(kuId);
        return path.join(this.kuRoot(), assertSafeIdSegment(kuId, 'KU id'));
    }

    kuFile(kuId, relativePath) {
        const normalized = normalizeRelativePath(relativePath);
        return path.join(this.kuDir(kuId), normalized);
    }

    async exists() {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(this.rootFile(ROOT_FILES.aku));
        try {
            const stat = await fs.lstat(this.rootFile(ROOT_FILES.aku));
            if (stat.isSymbolicLink()) {
                throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'AKU metadata must not be a symbolic link', {
                    path: this.rootFile(ROOT_FILES.aku),
                });
            }
            return stat.isFile();
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }

    async ensureBaseLayout() {
        await this.pathGuard.assertRoot();
        await fs.mkdir(this.akuRoot, { recursive: true });
        await this.pathGuard.assertRoot();
        const pendingDir = await this.assertOwnedPath(path.join(this.akuRoot, PENDING_DIRNAME));
        await fs.mkdir(pendingDir, { recursive: true });
        const kusDir = await this.assertOwnedPath(this.kuRoot());
        await fs.mkdir(kusDir, { recursive: true });
        await this.assertOwnedPath(pendingDir);
        await this.assertOwnedPath(kusDir);
    }

    async ensureKULayout(kuId) {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(this.kuRoot());
        const kuDir = this.kuDir(kuId);
        await this.assertOwnedPath(kuDir);
        await fs.mkdir(kuDir, { recursive: true });
        for (const dir of KU_DIRECTORIES) {
            const directory = await this.assertOwnedPath(path.join(kuDir, dir));
            await fs.mkdir(directory, { recursive: true });
        }
        await this.assertOwnedPath(kuDir);
    }

    async readText(filePath, options = {}) {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(filePath);
        await assertNoSymlinkInExistingPath(filePath, options.root ?? this.akuRoot);
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT' && options.allowMissing) {
                return options.defaultValue ?? '';
            }
            throw error;
        }
    }

    async readJson(filePath, options = {}) {
        const text = await this.readText(filePath, options);
        if (text === '' && options.allowMissing) {
            return options.defaultValue ?? null;
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new AKUError(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Invalid JSON in ${filePath}`, {
                path: filePath,
                cause: error.message,
            });
        }
    }

    async readJsonl(filePath, options = {}) {
        const text = await this.readText(filePath, {
            ...options,
            defaultValue: '',
        });
        return parseJsonl(text, filePath);
    }

    async readRootJson(name, options = {}) {
        return this.readJson(this.rootFile(name), options);
    }

    async readRootJsonl(name, options = {}) {
        return this.readJsonl(this.rootFile(name), options);
    }

    async readKUJson(kuId, relativePath, options = {}) {
        return this.readJson(this.kuFile(kuId, relativePath), options);
    }

    async readKUJsonl(kuId, relativePath, options = {}) {
        return this.readJsonl(this.kuFile(kuId, relativePath), options);
    }

    async readKUText(kuId, relativePath, options = {}) {
        return this.readText(this.kuFile(kuId, relativePath), options);
    }

    async scanKUFolders() {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(this.kuRoot());
        try {
            const entries = await fs.readdir(this.kuRoot(), { withFileTypes: true });
            return entries
                .filter(entry => entry.isDirectory() && entry.name.startsWith('ku_') && entry.name !== 'lock')
                .map(entry => entry.name)
                .sort();
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    async loadKU(kuId) {
        validateKuId(kuId);
        const manifest = await this.readKUJson(kuId, KU_FILES.manifest);
        const state = await this.readKUText(kuId, KU_FILES.state, { allowMissing: true, defaultValue: '' });
        const history = await this.readKUText(kuId, KU_FILES.history, { allowMissing: true, defaultValue: '' });
        const documents = await this.readKUJsonl(kuId, KU_FILES.documents, { allowMissing: true });
        const files = await this.readKUJsonl(kuId, KU_FILES.files, { allowMissing: true });
        const links = await this.readKUJsonl(kuId, KU_FILES.links, { allowMissing: true });
        const results = await this.readKUJsonl(kuId, KU_FILES.results, { allowMissing: true });
        const events = await this.readKUJsonl(kuId, KU_FILES.events, { allowMissing: true });
        const sessions = await this.readKUJsonl(kuId, KU_FILES.sessions, { allowMissing: true });
        return {
            manifest,
            state,
            history,
            documents,
            files,
            links,
            results,
            events,
            sessions,
        };
    }

    async listPendingTransactions() {
        const pendingDir = path.join(this.akuRoot, PENDING_DIRNAME);
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(pendingDir);
        try {
            const entries = await fs.readdir(pendingDir, { withFileTypes: true });
            return entries
                .filter(entry => entry.isFile() && entry.name.startsWith('txn_'))
                .map(entry => path.join(pendingDir, entry.name))
                .sort();
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    async describeProjectFile(relativePath) {
        const described = await this.describeProjectEntry(relativePath);
        if (described.kind !== 'file' && described.kind !== 'missing') {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Registered file path is not a regular file', {
                path: relativePath,
            });
        }
        const { kind, ...rest } = described;
        return rest;
    }

    async describeProjectDirectory(relativePath) {
        const described = await this.describeProjectEntry(relativePath);
        if (described.kind !== 'directory' && described.kind !== 'missing') {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Registered folder scope path is not a directory', {
                path: relativePath,
            });
        }
        const { kind, hash, size, ...rest } = described;
        return {
            ...rest,
            hash: null,
            size: null,
        };
    }

    async describeProjectEntry(relativePath) {
        const resolved = await resolveSafeRelative(this.rootDir, relativePath, {
            allowSensitivePaths: this.allowSensitivePaths,
        });
        try {
            const stat = await fs.stat(resolved.absolute);
            const isFile = stat.isFile();
            const isDirectory = stat.isDirectory();
            if (!isFile && !isDirectory) {
                throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Registered path is not a file or directory', {
                    path: relativePath,
                });
            }
            const hash = isFile ? await hashFile(resolved.absolute) : null;
            return {
                kind: isFile ? 'file' : 'directory',
                path: projectDisplayPath(this.rootDir, resolved.absolute),
                hash,
                size: isFile ? stat.size : null,
                mtime: stat.mtime.toISOString(),
            };
        } catch (error) {
            if (error instanceof AKUError) {
                throw error;
            }
            if (error?.code === 'ENOENT') {
                return {
                    kind: 'missing',
                    path: resolved.relative,
                    hash: null,
                    size: null,
                    mtime: null,
                };
            }
            throw error;
        }
    }

    async fileInfo(name) {
        const filePath = this.rootFile(name);
        const content = await this.readText(filePath);
        const stat = await this.statOwned(filePath);
        const info = {
            sha256: createHash('sha256').update(content).digest('hex'),
            bytes: stat.size,
        };
        if (name.endsWith('.jsonl')) {
            info.records = parseJsonl(content, filePath).length;
        }
        return info;
    }

    async assertOwnedPath(filePath) {
        return this.pathGuard.assertPath(filePath);
    }

    async statOwned(filePath) {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(filePath);
        return fs.stat(filePath);
    }

    async removeOwned(filePath, options = {}) {
        await this.pathGuard.assertRoot();
        await this.assertOwnedPath(filePath);
        return fs.rm(filePath, options);
    }

    async aggregateFileInfos() {
        const files = {};
        for (const name of ALL_INDEX_FILES) {
            files[name] = await this.fileInfo(name);
        }
        return files;
    }
}

export function parseJsonl(text, filePath = '<memory>') {
    if (!text.trim()) {
        return [];
    }
    const records = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) {
            continue;
        }
        try {
            records.push(JSON.parse(line));
        } catch (error) {
            throw new AKUError(AKU_ERROR_CODES.AKU_CORRUPT_INDEX, `Invalid JSONL at ${filePath}:${index + 1}`, {
                path: filePath,
                line: index + 1,
                cause: error.message,
            });
        }
    }
    return records;
}

export function stringifyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function stringifyJsonl(records) {
    if (!records.length) {
        return '';
    }
    return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

export async function hashFile(filePath) {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
}
