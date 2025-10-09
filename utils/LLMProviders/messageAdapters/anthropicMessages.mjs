const ROLE_MAP = {
    human: 'user',
    user: 'user',
    assistant: 'assistant',
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

function isSystem(entry) {
    const role = typeof entry?.role === 'string' ? entry.role.trim().toLowerCase() : '';
    return role === 'system';
}

export function toAnthropicMessages(history = []) {
    const messages = [];
    let system = null;

    if (!Array.isArray(history)) {
        return { system: null, messages };
    }

    for (const entry of history) {
        if (isSystem(entry)) {
            const content = extractContent(entry);
            if (content) {
                system = system ? `${system}\n${content}` : content;
            }
            continue;
        }

        if (typeof entry === 'string') {
            messages.push({ role: 'user', content: [{ type: 'text', text: entry }] });
            continue;
        }

        const content = extractContent(entry);
        if (!content) {
            continue;
        }

        const role = normalizeRole(entry.role || entry.author);
        messages.push({
            role,
            content: [{ type: 'text', text: content }],
        });
    }

    return { system, messages };
}
