import fs from 'node:fs';
import path from 'node:path';

/**
 * Convert a heading text to a normalized section key.
 * Trims whitespace, lowercases, replaces non-alphanumeric with hyphens,
 * and removes leading/trailing hyphens.
 *
 * @param {string} heading - The heading text to convert
 * @returns {string} Normalized key suitable for section lookup
 */
export function createSectionKey(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Parse a skill markdown document into a structured descriptor.
 * Extracts name (first heading), rawContent (full content),
 * and sections (keyed by normalized heading).
 *
 * @param {string} filePath - Path to the skill markdown file
 * @returns {{name: string, rawContent: string, sections: Object}} Parsed skill descriptor
 */
export function parseSkillDocument(filePath) {
    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        return {
            name: path.basename(path.dirname(filePath)),
            rawContent: '',
            sections: {},
        };
    }

    const lines = raw.split(/\r?\n/);
    let name = null;
    const sections = new Map();
    const sectionBuffers = new Map();
    let currentSection = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.match(/^#\s/)) {
            const headingText = trimmed.replace(/^#+\s*/, '').trim();
            if (!name) {
                name = headingText;
            }
            currentSection = createSectionKey(headingText);
            if (!sectionBuffers.has(currentSection)) {
                sectionBuffers.set(currentSection, []);
            }
            continue;
        }

        const headingMatch = trimmed.match(/^#{2,}\s*(.+)$/);
        if (headingMatch) {
            const headingText = headingMatch[1].trim();
            currentSection = createSectionKey(headingText);
            if (!sectionBuffers.has(currentSection)) {
                sectionBuffers.set(currentSection, []);
            }
            continue;
        }

        if (currentSection) {
            const buffer = sectionBuffers.get(currentSection) || [];
            buffer.push(line);
            sectionBuffers.set(currentSection, buffer);
        }
    }

    if (!name) {
        name = path.basename(path.dirname(filePath));
    }

    sectionBuffers.forEach((buffer, key) => {
        const joined = buffer.join('\n').trim();
        if (joined) {
            sections.set(key, joined);
        }
    });

    return {
        name,
        rawContent: raw,
        sections: Object.fromEntries(sections),
    };
}
