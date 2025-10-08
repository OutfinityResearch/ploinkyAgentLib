export const applyDescriptionDefaults = (context) => {
    const { argumentDefinitions, optionMap } = context;

    for (const definition of argumentDefinitions) {
        if (!definition || typeof definition.name !== 'string') {
            continue;
        }
        if (context.hasArgumentValue(definition.name)) {
            continue;
        }
        const desc = typeof definition.description === 'string' ? definition.description : '';
        const defaultMatch = desc.match(/defaults? to\s+([^.]+)/i);
        if (!defaultMatch || !defaultMatch[1]) {
            continue;
        }
        const rawDefault = defaultMatch[1]
            .replace(/["']/g, '')
            .replace(/[)\.]+$/, '')
            .trim();
        if (!rawDefault) {
            continue;
        }
        const optionCheck = context.normalizeOptionValue(definition.name, rawDefault);
        if (!optionCheck.valid) {
            continue;
        }
        const candidateValue = optionMap.has(definition.name)
            ? optionCheck.value
            : context.coerceScalarValue(rawDefault);
        const validation = context.validateArgumentValue(definition.name, candidateValue);
        if (!validation.valid) {
            continue;
        }
        context.setArgumentValue(definition.name, validation.value);
    }
};

export const prefillFromTaskDescription = (context, rawDescription) => {
    if (typeof rawDescription !== 'string') {
        return;
    }
    const trimmed = rawDescription.trim();
    if (!trimmed) {
        return;
    }

    const attemptPrefill = (name, rawValue) => {
        if (!context.allArgumentNames.includes(name)) {
            return;
        }
        if (context.hasArgumentValue(name)) {
            return;
        }
        const optionCheck = context.normalizeOptionValue(name, rawValue);
        if (!optionCheck.valid) {
            return;
        }
        const candidate = context.optionMap.has(name)
            ? optionCheck.value
            : context.coerceScalarValue(rawValue);
        const validation = context.validateArgumentValue(name, candidate);
        if (!validation.valid) {
            return;
        }
        context.setArgumentValue(name, validation.value);
    };

    const candidateNames = context.allArgumentNames.length
        ? context.allArgumentNames
        : (context.requiredArguments.length ? context.requiredArguments : context.missingRequiredArgs());

    if (candidateNames.length) {
        const { resolved: parsed } = context.parseNamedArguments(trimmed, candidateNames);
        for (const [name, value] of parsed.entries()) {
            if (!context.hasArgumentValue(name)) {
                context.setArgumentValue(name, value);
            }
        }
    }

    const lowerDescription = trimmed.toLowerCase();

    if (!context.hasArgumentValue('role')) {
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
        if (!context.hasArgumentValue('givenName')) {
            attemptPrefill('givenName', toTitle(first));
        }
        if (!context.hasArgumentValue('familyName')) {
            attemptPrefill('familyName', toTitle(second));
        }
        break;
    }
};
