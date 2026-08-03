const ROLE_MAP = {
    system: 'system',
    developer: 'developer',
    human: 'user',
    user: 'user',
    assistant: 'assistant',
    bot: 'assistant',
    model: 'assistant',
    tool: 'tool',
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
        return normalizeContentParts(entry.content);
    }
    return entry.content ?? '';
}

function normalizeEntry(entry) {
    if (typeof entry === 'string') {
        return { role: 'user', content: entry };
    }
    const role = normalizeRole(entry.role || entry.author);
    const content = extractContent(entry);
    if (!content && !Array.isArray(content) && !entry.tool_calls && role !== 'tool') {
        return null;
    }

    const normalized = { role, content };

    if (entry.tool_calls && Array.isArray(entry.tool_calls)) {
        normalized.tool_calls = entry.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            type: toolCall.type || 'function',
            function: {
                name: toolCall.function?.name || toolCall.name || '',
                arguments: toolCall.function?.arguments || toolCall.arguments || '',
            },
        }));
    }

    if (role === 'tool' && entry.tool_call_id) {
        normalized.tool_call_id = entry.tool_call_id;
    }

    if (entry.name) {
        normalized.name = entry.name;
    }

    return normalized;
}

export function toOpenAIChatMessages(history = []) {
    if (!Array.isArray(history)) {
        return [];
    }
    return history
        .map(normalizeEntry)
        .filter(Boolean);
}

function normalizeContentParts(parts) {
    return parts.map((part) => {
        if (!part || typeof part !== 'object') {
            return { type: 'text', text: String(part ?? '') };
        }

        if (part.type === 'text') {
            return { type: 'text', text: part.text || '' };
        }

        if (part.type === 'input_text') {
            return { type: 'text', text: part.text || '' };
        }

        if (part.type === 'image_url') {
            return {
                type: 'image_url',
                image_url: {
                    url: part.image_url?.url || part.url || '',
                },
            };
        }

        if (part.type === 'input_image') {
            return {
                type: 'image_url',
                image_url: {
                    url: part.image_url || part.url || '',
                },
            };
        }

        return part;
    });
}
