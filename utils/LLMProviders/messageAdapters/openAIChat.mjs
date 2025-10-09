const ROLE_MAP = {
    system: 'system',
    human: 'user',
    user: 'user',
    assistant: 'assistant',
    bot: 'assistant',
    model: 'assistant',
};

function normalizeRole(rawRole) {
    const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
    return ROLE_MAP[role] || 'user';
}

function extractContent(entry) {
    if (!entry || typeof entry !== 'object') {
        return '';
    }
    if (typeof entry.content === 'string') {
        return entry.content;
    }
    if (Array.isArray(entry.content)) {
        return entry.content.map(chunk => (typeof chunk?.text === 'string' ? chunk.text : '')).join('\n').trim();
    }
    if (typeof entry.message === 'string') {
        return entry.message;
    }
    if (typeof entry.text === 'string') {
        return entry.text;
    }
    return '';
}

function normalizeEntry(entry) {
    if (typeof entry === 'string') {
        return { role: 'user', content: entry };
    }
    const role = normalizeRole(entry.role || entry.author);
    const content = extractContent(entry);
    if (!content) {
        return null;
    }
    return { role, content };
}

export function toOpenAIChatMessages(history = []) {
    if (!Array.isArray(history)) {
        return [];
    }
    return history
        .map(normalizeEntry)
        .filter(Boolean);
}
