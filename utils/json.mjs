function safeJsonParse(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let text = value.trim();

    // Strip Markdown-style code fences so JSON.parse has a clean payload.
    const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }

    if (!text.startsWith('{') && !text.startsWith('[')) {
        const startBrace = text.indexOf('{');
        const startBracket = text.indexOf('[');
        const startCandidates = [startBrace, startBracket].filter(index => index !== -1);
        if (startCandidates.length) {
            const start = Math.min(...startCandidates);
            const endBrace = text.lastIndexOf('}');
            const endBracket = text.lastIndexOf(']');
            const endCandidates = [endBrace, endBracket].filter(index => index !== -1);
            if (endCandidates.length) {
                const end = Math.max(...endCandidates);
                if (end >= start) {
                    text = text.slice(start, end + 1).trim();
                }
            }
        }
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

export {
    safeJsonParse,
};
