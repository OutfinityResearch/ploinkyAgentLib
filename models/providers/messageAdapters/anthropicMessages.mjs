export function toAnthropicMessages(chatContext = []) {
    const messages = [];
    const systemParts = [];

    for (const reply of chatContext) {
        if (reply.role === 'system') {
            systemParts.push(reply.message);
            continue;
        }

        const message = {
            role: (reply.role === 'assistant' || reply.role === 'ai') ? 'assistant' : 'user',
            content: reply.message,
        };

        if (reply.role === 'tool' || reply.role === 'function' || reply.role === 'observation') {
            message.role = 'assistant';
        }

        messages.push(message);
    }

    return {
        system: systemParts.length ? systemParts.join('\n\n') : undefined,
        messages,
    };
}
