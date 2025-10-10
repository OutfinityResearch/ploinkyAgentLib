import fs from 'node:fs';
import path from 'node:path';

function findDotEnvFile(startDir = process.cwd()) {
    let current = path.resolve(startDir);
    const { root } = path.parse(current);

    while (true) {
        const candidate = path.join(current, '.env');
        try {
            const stats = fs.statSync(candidate);
            if (stats.isFile()) {
                return candidate;
            }
        } catch (error) {
            // Ignore missing files/directories
        }

        if (current === root) {
            return null;
        }
        current = path.dirname(current);
    }
}

function unquote(value) {
    if (!value || value.length < 2) {
        return value;
    }

    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
        const inner = value.slice(1, -1);
        return inner
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\0/g, '\0')
            .replace(/\\\\/g, '\\')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, '\'');
    }
    return value;
}

function parseEnvContent(content) {
    const variables = {};
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) {
            continue;
        }

        const [, key, rawValue] = match;
        const value = unquote(rawValue.trim());
        variables[key] = value;
    }

    return variables;
}

export function envAutoConfig({ startDir = process.cwd(), override = false } = {}) {
    const envPath = findDotEnvFile(startDir);
    if (!envPath) {
        console.info('[ploinkyAgentLib] No .env file found during auto-config.');
        return {
            loaded: false,
            path: null,
            variables: {},
        };
    }

    let content;
    try {
        content = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
        console.error(`[ploinkyAgentLib] Failed to read .env file at ${envPath}: ${error.message}`);
        return {
            loaded: false,
            path: envPath,
            variables: {},
            error,
        };
    }

    const parsedVariables = parseEnvContent(content);
    const appliedVariables = {};
    const retainedKeys = [];

    for (const [key, value] of Object.entries(parsedVariables)) {
        const alreadySet = Object.prototype.hasOwnProperty.call(process.env, key);
        if (alreadySet && !override) {
            retainedKeys.push(key);
            continue;
        }
        process.env[key] = value;
        appliedVariables[key] = value;
    }

    const appliedKeys = Object.keys(appliedVariables);
    const reportedRetained = retainedKeys.filter((key) => !appliedKeys.includes(key));
    const allKeys = Object.keys(parsedVariables);

    console.info(`[ploinkyAgentLib] Loaded environment variables from ${envPath}`);
    if (allKeys.length) {
        console.info(`[ploinkyAgentLib] Available .env keys: ${allKeys.join(', ')}`);
    }
    if (appliedKeys.length) {
        console.info(`[ploinkyAgentLib] Applied keys: ${appliedKeys.join(', ')}`);
    }
    if (reportedRetained.length) {
        console.info(`[ploinkyAgentLib] Retained existing keys: ${reportedRetained.join(', ')}`);
    }

    return {
        loaded: true,
        path: envPath,
        variables: appliedVariables,
    };
}
