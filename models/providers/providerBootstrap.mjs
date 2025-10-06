import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerProvider } from './providerRegistry.mjs';

async function resolveModuleExports(moduleId, baseDir) {
    const isRelativeOrAbsolute = moduleId.startsWith('.') || moduleId.startsWith('/');
    const resolvedId = isRelativeOrAbsolute ? path.resolve(baseDir, moduleId) : moduleId;

    if (isRelativeOrAbsolute) {
        const moduleUrl = pathToFileURL(resolvedId).href;
        const exports = await import(moduleUrl);
        return { exports, resolvedId };
    }

    const exports = await import(resolvedId);
    return { exports, resolvedId };
}

function extractHandler(exports) {
    if (!exports) {
        return null;
    }

    if (typeof exports.callLLM === 'function') {
        return exports;
    }

    if (typeof exports === 'function') {
        return { callLLM: exports };
    }

    if (exports.default) {
        return extractHandler(exports.default);
    }

    return null;
}

export async function registerProvidersFromConfig(modelsConfiguration, options = {}) {
    const warnings = [];
    const baseDir = options.baseDir
        || (modelsConfiguration.path ? path.dirname(modelsConfiguration.path) : __dirname);

    for (const provider of modelsConfiguration.providers.values()) {
        const moduleId = provider.module;
        if (!moduleId) {
            continue;
        }

        try {
            const { exports, resolvedId } = await resolveModuleExports(moduleId, baseDir);
            const handler = extractHandler(exports);
            if (!handler) {
                warnings.push(`Provider "${provider.providerKey}" module "${moduleId}" does not export a callLLM handler.`);
                continue;
            }

            registerProvider({
                key: provider.providerKey,
                handler,
                metadata: {
                    module: moduleId,
                    resolvedModule: resolvedId,
                    source: 'config',
                },
            });
        } catch (error) {
            warnings.push(`Failed to register provider "${provider.providerKey}" from module "${moduleId}": ${error.message}`);
        }
    }

    if (warnings.length && modelsConfiguration?.issues?.warnings) {
        modelsConfiguration.issues.warnings.push(...warnings);
    }

    return warnings;
}
