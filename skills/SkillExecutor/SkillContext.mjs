import { safeJsonParse } from '../../utils/json.mjs';
import { createFlexSearchAdapter } from '../../search/flexsearchAdapter.mjs';

const toComparableToken = (input) => {
    if (input === undefined) {
        return '';
    }
    if (input === null) {
        return 'null';
    }
    if (typeof input === 'string') {
        return input.trim().toLowerCase().replace(/\s+/g, '');
    }
    if (typeof input === 'number' || typeof input === 'boolean') {
        return String(input).toLowerCase();
    }
    try {
        return JSON.stringify(input).toLowerCase();
    } catch (error) {
        return String(input).toLowerCase();
    }
};

const stringifyOptionValue = (value) => {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
};

const createOptionEntries = (values) => {
    const entries = [];
    for (const entry of values) {
        if (entry === null || entry === undefined) {
            continue;
        }
        if (typeof entry === 'object'
            && Object.prototype.hasOwnProperty.call(entry, 'label')
            && Object.prototype.hasOwnProperty.call(entry, 'value')) {
            const rawLabel = entry.label === null || entry.label === undefined ? '' : String(entry.label).trim();
            if (!rawLabel) {
                continue;
            }
            const option = {
                label: rawLabel,
                value: entry.value,
            };
            option.labelToken = toComparableToken(option.label);
            option.valueToken = toComparableToken(option.value);
            const valueForDisplay = stringifyOptionValue(option.value);
            option.display = option.label === valueForDisplay
                ? option.label
                : `${option.label} (${valueForDisplay})`;
            entries.push(option);
            continue;
        }

        if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
            const label = String(entry);
            const option = {
                label,
                value: entry,
            };
            option.labelToken = toComparableToken(option.label);
            option.valueToken = toComparableToken(option.value);
            option.display = option.label;
            entries.push(option);
        }
    }
    return entries;
};

