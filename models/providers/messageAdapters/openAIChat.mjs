export function toOpenAIChatMessages(chatContext = []) {
    const convertedContext = [];
    for (const reply of chatContext) {
        const normalized = {
            content: reply.message,
        };

        switch (reply.role) {
            case 'system':
                normalized.role = 'system';
                break;
            case 'assistant':
            case 'ai':
                normalized.role = 'assistant';
                break;
            case 'user':
            case 'human':
                normalized.role = 'user';
                break;
            case 'tool':
            case 'function':
            case 'observation':
                normalized.role = 'tool';
                break;
            default:
                normalized.role = 'user';
                break;
        }

        convertedContext.push(normalized);
    }
    return convertedContext;
}
