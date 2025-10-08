import { invokeAgent } from '../invocation/modelInvoker.mjs';
import { getAgent } from '../agents/agentRegistry.mjs';
import { safeJsonParse } from '../utils/json.mjs';
import { createFlexSearchAdapter } from '../search/flexsearchAdapter.mjs';
import { startTyping, stopTyping } from '../utils/typingIndicator.mjs';

async function executeSkill({
    skillName,
    providedArgs = {},
    getSkill,
    getSkillAction,
    readUserPrompt,
    taskDescription = '',
    skipConfirmation = false,
}) {
    if (typeof getSkill !== 'function') {
        throw new Error('executeSkill requires a getSkill function.');
    }
    if (typeof getSkillAction !== 'function') {
        throw new Error('executeSkill requires a getSkillAction function.');
    }
    if (typeof readUserPrompt !== 'function') {
        throw new Error('executeSkill requires a readUserPrompt function.');
    }

    const skill = getSkill(skillName);
    if (!skill) {
        throw new Error(`Skill "${skillName}" is not registered.`);
    }

    const action = getSkillAction(skillName);
    if (typeof action !== 'function') {
        throw new Error(`No executable action found for skill "${skillName}".`);
    }

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

    const hasArgumentValue = (name) => Object.prototype.hasOwnProperty.call(normalizedArgs, name)
        && normalizedArgs[name] !== undefined
        && normalizedArgs[name] !== null;

    const missingArgsFromList = (names) => names.filter((name) => !hasArgumentValue(name));

    const optionMap = new Map();
    const optionIndexMap = new Map();
    const debugMode = process.env.LLMAgentClient_DEBUG === 'true';
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
            if (typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'label') && Object.prototype.hasOwnProperty.call(entry, 'value')) {
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

    for (const [name, enumerator] of enumeratorMap.entries()) {
        try {
            const values = await Promise.resolve(enumerator());
            if (Array.isArray(values)) {
                const entries = createOptionEntries(values);
                if (entries.length) {
                    optionMap.set(name, entries);
                    
                    // Create FlexSearch index for this argument's options
                    const searchIndex = createFlexSearchAdapter({ tokenize: 'forward' });
                    for (const option of entries) {
                        const searchText = `${option.label} ${option.display}`;
                        searchIndex.add(option.labelToken, searchText);
                    }
                    optionIndexMap.set(name, searchIndex);
                }
            }
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
        
        // First try exact match
        for (const option of options) {
            if (candidateToken === option.labelToken || candidateToken === option.valueToken) {
                return { matched: true, confidence: 1.0, value: option.value, matches: [option] };
            }
        }
        
        // Try FlexSearch fuzzy matching
        let searchResults;
        try {
            searchResults = searchIndex.search(candidateToken, { limit: 5 });
        } catch (error) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }
        
        if (!Array.isArray(searchResults) || searchResults.length === 0) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }
        
        // Convert search results back to option objects
        const matchedOptions = searchResults
            .map(resultToken => options.find(opt => opt.labelToken === resultToken))
            .filter(Boolean);
        
        if (matchedOptions.length === 0) {
            return { matched: false, confidence: 0, value: null, matches: [] };
        }
        
        // Calculate confidence based on result clarity
        let confidence = 0;
        if (matchedOptions.length === 1) {
            // Single clear match - high confidence
            confidence = 0.9;
        } else if (matchedOptions.length >= 2) {
            // Multiple matches - low confidence (ambiguous)
            confidence = 0.3;
        }
        
        return {
            matched: confidence >= 0.8,
            confidence,
            value: matchedOptions[0].value,
            matches: matchedOptions.slice(0, 3)
        };
    };

    const normalizeOptionValue = (name, value) => {
        const options = optionMap.get(name);
        if (!options || !options.length) {
            return { valid: true, value };
        }
        
        // Try FlexSearch first
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

    // Build argument name variations mapping (includes space-separated and no-separator versions)
    const argumentNameVariationsMap = new Map();
    for (const argName of allArgumentNames) {
        const variations = [argName];
        // Add space-separated version: job_name → "job name"
        const spaceSeparated = argName.replace(/_/g, ' ');
        if (spaceSeparated !== argName) {
            variations.push(spaceSeparated);
        }
        // Add no-separator version: job_name → "jobname"
        const noSeparator = argName.replace(/_/g, '');
        if (noSeparator !== argName && noSeparator !== spaceSeparated) {
            variations.push(noSeparator);
        }
        // Map each variation to the canonical name
        for (const variant of variations) {
            argumentNameVariationsMap.set(variant.toLowerCase(), argName);
        }
    }

    const parseNamedArguments = (input, candidateNames) => {
        const resolved = new Map();
        const invalid = new Set();

        if (!input || !candidateNames.length) {
            return { resolved, invalid };
        }

        // Build all variations for the candidate names (including space-separated)
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

        // Sort by length (longest first) to match "job name" before "job"
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

        // Check skill-provided argument aliases for domain-specific keyword mappings
        // Example: argumentAliases: { name: ['job', 'project'], customer: ['client'] }
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

        // Fuzzy matching as fallback
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

        return missingRequiredArgs().length > 0 ? 'needsMissing' : 'updated';
    };

    const applyDescriptionDefaults = () => {
        for (const definition of argumentDefinitions) {
            if (!definition || typeof definition.name !== 'string') {
                continue;
            }
            if (hasArgumentValue(definition.name)) {
                continue;
            }
            const desc = typeof definition.description === 'string' ? definition.description : '';
            const defaultMatch = desc.match(/defaults? to\s+([^.]+)/i);
            if (defaultMatch && defaultMatch[1]) {
                const rawDefault = defaultMatch[1]
                    .replace(/["']/g, '')
                    .replace(/[)\.]+$/, '')
                    .trim();
                if (!rawDefault) {
                    continue;
                }
                const optionCheck = normalizeOptionValue(definition.name, rawDefault);
                if (!optionCheck.valid) {
                    continue;
                }
                const candidateValue = optionMap.has(definition.name)
                    ? optionCheck.value
                    : coerceScalarValue(rawDefault);
                const validation = validateArgumentValue(definition.name, candidateValue);
                if (!validation.valid) {
                    continue;
                }
                normalizedArgs[definition.name] = validation.value;
            }
        }
    };

    const autofillWithLanguageModel = async () => {
        if (!missingRequiredArgs().length) {
            return false;
        }

        let agent;
        try {
            agent = getAgent();
        } catch (error) {
            return false;
        }

        // First pass: Try FlexSearch for any option-based arguments in the task description
        const flexSearchPrefills = new Map();
        for (const argName of missingRequiredArgs()) {
            if (!optionIndexMap.has(argName)) {
                continue;
            }
            
            // Try to extract a value from task description for this argument
            const flexResult = matchOptionWithFlexSearch(argName, taskDescription);
            if (flexResult.matched && flexResult.confidence >= 0.8) {
                flexSearchPrefills.set(argName, flexResult.value);
            }
        }
        
        // Apply FlexSearch prefills
        for (const [argName, value] of flexSearchPrefills.entries()) {
            const validation = validateArgumentValue(argName, value);
            if (validation.valid) {
                normalizedArgs[argName] = validation.value;
            }
        }
        
        // If all required args are now filled, we're done
        if (!missingRequiredArgs().length) {
            return flexSearchPrefills.size > 0;
        }

        const allowedKeys = JSON.stringify(allArgumentNames);
        const skillNameLower = (skill.name || '').toLowerCase();
        const commandWords = skillNameLower.split(/[-_\s]+/).filter(Boolean);
        
        // Build natural language variations of argument names for voice input
        // e.g., "job_name" → ["job_name", "job name", "jobname"]
        const argumentNameVariations = allArgumentNames.map(argName => {
            const variations = [argName];
            // Add space-separated version: job_name → "job name"
            const spaceSeparated = argName.replace(/_/g, ' ');
            if (spaceSeparated !== argName) {
                variations.push(spaceSeparated);
            }
            // Add no-separator version: job_name → "jobname"
            const noSeparator = argName.replace(/_/g, '');
            if (noSeparator !== argName && noSeparator !== spaceSeparated) {
                variations.push(noSeparator);
            }
            return { canonical: argName, variations };
        });
        
        const variationsText = argumentNameVariations
            .map(({ canonical, variations }) => `"${canonical}" can be spoken as: ${variations.map(v => `"${v}"`).join(' or ')}`)
            .join('\n');
        
        // Build type hints for voice input parsing
        // Only send top 3 FlexSearch matches for options, not all options
        const typeHints = argumentDefinitions.map(def => {
            const argType = def.type || 'string';
            const hasOptions = optionMap.has(def.name);
            if (hasOptions) {
                // Try FlexSearch first to get top matches
                const flexResult = matchOptionWithFlexSearch(def.name, taskDescription);
                if (flexResult.matches && flexResult.matches.length > 0) {
                    const topMatches = flexResult.matches.slice(0, 3).map(o => o.label).join(', ');
                    return `${def.name}: enum/option (top matches: ${topMatches}) - stop at first matching option`;
                } else {
                    // No matches or FlexSearch unavailable, send first 3 options
                    const options = optionMap.get(def.name);
                    const optionLabels = options.map(o => o.label).slice(0, 3).join(', ');
                    return `${def.name}: enum/option (sample values: ${optionLabels}${options.length > 3 ? ', ...' : ''}) - stop at first matching option`;
                }
            }
            if (argType === 'number' || argType === 'integer') {
                return `${def.name}: number - stop at first numeric value`;
            }
            if (argType === 'boolean') {
                return `${def.name}: boolean - stop at true/false`;
            }
            return `${def.name}: string - capture all tokens until next argument name`;
        }).join('\n');

        const systemPrompt = `You extract tool arguments from natural language requests, including VOICE INPUT patterns. Respond ONLY with JSON using keys from ${allowedKeys}. Use exact casing.

VOICE INPUT PATTERNS (no quotes in voice):
When you see "arg_name value value value arg_name2 value2" pattern:
- Capture ALL tokens after an argument name until you see another known argument name or end of input
- For multi-word values, keep all words together until next argument name
- Stop capturing when you encounter: another argument name, command word, or end of input

ARGUMENT NAME RECOGNITION (for voice):
Users may speak argument names without underscores. Map these variations to the canonical JSON key:
${variationsText}

Examples:
- "user name" or "username" → use key "user_name"
- "first name" or "firstname" → use key "first_name"
- "email address" or "emailaddress" → use key "email_address"

TYPE-BASED STOPPING RULES:
${typeHints}

NATURAL LANGUAGE SEPARATORS (recommended for voice):
- "called X" or "named X" → name-related arguments
- "for X" → purpose/target arguments
- "at X" or "in X" → location arguments
- "with X" → additional properties
- "status X" or "marked as X" → status arguments

GENERIC EXAMPLES (adapt to current skill):
1. Multi-word string values:
   "command arg1 value one value two arg2 value three"
   → Capture all words for arg1 until arg2 starts

2. Mixed types:
   "command name multi word name quantity 10 status active"
   → Stop at number for quantity, stop at option for status

3. Natural separators:
   "command called multi word value for another value"
   → Map natural language to appropriate arguments

4. Simple positional:
   "command value1 value2"
   → Extract based on context and task description

5. No parameters:
   "command" with no other words → {} (empty)

COMMAND WORDS TO IGNORE: "${commandWords.join('", "')}"
Use numbers for numeric fields, booleans for true/false. If value is ambiguous or not mentioned, omit that key.`;

        const sections = [
            `Skill name: ${skill.name}`,
            `Skill description: ${skill.description}`,
            `Existing arguments: ${JSON.stringify(normalizedArgs, null, 2)}`,
            `Missing arguments: ${JSON.stringify(missingRequiredArgs())}`,
            `Optional arguments: ${JSON.stringify(missingOptionalArgs())}`,
        ];

        if (argumentDefinitions.length) {
            sections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
        }

        if (taskDescription && typeof taskDescription === 'string') {
            sections.push(`Original user request: ${taskDescription}`);
        }

        sections.push(`Apply the voice input pattern rules above. Remember to capture multi-word values until the next argument name. Map phrases to appropriate arguments. Return JSON only, empty object {} if no parameters found.`);

        // Show typing indicator during LLM processing
        startTyping();
        
        let raw;
        try {
            raw = await invokeAgent(agent, [
                { role: 'system', message: systemPrompt },
                { role: 'human', message: sections.join('\n\n') },
            ], { mode: 'fast' });
        } catch (error) {
            stopTyping();
            return false;
        } finally {
            stopTyping();
        }

        const parsed = safeJsonParse(typeof raw === 'string' ? raw.trim() : raw);
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }

        const status = applyUpdatesMap(parsed);
        return status !== 'unchanged';
    };




    const prefillFromTaskDescription = (rawDescription) => {
        if (typeof rawDescription !== 'string') {
            return;
        }
        const trimmed = rawDescription.trim();
        if (!trimmed) {
            return;
        }

        const attemptPrefill = (name, rawValue) => {
            if (!allArgumentNames.includes(name)) {
                return;
            }
            if (hasArgumentValue(name)) {
                return;
            }
            const optionCheck = normalizeOptionValue(name, rawValue);
            if (!optionCheck.valid) {
                return;
            }
            const candidate = optionMap.has(name)
                ? optionCheck.value
                : coerceScalarValue(rawValue);
            const validation = validateArgumentValue(name, candidate);
            if (!validation.valid) {
                return;
            }
            normalizedArgs[name] = validation.value;
        };

        const candidateNames = allArgumentNames.length
            ? allArgumentNames
            : (requiredArguments.length ? requiredArguments : missingRequiredArgs());

        if (candidateNames.length) {
            const { resolved: parsed } = parseNamedArguments(trimmed, candidateNames);
            for (const [name, value] of parsed.entries()) {
                if (!hasArgumentValue(name)) {
                    normalizedArgs[name] = value;
                }
            }
        }

        const lowerDescription = trimmed.toLowerCase();

        if (!hasArgumentValue('role')) {
            if (lowerDescription.includes('system admin')) {
                attemptPrefill('role', 'SystemAdmin');
            } else if (lowerDescription.includes('system administrator')) {
                attemptPrefill('role', 'SystemAdmin');
            } else if (lowerDescription.includes('project manager')) {
                attemptPrefill('role', 'ProjectManager');
            }
        }

        const stopWords = new Set(['user', 'manager', 'admin', 'administrator', 'system', 'project', 'role', 'password', 'username', 'given', 'family', 'name', 'skip', 'confirmation', 'confirm', 'new', 'add', 'task']);

        const tokens = trimmed.split(/\s+/);
        for (let i = tokens.length - 2; i >= 0; i -= 1) {
            const first = tokens[i];
            const second = tokens[i + 1];
            if (!first || !second) {
                continue;
            }
            const isAlpha = (value) => /^[a-z]+$/i.test(value);
            const isNameCandidate = (value) => isAlpha(value) && !stopWords.has(value.toLowerCase());
            if (!isNameCandidate(first) || !isNameCandidate(second)) {
                continue;
            }
            const toTitle = (value) => value.length ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
            if (!hasArgumentValue('givenName')) {
                attemptPrefill('givenName', toTitle(first));
            }
            if (!hasArgumentValue('familyName')) {
                attemptPrefill('familyName', toTitle(second));
            }
            break;
        }
    };

    const missingRequiredArgs = () => missingArgsFromList(requiredArguments);
    const missingOptionalArgs = () => missingArgsFromList(optionalArgumentNames);

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

    const interpretConfirmationResponse = async (rawInput, summaryText) => {
        let agent;
        try {
            agent = getAgent();
        } catch (error) {
            return null;
        }

        const systemPrompt = 'You interpret confirmation responses for tool execution. Respond ONLY with JSON like {"action":"confirm|cancel|edit","updates":{"field":"value"}}. Use lowercase action strings.';
        const humanSections = [
            'The user was shown a summary of the pending action and replied as follows.',
            `User reply: ${rawInput}`,
            `Current arguments: ${JSON.stringify(normalizedArgs, null, 2)}`,
        ];

        if (summaryText) {
            humanSections.push(`Summary shown to user:\n${summaryText}`);
        }

        if (argumentDefinitions.length) {
            humanSections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
        }

        humanSections.push('Return JSON only. Use "confirm" to proceed, "cancel" to stop, or "edit" with updates to adjust specific arguments.');

        // Show typing indicator during LLM processing
        startTyping();
        
        let raw;
        try {
            raw = await invokeAgent(agent, [
                { role: 'system', message: systemPrompt },
                { role: 'human', message: humanSections.join('\n\n') },
            ], { mode: 'fast' });
        } catch (error) {
            stopTyping();
            return null;
        } finally {
            stopTyping();
        }

        const parsed = safeJsonParse(typeof raw === 'string' ? raw.trim() : raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
        const updates = parsed.updates && typeof parsed.updates === 'object' ? parsed.updates : null;

        if (!action) {
            return null;
        }

        return { action, updates };
    };

    const formatArgumentList = (descriptors) => descriptors
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

    let optionalPromptShown = false;

    const collectMissingArguments = async () => {
        optionalPromptShown = false;

        while (missingRequiredArgs().length > 0) {
            const missingRequiredAtStart = missingRequiredArgs();
            const missingRequired = missingRequiredAtStart;
            const missingOptional = optionalPromptShown ? [] : missingOptionalArgs();

            const requiredDescriptors = missingRequired.map(describeArgument);
            const promptSections = ['Missing required arguments:'];
            const formattedRequired = formatArgumentList(requiredDescriptors);
            if (formattedRequired) {
                promptSections.push(formattedRequired);
            }

            if (missingOptional.length) {
                const optionalDescriptors = missingOptional.map(describeArgument);
                const formattedOptional = formatArgumentList(optionalDescriptors);
                if (formattedOptional) {
                    promptSections.push('Optional arguments you may also set now:', formattedOptional);
                } else {
                    promptSections.push('Optional arguments you may also set now:');
                }
                optionalPromptShown = true;
            }

            promptSections.push("Provide values (or type 'cancel' to abort):\n");

            const userInput = await readUserPrompt(`${promptSections.join('\n')}`);
            const trimmedInput = typeof userInput === 'string' ? userInput.trim() : '';

            if (!trimmedInput) {
                if (!optionalPromptShown && optionalArgumentNames.length) {
                    optionalPromptShown = true;
                }
                continue;
            }

            if (trimmedInput.toLowerCase() === 'cancel') {
                throw new Error('Skill execution cancelled by user.');
            }

        const parseTargets = parseableArgumentNames.length ? parseableArgumentNames : missingRequired;
        const { resolved: directlyParsed, invalid: ambiguous } = parseNamedArguments(trimmedInput, parseTargets);
        for (const [name, value] of directlyParsed.entries()) {
            normalizedArgs[name] = value;
        }

        const assignUnlabeledTokens = () => {
            const rawTokens = trimmedInput.match(/"[^"]*"|'[^']*'|\S+/g);
            if (!rawTokens || !rawTokens.length) {
                return;
            }

            const normalizedTokens = rawTokens
                .map((token) => {
                    const trimmedToken = token.trim();
                    if (!trimmedToken.length) {
                        return '';
                    }
                    if ((trimmedToken.startsWith('"') && trimmedToken.endsWith('"')) || (trimmedToken.startsWith("'") && trimmedToken.endsWith("'"))) {
                        return trimmedToken.slice(1, -1).trim();
                    }
                    return trimmedToken;
                })
                .filter(Boolean);

            if (!normalizedTokens.length) {
                return;
            }

            const candidateNameSet = new Set(parseTargets.map((name) => name.toLowerCase()));
            const consumedValueSet = new Set(Array.from(directlyParsed.values())
                .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : null))
                .filter(Boolean));

            const tokensForAssignment = normalizedTokens
                .filter((token) => !candidateNameSet.has(token.toLowerCase()))
                .filter((token) => !consumedValueSet.has(token.toLowerCase()));

            if (!tokensForAssignment.length) {
                return;
            }

            const takeField = (queue, predicate = () => true) => {
                const index = queue.findIndex(predicate);
                if (index === -1) {
                    return null;
                }
                const [field] = queue.splice(index, 1);
                return field;
            };

            const requiredQueue = missingRequiredArgs();
            const optionalQueue = missingOptionalArgs();

            const tryAssignToken = (fieldName, tokenValue) => {
                if (!fieldName || hasArgumentValue(fieldName)) {
                    return;
                }

                let value = tokenValue;
                const definition = definitionMap.get(fieldName);
                const fieldType = typeof definition?.type === 'string' ? definition.type.toLowerCase() : '';

                if (optionMap.has(fieldName)) {
                    const optionCheck = normalizeOptionValue(fieldName, value);
                    if (!optionCheck.valid) {
                        return;
                    }
                    const validation = validateArgumentValue(fieldName, optionCheck.value);
                    if (!validation.valid) {
                        return;
                    }
                    normalizedArgs[fieldName] = validation.value;
                    return;
                }

                if (fieldType === 'boolean') {
                    const lower = value.toLowerCase();
                    if (['true', 'yes', 'y', '1', 'enable', 'enabled', 'allow', 'allowed'].includes(lower)) {
                        const validation = validateArgumentValue(fieldName, true);
                        if (!validation.valid) {
                            return;
                        }
                        normalizedArgs[fieldName] = validation.value;
                        return;
                    }
                    if (['false', 'no', 'n', '0', 'disable', 'disabled', 'deny', 'denied'].includes(lower)) {
                        const validation = validateArgumentValue(fieldName, false);
                        if (!validation.valid) {
                            return;
                        }
                        normalizedArgs[fieldName] = validation.value;
                        return;
                    }
                }

                if (fieldType === 'integer' || fieldType === 'number') {
                    const numeric = Number(value);
                    if (Number.isFinite(numeric)) {
                        const normalizedNumeric = fieldType === 'integer' ? Math.trunc(numeric) : numeric;
                        const validation = validateArgumentValue(fieldName, normalizedNumeric);
                        if (!validation.valid) {
                            return;
                        }
                        normalizedArgs[fieldName] = validation.value;
                        return;
                    }
                }

                if (fieldType && fieldType !== 'string') {
                    const coerced = coerceScalarValue(value);
                    const validation = validateArgumentValue(fieldName, coerced);
                    if (!validation.valid) {
                        return;
                    }
                    normalizedArgs[fieldName] = validation.value;
                    return;
                }

                const validation = validateArgumentValue(fieldName, value);
                if (!validation.valid) {
                    return;
                }
                normalizedArgs[fieldName] = validation.value;
            };

            for (const token of tokensForAssignment) {
                const emailField = token.includes('@')
                    ? takeField(requiredQueue, (name) => {
                        const definition = definitionMap.get(name);
                        const description = definition?.description || '';
                        return /email/i.test(name) || /email/i.test(description);
                    }) || takeField(optionalQueue, (name) => {
                        const definition = definitionMap.get(name);
                        const description = definition?.description || '';
                        return /email/i.test(name) || /email/i.test(description);
                    })
                    : null;

                if (emailField) {
                    tryAssignToken(emailField, token);
                    continue;
                }

                const nextRequired = takeField(requiredQueue);
                if (nextRequired) {
                    tryAssignToken(nextRequired, token);
                    continue;
                }

                const nextOptional = takeField(optionalQueue);
                if (nextOptional) {
                    tryAssignToken(nextOptional, token);
                }
            }
        };

        if (skill.disableAutoTokenAssignment !== true) {
            assignUnlabeledTokens();
        }

        if (ambiguous.size) {
            console.warn(`The following arguments were not understood: ${Array.from(ambiguous).join(', ')}.`);
        }

            const pendingAfterManual = missingRequiredArgs();

            if (!pendingAfterManual.length) {
                break;
            }

            // Try FlexSearch for any remaining option-based arguments before falling back to LLM
            const flexSearchMatches = new Map();
            for (const argName of pendingAfterManual) {
                if (!optionIndexMap.has(argName)) {
                    continue;
                }
                
                const flexResult = matchOptionWithFlexSearch(argName, trimmedInput);
                if (flexResult.matched && flexResult.confidence >= 0.8) {
                    flexSearchMatches.set(argName, flexResult.value);
                }
            }
            
            // Apply FlexSearch matches
            for (const [argName, value] of flexSearchMatches.entries()) {
                const validation = validateArgumentValue(argName, value);
                if (validation.valid) {
                    normalizedArgs[argName] = validation.value;
                }
            }
            
            // Check again if we're done after FlexSearch matching
            if (!missingRequiredArgs().length) {
                break;
            }

            // Don't invoke LLM if we made progress with manual/FlexSearch assignment
            // Just loop back to prompt for remaining arguments
            const currentPending = missingRequiredArgs();
            if (currentPending.length < missingRequiredAtStart.length) {
                continue;
            }

            let agent;
            try {
                agent = getAgent();
            } catch (error) {
                throw new Error(`Unable to obtain language model for parsing arguments: ${error.message}`);
            }

            const systemPrompt = 'You extract structured JSON arguments for tool execution. Respond with JSON only, no commentary.';
            const humanPromptSections = [
                `Skill name: ${skill.name}`,
                `Skill description: ${skill.description}`,
            ];

            if (argumentDefinitions.length) {
                humanPromptSections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
            }

            humanPromptSections.push(`Missing argument names: ${JSON.stringify(pendingAfterManual)}`);
            // Only send top 3 FlexSearch matches to LLM, not all options
            const availableOptions = pendingAfterManual
                .map((name) => {
                    const options = optionMap.get(name);
                    if (!options || !options.length) {
                        return null;
                    }
                    
                    // Try FlexSearch to get relevant matches first
                    const flexResult = matchOptionWithFlexSearch(name, trimmedInput);
                    if (flexResult.matches && flexResult.matches.length > 0) {
                        const topMatches = flexResult.matches.slice(0, 3).map(option => option.display).join(', ');
                        return `${name} (top matches): ${topMatches}`;
                    }
                    
                    // No FlexSearch matches, send first 3 options
                    const formatted = options.slice(0, 3).map(option => option.display).join(', ');
                    return `${name} (sample options): ${formatted}${options.length > 3 ? ', ...' : ''}`;
                })
                .filter(Boolean);
            if (availableOptions.length) {
                humanPromptSections.push(`Available options:\n${availableOptions.join('\n')}`);
            }
            humanPromptSections.push(`User response: ${trimmedInput}`);
            humanPromptSections.push('Return a JSON object containing values for the missing argument names. Omit any extraneous fields.');

            // Show typing indicator during LLM processing
            startTyping();
            
            let rawExtraction;
            try {
                rawExtraction = await invokeAgent(agent, [
                    { role: 'system', message: systemPrompt },
                    { role: 'human', message: humanPromptSections.join('\n\n') },
                ], { mode: 'fast' });
            } catch (error) {
                stopTyping();
                throw new Error(`Failed to parse arguments with the language model: ${error.message}`);
            } finally {
                stopTyping();
            }

            const parsedExtraction = safeJsonParse(typeof rawExtraction === 'string' ? rawExtraction.trim() : rawExtraction);

            if (!parsedExtraction || typeof parsedExtraction !== 'object') {
                console.warn('The language model did not return valid JSON. Please try providing the details again.');
                continue;
            }

            const pendingSet = new Set(pendingAfterManual);
            const invalidFromModel = new Set();
            let appliedFromModel = false;

            for (const [name, value] of Object.entries(parsedExtraction)) {
                if (!pendingSet.has(name)) {
                    continue;
                }
                if (value === undefined || value === null) {
                    continue;
                }
                const optionCheck = normalizeOptionValue(name, value);
                if (!optionCheck.valid) {
                    invalidFromModel.add(name);
                    continue;
                }

                const candidateValue = optionMap.has(name) ? optionCheck.value : value;
                const validation = validateArgumentValue(name, candidateValue);
                if (!validation.valid) {
                    invalidFromModel.add(name);
                    continue;
                }

                normalizedArgs[name] = validation.value;
                appliedFromModel = true;
            }

            if (invalidFromModel.size) {
                console.warn(`The model returned unsupported options for arguments: ${Array.from(invalidFromModel).join(', ')}.`);
            }

            if (!appliedFromModel) {
                console.warn('Unable to determine values for the remaining arguments. Please provide them again.');
            }
        }
    };

    const isSensitiveName = (name) => typeof name === 'string' && /(password|secret|token|key)/i.test(name);

    const formatSummaryValue = (name, value) => {
        if (value === undefined) {
            return '(not provided)';
        }
        if (value === null) {
            return 'null';
        }
        if (typeof value === 'string') {
            if (!value.length) {
                return '(empty string)';
            }
            if (isSensitiveName(name)) {
                return '********';
            }
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

    const buildConfirmationSummary = () => {
        const descriptor = skill.humanDescription || skill.description || skill.what || skill.name;
        const heading = descriptor && descriptor !== skill.name
            ? `About to execute '${skill.name}': ${descriptor}`
            : `About to execute '${skill.name}'.`;
        const lines = [heading];

        const summaryNames = argumentDefinitions.length
            ? argumentDefinitions.map((def) => def?.name).filter(Boolean)
            : Array.from(new Set([
                ...Object.keys(normalizedArgs),
                ...allArgumentNames,
                ...requiredArguments,
                ...optionalArgumentNames,
            ])).filter(Boolean);

        if (!summaryNames.length) {
            lines.push('Arguments: (none)');
            return lines.join('\n');
        }

        lines.push('Arguments:');
        for (const name of summaryNames) {
            const value = Object.prototype.hasOwnProperty.call(normalizedArgs, name)
                ? normalizedArgs[name]
                : undefined;
            lines.push(`  - ${name}: ${formatSummaryValue(name, value)}`);
        }

        return lines.join('\n');
    };

    const requestArgumentEdits = async () => {
        const editTargets = parseableArgumentNames.length
            ? parseableArgumentNames
            : Array.from(new Set([
                ...argumentDefinitions.map((def) => def?.name).filter(Boolean),
                ...Object.keys(normalizedArgs),
                ...requiredArguments,
                ...optionalArgumentNames,
            ])).filter(Boolean);

        if (!editTargets.length) {
            return 'unchanged';
        }

        const editInput = await readUserPrompt('Enter updates (e.g., "password newPass role Admin") or press Enter to keep current values:\n');
        const trimmedEdit = typeof editInput === 'string' ? editInput.trim() : '';

        if (!trimmedEdit) {
            return 'unchanged';
        }

        const { resolved: updates, invalid: invalidUpdates } = parseNamedArguments(trimmedEdit, editTargets);
        const updatesObject = Object.fromEntries(updates);
        const applyResult = applyUpdatesMap(updatesObject);

        if (invalidUpdates.size) {
            console.warn(`The following arguments were not understood: ${Array.from(invalidUpdates).join(', ')}.`);
        }

        return applyResult;
    };

    if (taskDescription && typeof taskDescription === 'string' && taskDescription.trim()) {
        prefillFromTaskDescription(taskDescription);
    }

    await autofillWithLanguageModel();
    applyDescriptionDefaults();

    let needsArgumentCollection = true;

    while (true) {
        if (needsArgumentCollection) {
            await collectMissingArguments();
            needsArgumentCollection = false;
        }

        if (skipConfirmation || !skill.needConfirmation) {
            break;
        }

        const summary = buildConfirmationSummary();
        const confirmationInput = await readUserPrompt(`${summary}\nGo ahead, edit, or cancel?\n`);
        const normalizedResponse = typeof confirmationInput === 'string' ? confirmationInput.trim().toLowerCase() : '';

        const affirmatives = new Set(['y', 'yes', 'ok', 'sure', 'do it', 'go ahead', 'proceed']);
        const negatives = new Set(['c', 'cancel', 'n', 'no', 'stop', 'abort', 'never mind']);
        const edits = new Set(['e', 'edit', 'change', 'update', 'adjust']);

        if (!normalizedResponse || affirmatives.has(normalizedResponse)) {
            break;
        }

        if (negatives.has(normalizedResponse)) {
            throw new Error('Skill execution cancelled by user.');
        }

        if (edits.has(normalizedResponse)) {
            const editResult = await requestArgumentEdits();
            if (editResult === 'needsMissing') {
                needsArgumentCollection = true;
            }
            continue;
        }

        const interpreted = await interpretConfirmationResponse(confirmationInput, summary);
        if (interpreted && interpreted.action) {
            const action = interpreted.action;
            if (action === 'confirm' || action === 'yes' || action === 'proceed') {
                break;
            }
            if (action === 'cancel' || action === 'stop' || action === 'abort') {
                throw new Error('Skill execution cancelled by user.');
            }
            if (action === 'edit') {
                if (interpreted.updates && Object.keys(interpreted.updates).length) {
                    const editResult = applyUpdatesMap(interpreted.updates);
                    if (editResult === 'needsMissing') {
                        needsArgumentCollection = true;
                    } else if (editResult === 'unchanged') {
                        console.log('I could not apply those changes. Let’s try again together.');
                        const manualResult = await requestArgumentEdits();
                        if (manualResult === 'needsMissing') {
                            needsArgumentCollection = true;
                        }
                    }
                    continue;
                }
                const manualResult = await requestArgumentEdits();
                if (manualResult === 'needsMissing') {
                    needsArgumentCollection = true;
                }
                continue;
            }
        }

        console.log("Please answer in your own words—for example 'yes', 'edit', or 'cancel'.");
    }

    const orderedNames = argumentDefinitions.length
        ? argumentDefinitions.map(def => def.name)
        : requiredArguments.slice();

    if (!orderedNames.length) {
        return action({ ...normalizedArgs });
    }

    const positionalValues = orderedNames.map(name => normalizedArgs[name]);

    if (action.length > 1) {
        return action(...positionalValues);
    }

    if (orderedNames.length === 1) {
        return action(positionalValues[0]);
    }

    return action({ ...normalizedArgs });
}

export {
    executeSkill,
};
