import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { AKU_DIRNAME, SENSITIVE_PATH_PARTS } from './constants.mjs';
import { AKU_ERROR_CODES, AKUError } from './errors.mjs';

export function resolveRootDir(rootDir = process.cwd()) {
    return path.resolve(rootDir);
}

export function resolveAkuRoot(rootDir = process.cwd()) {
    return path.join(resolveRootDir(rootDir), AKU_DIRNAME);
}

export function resolvePersistenceRoot(persistenceRoot, rootDir = process.cwd()) {
    if (persistenceRoot === undefined || persistenceRoot === null || persistenceRoot === '') {
        return resolveAkuRoot(rootDir);
    }
    if (typeof persistenceRoot !== 'string' || !persistenceRoot.trim()) {
        throw new AKUError(
            AKU_ERROR_CODES.AKU_PATH_ESCAPE,
            'Persistence root must be a non-empty path string',
            { persistenceRoot },
        );
    }
    return path.resolve(persistenceRoot);
}

export function createPersistencePathGuard(persistenceRoot, projectRoot = persistenceRoot) {
    const root = path.resolve(persistenceRoot);
    const expectedRealRoot = projectExistingPath(root);
    const assertRoot = async () => {
        await assertSafePersistenceRoot(root, projectRoot);
        if (projectExistingPath(root) !== expectedRealRoot) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'AKU persistence root changed its canonical location', {
                path: root,
            });
        }
        return root;
    };
    return {
        assertRoot,
        async assertPath(targetPath) {
            await assertRoot();
            return assertSafePersistencePath(root, targetPath);
        },
    };
}

function projectExistingPath(targetPath) {
    let cursor = path.resolve(targetPath);
    const missing = [];
    while (true) {
        try {
            return path.join(realpathSync(cursor), ...missing);
        } catch (error) {
            if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
                throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'AKU persistence path is unsafe', {
                    path: targetPath,
                });
            }
            if (error?.code !== 'ENOENT') throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor) throw error;
            missing.unshift(path.basename(cursor));
            cursor = parent;
        }
    }
}

export async function assertSafePersistenceRoot(persistenceRoot, projectRoot) {
    const target = path.resolve(persistenceRoot);
    const project = path.resolve(projectRoot);
    const commonRoot = commonPathAncestor(project, target);
    try {
        const commonStat = await fs.lstat(commonRoot);
        if (commonStat.isSymbolicLink()) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Symlinks are not allowed inside AKU persistence paths', {
                path: commonRoot,
            });
        }
    } catch (error) {
        if (error instanceof AKUError) {
            throw error;
        }
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
    await assertNoSymlinkInExistingPath(target, commonRoot);
    try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'AKU persistence root must be a real directory', {
                path: target,
            });
        }
    } catch (error) {
        if (error instanceof AKUError) {
            throw error;
        }
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
    return target;
}

export async function assertSafePersistencePath(persistenceRoot, targetPath) {
    const root = path.resolve(persistenceRoot);
    const target = path.resolve(targetPath);
    if (!isWithin(root, target)) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Resolved path escapes the AKU persistence root', {
            root,
            target,
        });
    }
    try {
        const stat = await fs.lstat(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'AKU persistence root must be a real directory', {
                path: root,
            });
        }
    } catch (error) {
        if (error instanceof AKUError) throw error;
        if (error?.code !== 'ENOENT') throw error;
        return target;
    }
    await assertNoSymlinkInExistingPath(target, root);
    return target;
}

export function normalizeRelativePath(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Path must be a non-empty relative string', { path: input });
    }
    if (input.includes('\0')) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Path contains a null byte', { path: input });
    }
    if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Absolute paths are not allowed here', { path: input });
    }
    const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
    if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Path escapes the trusted root', { path: input });
    }
    return normalized;
}

export function assertSafeIdSegment(value, label = 'path segment') {
    const text = String(value || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text)) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, `Unsafe ${label}: ${value}`, { value });
    }
    return text;
}

export function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function assertNoSymlinkInExistingPath(targetPath, rootPath) {
    const root = path.resolve(rootPath);
    const target = path.resolve(targetPath);
    if (!isWithin(root, target)) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Resolved path escapes the trusted root', {
            root,
            target,
        });
    }

    const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
    let cursor = root;
    for (const part of relativeParts) {
        cursor = path.join(cursor, part);
        try {
            const stat = await fs.lstat(cursor);
            if (stat.isSymbolicLink()) {
                throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Symlinks are not allowed inside AKU paths', {
                    path: cursor,
                });
            }
        } catch (error) {
            if (error instanceof AKUError) {
                throw error;
            }
            if (error?.code === 'ENOENT') {
                break;
            }
            throw error;
        }
    }
}

export async function resolveSafeRelative(rootPath, input, options = {}) {
    const relative = normalizeRelativePath(input);
    rejectSensitivePath(relative, options);
    const absolute = path.resolve(rootPath, relative);
    const root = path.resolve(rootPath);
    if (!isWithin(root, absolute)) {
        throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Path escapes the trusted root', {
            root,
            input,
            absolute,
        });
    }
    await assertNoSymlinkInExistingPath(absolute, root);
    try {
        const realRoot = await fs.realpath(root);
        const realTarget = await fs.realpath(absolute);
        if (!isWithin(realRoot, realTarget)) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Real path escapes the trusted root', {
                root: realRoot,
                target: realTarget,
            });
        }
    } catch (error) {
        if (error instanceof AKUError) {
            throw error;
        }
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
    return { relative, absolute };
}

export function rejectSensitivePath(relativePath, options = {}) {
    if (options.allowSensitivePaths) {
        return;
    }
    const parts = normalizeRelativePath(relativePath).split('/').map(part => part.toLowerCase());
    for (const part of parts) {
        if (SENSITIVE_PATH_PARTS.has(part)) {
            throw new AKUError(AKU_ERROR_CODES.AKU_PATH_ESCAPE, 'Sensitive paths are excluded from AKU indexing', {
                path: relativePath,
            });
        }
    }
}

export function displayPathFromAkuRoot(akuRoot, absolutePath) {
    return path.relative(akuRoot, absolutePath).replace(/\\/g, '/');
}

export function projectDisplayPath(rootDir, absolutePath) {
    return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}

function commonPathAncestor(leftPath, rightPath) {
    const left = path.resolve(leftPath).split(path.sep);
    const right = path.resolve(rightPath).split(path.sep);
    const shared = [];
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count && left[index] === right[index]; index += 1) {
        shared.push(left[index]);
    }
    return path.resolve(shared.join(path.sep) || path.parse(leftPath).root);
}
