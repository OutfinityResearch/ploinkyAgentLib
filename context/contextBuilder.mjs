const CONTEXT_ROLE_ALIASES = new Map([
    ['system', 'system'],
    ['user', 'human'],
    ['human', 'human'],
    ['assistant', 'assistant'],
    ['tool', 'assistant'],
    ['function', 'assistant'],
    ['observation', 'assistant'],
]);

const TOOL_LIKE_ROLES = new Set(['tool', 'function', 'observation']);

function limitPreview(value, maxLength = 400) {
    if (value === undefined || value === null) {
        return '';
    }
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch (error) {
            text = String(value);
        }
    }
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildSuggestionBlock(title, lines) {
    if (!lines || !lines.length) {
        return null;
    }
    const body = lines.map(line => `- ${line}`).join('\n');
    return `${title}:\n${body}`;
}

function normalizeAgentKind(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'chat' ? 'chat' : 'task';
}

function buildAgentDescription(agent) {
    const kind = normalizeAgentKind(agent?.kind);
    const isChat = kind === 'chat';
    const classification = isChat ? 'Expert Conversationalist' : 'Expert Task Executor';
    const role = agent?.role ? String(agent.role).trim() : '';
    const job = agent?.job ? String(agent.job).trim() : '';
    const expertise = agent?.expertise ? String(agent.expertise).trim() : '';
    const instructions = agent?.instructions ? String(agent.instructions).trim() : '';
    const details = [
        `Type: ${kind}`,
        `Classification: ${classification}`,
        role && `Role: ${role}`,
        job && `Job: ${job}`,
        expertise && `Expertise: ${expertise}`,
        instructions && `Guidance: ${instructions}`,
    ].filter(Boolean).join(' | ');
    return details;
}

function normalizeTaskContext(_agent, context) {
    if (Array.isArray(context)) {
        const normalizedMessages = context
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }

                const rawRole = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
                const role = CONTEXT_ROLE_ALIASES.get(rawRole);
                if (!role) {
                    return null;
                }

                let message = entry.message;
                if (typeof message === 'undefined' || message === null) {
                    message = entry.content;
                }
                if (typeof message === 'undefined' || message === null) {
                    message = entry.result;
                }
                if (typeof message === 'undefined' || message === null) {
                    message = entry.output;
                }
                if (typeof message === 'undefined' || message === null) {
                    return null;
                }

                if (typeof message === 'object') {
                    try {
                        message = JSON.stringify(message, null, 2);
                    } catch (error) {
                        message = String(message);
                    }
                }

                if (TOOL_LIKE_ROLES.has(rawRole)) {
                    const label = entry.name ? `${rawRole}:${entry.name}` : rawRole;
                    message = `[${label}] ${String(message)}`;
                }

                return {
                    role,
                    message: String(message),
                };
            })
            .filter(Boolean);

        if (normalizedMessages.length) {
            return {
                type: 'messages',
                messages: normalizedMessages,
            };
        }

        return {
            type: 'text',
            text: '',
        };
    }

    const trimmed = context ? String(context).trim() : '';
    return {
        type: 'text',
        text: trimmed,
    };
}

function buildSystemHistory(agent, { instruction, context, description, outputSchema, extraContextParts = [] }) {
    const history = [];
    const agentLabel = agent.canonicalName || agent.name;
    const agentDescription = buildAgentDescription(agent);
    history.push({
        role: 'system',
        message: `You are the ${agentLabel} agent. ${agentDescription} ${instruction}`.trim(),
    });

    const normalizedContext = context && typeof context === 'object' && (context.type === 'text' || context.type === 'messages')
        ? context
        : normalizeTaskContext(agent, context);

    if (normalizedContext.type === 'messages') {
        for (const entry of normalizedContext.messages) {
            history.push({ role: entry.role, message: entry.message });
        }
    }

    const parts = [];
    if (normalizedContext.type === 'text' && normalizedContext.text) {
        parts.push(`Context:\n${normalizedContext.text}`);
    }

    if (Array.isArray(extraContextParts) && extraContextParts.length) {
        for (const part of extraContextParts) {
            if (part) {
                parts.push(part);
            }
        }
    }

    if (description) {
        parts.push(`Task:\n${description}`);
    }
    if (outputSchema) {
        parts.push(`Desired output schema (JSON Schema):\n${JSON.stringify(outputSchema, null, 2)}`);
        parts.push('Respond with JSON that strictly matches the schema.');
    }

    if (parts.length) {
        history.push({
            role: 'human',
            message: parts.join('\n\n'),
        });
    }

    return history;
}

export {
    CONTEXT_ROLE_ALIASES,
    TOOL_LIKE_ROLES,
    buildAgentDescription,
    buildSuggestionBlock,
    buildSystemHistory,
    limitPreview,
    normalizeTaskContext,
};
