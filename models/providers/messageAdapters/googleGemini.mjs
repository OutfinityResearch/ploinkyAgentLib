export function toGeminiPayload(chatContext = []) {
    const contents = [];
    const systemInstruction = { parts: [] };

    for (const reply of chatContext) {
        if (reply.role === 'system') {
            systemInstruction.parts.push({ text: reply.message });
            continue;
        }

        const message = {
            parts: [{ text: reply.message }],
        };

        if (reply.role === 'human' || reply.role === 'user') {
            message.role = 'user';
        } else if (reply.role === 'assistant' || reply.role === 'ai') {
            message.role = 'model';
        } else if (reply.role === 'tool' || reply.role === 'function' || reply.role === 'observation') {
            message.role = 'model';
        } else {
            message.role = message.role || 'user';
        }

        contents.push(message);
    }

    return { contents, systemInstruction };
}
