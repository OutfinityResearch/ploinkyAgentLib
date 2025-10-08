export const formatArgumentList = (descriptors) => descriptors
    .map((descriptor) => {
        if (descriptor === null || descriptor === undefined) {
            return '';
        }
        const lines = String(descriptor).split('\n');
        if (!lines.length) {
            return '';
        }
        const [first, ...rest] = lines;
        const formatted = [`    - ${first}`];
        for (const line of rest) {
            formatted.push(line ? `      ${line}` : '      ');
        }
        return formatted.join('\n');
    })
    .filter(Boolean)
    .join('\n');
