function normalizeText(entry) {
    if (typeof entry === 'string') {
        return entry;
    }
    if (entry && typeof entry === 'object') {
        if (typeof entry.content === 'string') {
            return entry.content;
        }
        if (typeof entry.message === 'string') {
            return entry.message;
        }
        if (typeof entry.text === 'string') {
            return entry.text;
        }
        if (Array.isArray(entry.content)) {
            return entry.content.map(chunk => (typeof chunk?.text === 'string' ? chunk.text : '')).join('\n').trim();
        }
    }
    return '';
}

function normalizeRole(rawRole, fallback = 'user') {
    if (!rawRole) {
        return fallback;
    }
    const role = String(rawRole).trim().toLowerCase();
    if (role === 'system') {
        return 'system';
    }
    if (role === 'assistant' || role === 'model' || role === 'bot') {
        return 'model';
    }
    return 'user';
}

export function toGeminiPayload(history = []) {
    const contents = [];
    let systemInstruction = null;

    if (!Array.isArray(history)) {
        return { contents };
    }

    for (const entry of history) {
        if (typeof entry === 'string') {
            contents.push({
                role: 'user',
                parts: [{ text: entry }],
            });
            continue;
        }

        const text = normalizeText(entry);
        if (!text) {
            continue;
        }

        const role = normalizeRole(entry.role || entry.author);
        if (role === 'system') {
            systemInstruction = systemInstruction
                ? { role: 'system', parts: [{ text: `${systemInstruction.parts[0].text}\n${text}` }] }
                : { role: 'system', parts: [{ text }] };
            continue;
        }

        contents.push({
            role,
            parts: [{ text }],
        });
    }

    const payload = { contents };
    if (systemInstruction) {
        payload.systemInstruction = systemInstruction;
    }
    return payload;
}
