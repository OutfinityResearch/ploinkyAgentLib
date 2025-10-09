const ACCEPT_PATTERNS = [
    /\baccept(?:ed|ing)?\b/i,
    /\bconfirmed?\b/i,
    /\bok(?:ay)?\b/i,
    /\bye[as]\b/i,
    /\bgo ahead\b/i,
    /\bsounds good\b/i,
    /\blet'?s go\b/i,
    /\ball good\b/i,
];

const CANCEL_PATTERNS = [
    /\bcancel(?:led|ing)?\b/i,
    /\bstop\b/i,
    /\bno thank(?:s| you)\b/i,
    /\bnevermind\b/i,
    /\bdo not proceed\b/i,
    /\babort\b/i,
    /\bforget it\b/i,
];

const UPDATE_HINT_PATTERNS = [
    /\bchange\b/i,
    /\bupdate\b/i,
    /\bset\b/i,
    /\bshould be\b/i,
    /\bmake it\b/i,
];

const IDEA_LINE_REGEX = /^(?:\s*(?:[-*+]|\d+[.)-]))\s+(.+)$/i;
const KEY_VALUE_REGEX = /^(?:\s*(?:[-*+]|\d+[.)-]))?\s*([A-Za-z0-9_\- ]+)\s*[:=]\s*(.+)$/;
const TABLE_ROW_REGEX = /^\|(.+)\|$/;
const CODE_FENCE_REGEX = /```[a-zA-Z0-9]*\n([\s\S]*?)```/g;
const HEADING_REGEX = /^(#{1,6})\s+(.*)$/;

function normalize(text) {
    return (text || '').toString().trim();
}

function splitLines(text) {
    return normalize(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function extractKeyValuePairs(markdown) {
    const result = {};
    if (!markdown) {
        return result;
    }

    const text = normalize(markdown);

    const processLine = (line) => {
        const match = line.match(KEY_VALUE_REGEX);
        if (match) {
            const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
            const value = match[2].trim();
            if (key) {
                result[key] = value;
            }
        }
    };

    // Code fences
    let fenceMatch;
    while ((fenceMatch = CODE_FENCE_REGEX.exec(text)) !== null) {
        const fenceLines = splitLines(fenceMatch[1]);
        fenceLines.forEach(processLine);
    }

    // Tables
    const lines = splitLines(text);
    for (const line of lines) {
        const tableMatch = line.match(TABLE_ROW_REGEX);
        if (tableMatch) {
            const cells = tableMatch[1].split('|').map(cell => cell.trim()).filter(Boolean);
            if (cells.length >= 2) {
                const key = cells[0].toLowerCase().replace(/\s+/g, '_');
                const value = cells[1];
                if (key) {
                    result[key] = value;
                }
            }
            continue;
        }
        processLine(line);
    }

    return result;
}

function extractIdeaList(markdown) {
    if (!markdown) {
        return [];
    }
    const ideas = [];
    const lines = splitLines(markdown);
    for (const line of lines) {
        const match = line.match(IDEA_LINE_REGEX);
        if (match && match[1]) {
            ideas.push(match[1].trim());
        }
    }
    return ideas;
}

function containsPattern(text, patterns) {
    const normalized = normalize(text);
    return patterns.some(pattern => pattern.test(normalized));
}

function classifyIntent(message, { intents = [] } = {}) {
    const normalized = normalize(message);
    if (!normalized) {
        return { intent: 'unknown', confidence: 0 };
    }

    const lowerText = normalized.toLowerCase();

    if (!intents.length || intents.includes('accept')) {
        if (containsPattern(normalized, ACCEPT_PATTERNS)) {
            return { intent: 'accept', confidence: 0.9 };
        }
    }

    if (!intents.length || intents.includes('cancel')) {
        if (containsPattern(normalized, CANCEL_PATTERNS)) {
            return { intent: 'cancel', confidence: 0.9 };
        }
    }

    const keyValues = extractKeyValuePairs(normalized);
    const ideas = extractIdeaList(normalized);

    if ((!intents.length || intents.includes('ideas')) && ideas.length >= 2) {
        return { intent: 'ideas', confidence: 0.8, ideas };
    }

    if (!intents.length || intents.includes('update')) {
        const explicitUpdate = Object.keys(keyValues).length > 0 && !keyValues.intent && !keyValues.action;
        const hintUpdate = containsPattern(normalized, UPDATE_HINT_PATTERNS);
        if (explicitUpdate || hintUpdate) {
            return { intent: 'update', confidence: explicitUpdate ? 0.8 : 0.5, updates: keyValues };
        }
    }

    if (keyValues.intent || keyValues.action) {
        const intent = (keyValues.intent || keyValues.action || '').toLowerCase();
        if (intent === 'accept' || intent === 'cancel' || intent === 'update') {
            const updates = { ...keyValues };
            delete updates.intent;
            delete updates.action;
            return {
                intent,
                confidence: 0.7,
                updates,
            };
        }
    }

    return { intent: 'unknown', confidence: 0, updates: Object.keys(keyValues).length ? keyValues : undefined, ideas: ideas.length ? ideas : undefined };
}

function responseToJSON(markdown) {
    if (!markdown) {
        return { sections: [] };
    }

    const lines = splitLines(markdown);
    const sections = [];
    let currentSection = null;

    const flushSection = () => {
        if (currentSection) {
            sections.push({ ...currentSection });
        }
    };

    for (const line of lines) {
        const headingMatch = line.match(HEADING_REGEX);
        if (headingMatch) {
            flushSection();
            currentSection = {
                title: headingMatch[2].trim(),
                level: headingMatch[1].length,
                keyValues: {},
                ideas: [],
                raw: [],
            };
            continue;
        }

        if (!currentSection) {
            currentSection = {
                title: 'Summary',
                level: 1,
                keyValues: {},
                ideas: [],
                raw: [],
            };
        }

        currentSection.raw.push(line);

        const kv = extractKeyValuePairs(line);
        Object.assign(currentSection.keyValues, kv);

        const ideas = extractIdeaList(line);
        if (ideas.length) {
            currentSection.ideas.push(...ideas);
        }
    }

    flushSection();

    return {
        sections: sections.map(section => ({
            title: section.title,
            level: section.level,
            keyValues: section.keyValues,
            ideas: section.ideas,
            raw: section.raw.join('\n'),
        })),
    };
}

export {
    extractKeyValuePairs,
    extractIdeaList,
    classifyIntent,
    responseToJSON,
};