export const createSkillContext = async ({ skill, providedArgs = {} }) => {
    const normalizedArgs = providedArgs && typeof providedArgs === 'object' ? { ...providedArgs } : {};
    const requiredArguments = Array.isArray(skill.requiredArguments)
        ? skill.requiredArguments.filter(name => typeof name === 'string' && name)
        : [];

    const argumentMetadata = skill.argumentMetadata && typeof skill.argumentMetadata === 'object'
        ? skill.argumentMetadata
        : {};

    const argumentOrder = Array.isArray(skill.argumentOrder) && skill.argumentOrder.length
        ? skill.argumentOrder.filter(name => typeof name === 'string' && name)
        : Object.keys(argumentMetadata);

    const argumentDefinitions = argumentOrder
        .map(name => argumentMetadata[name])
        .filter(entry => entry && typeof entry.name === 'string' && entry.name);

    const definitionNames = argumentDefinitions.map(def => def.name);
    const allArgumentNames = definitionNames.length
        ? definitionNames
        : Array.from(new Set(requiredArguments));

    const requiredArgSet = new Set(requiredArguments);
    const optionalArgumentNames = allArgumentNames.filter(name => !requiredArgSet.has(name));

    const validatorMap = new Map(argumentDefinitions
        .filter(def => typeof def.validator === 'function')
        .map(def => [def.name, def.validator]));

    const enumeratorMap = new Map(argumentDefinitions
        .filter(def => typeof def.enumerator === 'function')
        .map(def => [def.name, def.enumerator]));

    const definitionMap = new Map(argumentDefinitions.map(def => [def.name, def]));

    const optionMap = new Map();
    const optionIndexMap = new Map();

    for (const [name, enumerator] of enumeratorMap.entries()) {
        try {
            const values = await Promise.resolve(enumerator());
            if (!Array.isArray(values)) {
                continue;
            }
            const entries = createOptionEntries(values);
            if (!entries.length) {
                continue;
            }
            optionMap.set(name, entries);
            const searchIndex = createFlexSearchAdapter({ tokenize: 'forward' });
            for (const option of entries) {
                const searchText = `${option.label} ${option.display}`;
                searchIndex.add(option.labelToken, searchText);
            }
            optionIndexMap.set(name, searchIndex);
        } catch (error) {
            console.warn(`Failed to load options for argument "${name}" on skill "${skill.name}": ${error.message}`);
        }
    }

    const matchOptionWithFlexSearch = (name, value) => {
        const searchIndex = optionIndexMap.get(name);
        const options = optionMap.get(name);

        if (!searchIndex || !options || !options.length) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }

        const candidateToken = toComparableToken(value);
        if (!candidateToken) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }

        for (const option of options) {
            if (candidateToken === option.labelToken || candidateToken === option.valueToken) {
                return { matched: true, confidence: 1.0, value: option.value, matches: [option] };
            }
        }

        let searchResults;
        try {
            searchResults = searchIndex.search(candidateToken, { limit: 5 });
        } catch (error) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }

        if (!Array.isArray(searchResults) || searchResults.length === 0) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }

        const matchedOptions = searchResults
            .map(resultToken => options.find(opt => opt.labelToken === resultToken))
            .filter(Boolean);

        if (!matchedOptions.length) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }

        let confidence = 0;
        if (matchedOptions.length === 1) {
            confidence = 0.9;
        } else if (matchedOptions.length >= 2) {
            confidence = 0.3;
        }

        return {
            matched: confidence >= 0.8,
            confidence,
            value: matchedOptions[0].value,
            matches: matchedOptions.slice(0, 3),
        };
    };

    const normalizeOptionValue = (name, value) => {
        const options = optionMap.get(name);
        if (!options || !options.length) {
            return { valid: true, value };
        }
        const flexResult = matchOptionWithFlexSearch(name, value);
        if (flexResult.matched) {
            return { valid: true, value: flexResult.value };
        }
        return { valid: false, value: null };
    };

    const validateArgumentValue = (name, value) => {
        const validator = validatorMap.get(name);
        if (typeof validator !== 'function') {
            return { valid: true, value };
        }

        try {
            const result = validator(value);
            if (result === false) {
                console.warn(`Validation for argument "${name}" rejected the provided value.`);
                return { valid: false, value: null };
            }
            if (result === true || result === undefined) {
                return { valid: true, value };
            }
            if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'valid')) {
                const normalizedValue = Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : value;
                if (!result.valid) {
                    const message = typeof result.message === 'string' ? result.message : 'validator returned false';
                    console.warn(`Validation for argument "${name}" failed: ${message}`);
                }
                return { valid: Boolean(result.valid), value: normalizedValue };
            }
            return { valid: true, value: result };
        } catch (error) {
            const message = error?.message || 'validator threw an error';
            console.warn(`Validation for argument "${name}" failed: ${message}`);
            return { valid: false, value: null };
        }
    };

    const coerceScalarValue = (raw) => {
        const value = typeof raw === 'string' ? raw.trim() : raw;
        if (typeof value !== 'string') {
            return value;
        }
        if (!value.length) {
            return value;
        }
        const lower = value.toLowerCase();
        if (lower === 'true') {
            return true;
        }
        if (lower === 'false') {
            return false;
        }
        if (lower === 'null') {
            return null;
        }
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
            const numeric = Number(value);
            if (!Number.isNaN(numeric)) {
                return numeric;
            }
        }
        if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            const parsed = safeJsonParse(value);
            if (parsed !== null) {
                return parsed;
            }
        }
        return value;
    };

    const hasArgumentValue = (name) => Object.prototype.hasOwnProperty.call(normalizedArgs, name)
        && normalizedArgs[name] !== undefined
        && normalizedArgs[name] !== null;

    const missingArgsFromList = (names) => names.filter((name) => !hasArgumentValue(name));

    const sanitizeInitialArguments = () => {
        const currentEntries = Object.entries({ ...normalizedArgs });
        for (const [name, raw] of currentEntries) {
            if (!argumentMetadata[name]) {
                continue;
            }
            const optionCheck = normalizeOptionValue(name, raw);
            if (!optionCheck.valid) {
                delete normalizedArgs[name];
                continue;
            }
            const candidate = optionMap.has(name)
                ? optionCheck.value
                : raw;
            const validation = validateArgumentValue(name, candidate);
            if (!validation.valid) {
                delete normalizedArgs[name];
                continue;
            }
            normalizedArgs[name] = validation.value;
        }
    };

    sanitizeInitialArguments();

    const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const parseNamedArguments = (input, candidateNames) => {
        const resolved = new Map();
        const invalid = new Set();

        if (!input || !candidateNames.length) {
            return { resolved, invalid };
        }

        const allVariations = [];
        const variationToCanonical = new Map();

        for (const name of candidateNames) {
            const variations = [name];
            const spaceSeparated = name.replace(/_/g, ' ');
            if (spaceSeparated !== name) {
                variations.push(spaceSeparated);
            }
            const noSeparator = name.replace(/_/g, '');
            if (noSeparator !== name && noSeparator !== spaceSeparated) {
                variations.push(noSeparator);
            }

            for (const variant of variations) {
                allVariations.push(variant);
                variationToCanonical.set(variant.toLowerCase(), name);
            }
        }

        allVariations.sort((a, b) => b.length - a.length);

        const nameAlternatives = allVariations.map(escapeRegex).join('|');
        const pattern = new RegExp(String.raw`\b(${nameAlternatives})\b\s*(?::|=)?\s*("[^"]*"|'[^']*'|[^\s"']+)`, 'gi');

        let match;
        while ((match = pattern.exec(input)) !== null) {
            const rawName = match[1];
            const canonical = variationToCanonical.get(rawName.toLowerCase());
            if (!canonical) {
                continue;
            }

            if (resolved.has(canonical)) {
                invalid.add(canonical);
                continue;
            }

            let rawValue = match[2] || '';
            rawValue = rawValue.trim();

            if (!rawValue.length) {
                invalid.add(canonical);
                continue;
            }

            if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
                rawValue = rawValue.slice(1, -1);
            }

            rawValue = rawValue.trim();
            if (!rawValue.length) {
                invalid.add(canonical);
                continue;
            }

            const optionCheck = normalizeOptionValue(canonical, rawValue);
            if (!optionCheck.valid) {
                invalid.add(canonical);
                continue;
            }

            const candidate = optionMap.has(canonical)
                ? optionCheck.value
                : coerceScalarValue(rawValue);

            const validation = validateArgumentValue(canonical, candidate);
            if (!validation.valid) {
                invalid.add(canonical);
                continue;
            }

            resolved.set(canonical, validation.value);
        }

        return { resolved, invalid };
    };

    const resolveFieldName = (name) => {
        if (typeof name !== 'string') {
            return null;
        }
        const trimmed = name.trim();
        if (!trimmed) {
            return null;
        }
        if (allArgumentNames.includes(trimmed)) {
            return trimmed;
        }
        const lower = trimmed.toLowerCase();
        const direct = allArgumentNames.find(candidate => candidate.toLowerCase() === lower);
        if (direct) {
            return direct;
        }

        const argumentAliases = skill.argumentAliases && typeof skill.argumentAliases === 'object'
            ? skill.argumentAliases
            : {};

        for (const [targetArg, keywords] of Object.entries(argumentAliases)) {
            if (!allArgumentNames.includes(targetArg)) {
                continue;
            }
            if (!Array.isArray(keywords) || !keywords.length) {
                continue;
            }
            const lowerKeywords = keywords.map(k => String(k).toLowerCase());
            if (lowerKeywords.some(keyword => lower.includes(keyword))) {
                return targetArg;
            }
        }

        const fuzzy = allArgumentNames.find(candidate => {
            const canonical = candidate.toLowerCase();
            const distance = Math.abs(canonical.length - lower.length);
            return distance <= 2 && (canonical.startsWith(lower) || lower.startsWith(canonical));
        });
        return fuzzy || null;
    };

    const applyUpdatesMap = (updates) => {
        if (!updates || typeof updates !== 'object') {
            return 'unchanged';
        }

        let applied = false;
        for (const [rawName, rawValue] of Object.entries(updates)) {
            const field = resolveFieldName(rawName);
            if (!field) {
                continue;
            }
            const currentValue = normalizedArgs[field];
            const hasValue = hasArgumentValue(field);
            const optionCheck = normalizeOptionValue(field, rawValue);
            if (!optionCheck.valid) {
                continue;
            }

            const candidateValue = optionMap.has(field)
                ? optionCheck.value
                : coerceScalarValue(rawValue);

            const validation = validateArgumentValue(field, candidateValue);
            if (!validation.valid) {
                continue;
            }

            const nextValue = validation.value;

            const valuesMatch = () => {
                if (!hasValue) {
                    return false;
                }
                const current = currentValue;
                if (typeof current === 'string' && typeof nextValue === 'string') {
                    return current.trim() === nextValue.trim();
                }
                return current === nextValue;
            };

            if (valuesMatch()) {
                continue;
            }

            normalizedArgs[field] = nextValue;
            applied = true;
        }

        if (!applied) {
            return 'unchanged';
        }

        return missingArgsFromList(requiredArguments).length > 0 ? 'needsMissing' : 'updated';
    };

    const describeArgument = (name) => {
        const definition = argumentDefinitions.find((arg) => arg.name === name);
        const options = optionMap.get(name);
        const descriptionPart = definition?.description ? `: ${definition.description}` : '';
        const baseLine = `${name}${descriptionPart}`;
        if (options && options.length) {
            const lines = options.map(option => `  * ${option.display}`);
            return [baseLine, 'Options:', ...lines].join('\n');
        }
        return baseLine;
    };

    const parseableArgumentNames = allArgumentNames.length
        ? allArgumentNames
        : (requiredArguments.length ? requiredArguments : []);

    return {
        skill,
        normalizedArgs,
        argumentMetadata,
        argumentDefinitions,
        requiredArguments,
        optionalArgumentNames,
        allArgumentNames,
        parseableArgumentNames,
        optionMap,
        optionIndexMap,
        definitionMap,
        validatorMap,
        hasArgumentValue,
        missingRequiredArgs: () => missingArgsFromList(requiredArguments),
        missingOptionalArgs: () => missingArgsFromList(optionalArgumentNames),
        describeArgument,
        parseNamedArguments,
        resolveFieldName,
        applyUpdatesMap,
        coerceScalarValue,
        normalizeOptionValue,
        validateArgumentValue,
        matchOptionWithFlexSearch,
        setArgumentValue: (name, value) => {
            normalizedArgs[name] = value;
        },
    };
};
