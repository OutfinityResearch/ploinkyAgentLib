import fs from 'node:fs';
import path from 'node:path';

import { Sanitiser } from '../../utils/Sanitiser.mjs';

const SKILL_FILE_TYPES = {
    'dcgskill.md': { type: 'dynamic-code-generation' },
    'cskill.md': { type: 'cskill' },
    'oskill.md': { type: 'orchestrator' },
    'tskill.md': { type: 'dbtable' },
};

function isReadableFile(candidate) {
    try {
        const stats = fs.statSync(candidate);
        return stats.isFile();
    } catch {
        return false;
    }
}

function isDirectory(candidate) {
    try {
        const stats = fs.statSync(candidate);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

function sanitiseName(value) {
    return Sanitiser.sanitiseName(value);
}

function createSkillRecord({ filePath, type, skillDir }) {
    const shortName = path.basename(skillDir);
    const baseName = sanitiseName(shortName);
    const canonicalName = sanitiseName(`${baseName}-${type}`) || sanitiseName(`${shortName}-${type}`);

    return {
        name: canonicalName,
        type,
        descriptor: null,
        filePath,
        skillDir,
        shortName,
        preparedConfig: null,
    };
}

function scanDirectory(dirPath, entries) {
    const results = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const skillDir = path.join(dirPath, entry.name);
        const discovered = discoverFromDirectory(skillDir);
        results.push(...discovered);
    }
    return results;
}

function discoverFromDirectory(skillDir) {
    const skills = [];
    let descriptorFound = false;

    for (const [filename, descriptor] of Object.entries(SKILL_FILE_TYPES)) {
        const filePath = path.join(skillDir, filename);
        if (!isReadableFile(filePath)) {
            continue;
        }

        descriptorFound = true;
        const skillRecord = createSkillRecord({ filePath, type: descriptor.type, skillDir });
        if (skillRecord) {
            skills.push(skillRecord);
        }
    }

    if (descriptorFound) {
        return skills;
    }

    let entries = [];
    try {
        entries = fs.readdirSync(skillDir, { withFileTypes: true });
    } catch {
        return skills;
    }

    const nested = scanDirectory(skillDir, entries);
    skills.push(...nested);

    return skills;
}

function collectSkillsDescending(startDir) {
    if (!startDir) {
        return [];
    }
    if (!isDirectory(startDir)) {
        return [];
    }
    const roots = [];
    const queue = [path.resolve(startDir)];
    const visited = new Set();

    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);

        const candidate = path.join(current, 'skills');
        if (isDirectory(candidate)) {
            roots.push(candidate);
        }

        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }
            if (entry.name === 'node_modules') {
                continue;
            }
            if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
                continue;
            }
            const nextPath = path.join(current, entry.name);
            if (!visited.has(nextPath)) {
                queue.push(nextPath);
            }
        }
    }
    return roots;
}

export function discoverSkills(startDir, { logger = console } = {}) {
    const resolvedStartDir = startDir ? path.resolve(startDir) : process.cwd();
    const roots = collectSkillsDescending(resolvedStartDir);

    logger.debug(`MainAgent:discoverSkills: ${resolvedStartDir}: found ${roots.length} skill dirs`);

    const allSkills = [];
    for (const root of roots) {
        const skills = discoverFromRoot(root, { logger });
        logger.debug(`MainAgent:discoverSkillsFromDir: ${root}: found ${skills.length} skills`);
        allSkills.push(...skills);
    }

    logger.debug(`MainAgent:discoverSkills: ${resolvedStartDir}: found ${allSkills.length} skills total`);

    return allSkills;
}

export function discoverSkillsFromRoot(skillsDir, { logger = console } = {}) {
    if (!skillsDir || !isDirectory(skillsDir)) {
        return [];
    }

    const skills = discoverFromRoot(skillsDir, { logger });

    logger.debug(`MainAgent:discoverSkillsFromDir: ${skillsDir}: found ${skills.length} skills`);

    return skills;
}

function discoverFromRoot(rootDir, { logger = console }) {
    const skills = [];
    let entries = [];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (error) {
        logger?.warn?.(`[MainAgent] Failed to read skills directory ${rootDir}: ${error.message}`);
        return skills;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const skillDir = path.join(rootDir, entry.name);
        const discovered = discoverFromDirectory(skillDir);
        skills.push(...discovered);
    }

    return skills;
}
