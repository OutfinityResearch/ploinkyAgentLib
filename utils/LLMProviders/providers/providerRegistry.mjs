const registry = new Map();

function normalizeKey(key) {
    return typeof key === 'string' ? key.trim().toLowerCase() : '';
}

export function registerProvider({ key, handler, metadata = {} }) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
        throw new Error('registerProvider requires a non-empty provider key.');
    }

    if (!handler || typeof handler.callLLM !== 'function') {
        throw new Error(`Provider "${key}" must expose a callLLM function.`);
    }

    registry.set(normalizedKey, {
        key: normalizedKey,
        handler,
        metadata,
    });
}

export function getProviderRecord(key) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
        return null;
    }
    return registry.get(normalizedKey) || null;
}

export function getProvider(key) {
    return getProviderRecord(key)?.handler || null;
}

export function ensureProvider(key) {
    const record = getProviderRecord(key);
    if (!record) {
        throw new Error(`Provider "${key}" is not registered. Ensure its module has been loaded.`);
    }
    return record.handler;
}

export function listProviders() {
    return Array.from(registry.keys());
}

export function resetProviders() {
    registry.clear();
}
