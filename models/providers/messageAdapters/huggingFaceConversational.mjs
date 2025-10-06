export function toHuggingFacePrompt(chatContext = []) {
    const lines = chatContext.map(reply => {
        const role = reply.role === 'human'
            ? 'User'
            : reply.role === 'system'
                ? 'System'
                : 'Assistant';
        return `${role}: ${reply.message}`;
    });

    lines.push('Assistant: ');
    return `${lines.join('\n')}\n`;
}
