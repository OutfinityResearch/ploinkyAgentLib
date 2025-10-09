const ROLE_LABELS = {
    system: 'System',
    human: 'User',
    user: 'User',
    assistant: 'Assistant',
    model: 'Assistant',
    bot: 'Assistant',
};

function normalizeRole(rawRole) {
    const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
    return ROLE_LABELS[role] || 'User';
}

function extractContent(entry) {
    if (typeof entry === 'string') {
        return entry;
    }
    if (!entry || typeof entry !== 'object') {
        return '';
    }
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
    return '';
}

export function toHuggingFacePrompt(history = []) {
    if (!Array.isArray(history)) {
        return '';
    }

    const lines = [];
    for (const entry of history) {
        const content = extractContent(entry);
        if (!content) {
            continue;
        }

        const roleLabel = normalizeRole(entry?.role || entry?.author);
        if (roleLabel === 'System') {
            lines.push(`System: ${content}`);
            continue;
        }

        lines.push(`${roleLabel}: ${content}`);
    }

    return lines.join('\n');
}
