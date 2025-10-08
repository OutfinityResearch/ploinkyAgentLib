const normalizeConfirmationKeyword = (input) => String(input).trim().toLowerCase().replace(/[!?.]+$/g, '').trim();

const quickAffirmatives = new Set(['ok', 'okay', 'confirm', 'confirmed', 'yes', 'y', 'da', 'sure', 'proceed', 'continue', 'go ahead']);
const quickCancels = new Set(['cancel', 'stop', 'abort', 'renunta', 'quit', 'exit', 'no']);

const affirmatives = new Set(['y', 'yes', 'ok', 'sure', 'do it', 'go ahead', 'proceed']);
const negatives = new Set(['c', 'cancel', 'n', 'no', 'stop', 'abort', 'never mind']);
const edits = new Set(['e', 'edit', 'change', 'update', 'adjust']);

const isQuickCancel = (raw) => quickCancels.has(normalizeConfirmationKeyword(raw));

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

const buildConfirmationSummary = (context) => {
    const { skill, argumentDefinitions, normalizedArgs, allArgumentNames, requiredArguments, optionalArgumentNames } = context;

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

const requestArgumentEdits = async ({ context, readUserPrompt }) => {
    const editTargets = context.parseableArgumentNames.length
        ? context.parseableArgumentNames
        : Array.from(new Set([
            ...context.argumentDefinitions.map((def) => def?.name).filter(Boolean),
            ...Object.keys(context.normalizedArgs),
            ...context.requiredArguments,
            ...context.optionalArgumentNames,
        ])).filter(Boolean);

    if (!editTargets.length) {
        return 'unchanged';
    }

    const editInput = await readUserPrompt('Enter updates (e.g., "password newPass role Admin") or press Enter to keep current values:\n');
    const trimmedEdit = typeof editInput === 'string' ? editInput.trim() : '';

    if (!trimmedEdit) {
        return 'unchanged';
    }

    const { resolved: updates, invalid: invalidUpdates } = context.parseNamedArguments(trimmedEdit, editTargets);
    const updatesObject = Object.fromEntries(updates);
    const applyResult = context.applyUpdatesMap(updatesObject);

    if (invalidUpdates.size) {
        console.warn(`The following arguments were not understood: ${Array.from(invalidUpdates).join(', ')}.`);
    }

    return applyResult;
};

export const promptForConfirmation = async ({ context, readUserPrompt, llm }) => {
    let explanation = await llm.generateActionExplanation();

    while (true) {
        const summary = buildConfirmationSummary(context);
        const prompt = `${explanation}\n\n${summary}\nGo ahead, edit, or cancel?\n`;
        const confirmationInput = await readUserPrompt(prompt);
        const trimmedConfirmation = typeof confirmationInput === 'string' ? confirmationInput.trim() : '';

        if (!trimmedConfirmation) {
            continue;
        }

        if (isQuickCancel(trimmedConfirmation)) {
            throw new Error('Skill execution cancelled by user.');
        }

        const normalizedQuick = normalizeConfirmationKeyword(trimmedConfirmation);
        if (quickAffirmatives.has(normalizedQuick) || affirmatives.has(normalizedQuick)) {
            return 'confirmed';
        }

        if (negatives.has(normalizedQuick)) {
            throw new Error('Skill execution cancelled by user.');
        }

        const parseTargets = context.parseableArgumentNames.length
            ? context.parseableArgumentNames
            : Array.from(new Set([
                ...context.argumentDefinitions.map((def) => def?.name).filter(Boolean),
                ...context.requiredArguments,
                ...context.optionalArgumentNames,
            ])).filter(Boolean);

        if (parseTargets.length) {
            const { resolved: directUpdates, invalid: invalidDirect } = context.parseNamedArguments(trimmedConfirmation, parseTargets);
            if (directUpdates.size) {
                const updatesObject = Object.fromEntries(directUpdates);
                const applyStatus = context.applyUpdatesMap(updatesObject);
                if (applyStatus === 'needsMissing') {
                    return 'needsCollection';
                }
                if (applyStatus === 'updated') {
                    explanation = await llm.generateActionExplanation();
                    continue;
                }
            }
            if (invalidDirect.size) {
                console.warn(`The following arguments were not understood: ${Array.from(invalidDirect).join(', ')}.`);
            }
        }

        const interpreted = await llm.interpretConfirmationResponse(confirmationInput, summary);
        if (interpreted && interpreted.action) {
            const action = interpreted.action.toLowerCase();
            if (['confirm', 'yes', 'proceed', 'ok', 'okay'].includes(action)) {
                return 'confirmed';
            }
            if (['cancel', 'stop', 'abort', 'no'].includes(action)) {
                throw new Error('Skill execution cancelled by user.');
            }
            if (action === 'edit' || action === 'update') {
                if (interpreted.updates && Object.keys(interpreted.updates).length) {
                    const editStatus = context.applyUpdatesMap(interpreted.updates);
                    if (editStatus === 'needsMissing') {
                        return 'needsCollection';
                    }
                    if (editStatus === 'updated') {
                        explanation = await llm.generateActionExplanation();
                        continue;
                    }
                }
                const manualResult = await requestArgumentEdits({ context, readUserPrompt });
                if (manualResult === 'needsMissing') {
                    return 'needsCollection';
                }
                if (manualResult === 'updated') {
                    explanation = await llm.generateActionExplanation();
                }
                continue;
            }
        }

        console.log("Please respond with 'OK', 'edit', or 'cancel'.");
    }
};
