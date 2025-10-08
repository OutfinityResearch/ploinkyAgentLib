import { formatArgumentList } from './PromptManager.mjs';

const normalizeForKeyword = (input) => String(input).trim().toLowerCase().replace(/[!?.]+$/g, '').trim();

const cancelKeywords = new Set(['cancel', 'stop', 'abort', 'renunta', 'quit', 'exit']);

const isCancelMessage = (raw) => cancelKeywords.has(normalizeForKeyword(raw));

export const collectMissingArguments = async ({
    context,
    readUserPrompt,
    llm,
}) => {
    let optionalPromptShown = false;

    const handleArgumentInput = async (trimmedInput, missingRequiredAtStart) => {
        const baseTargets = context.parseableArgumentNames.length
            ? context.parseableArgumentNames
            : (missingRequiredAtStart.length
                ? missingRequiredAtStart
                : (context.allArgumentNames.length ? context.allArgumentNames : Object.keys(context.normalizedArgs)));
        const parseTargets = Array.from(new Set(baseTargets.filter(Boolean)));
        if (!parseTargets.length) {
            return context.missingRequiredArgs().length === 0;
        }

        const { resolved: directlyParsed, invalid: ambiguous } = context.parseNamedArguments(trimmedInput, parseTargets);
        for (const [name, value] of directlyParsed.entries()) {
            context.setArgumentValue(name, value);
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

            const requiredQueue = context.missingRequiredArgs();
            const optionalQueue = context.missingOptionalArgs();

            const tryAssignToken = (fieldName, tokenValue) => {
                if (!fieldName || context.hasArgumentValue(fieldName)) {
                    return;
                }

                let value = tokenValue;
                const definition = context.definitionMap.get(fieldName);
                const fieldType = typeof definition?.type === 'string' ? definition.type.toLowerCase() : '';

                if (context.optionMap.has(fieldName)) {
                    const optionCheck = context.normalizeOptionValue(fieldName, value);
                    if (!optionCheck.valid) {
                        return;
                    }
                    const validation = context.validateArgumentValue(fieldName, optionCheck.value);
                    if (!validation.valid) {
                        return;
                    }
                    context.setArgumentValue(fieldName, validation.value);
                    return;
                }

                if (fieldType === 'boolean') {
                    const lower = value.toLowerCase();
                    if (['true', 'yes', 'y', '1', 'enable', 'enabled', 'allow', 'allowed'].includes(lower)) {
                        const validation = context.validateArgumentValue(fieldName, true);
                        if (!validation.valid) {
                            return;
                        }
                        context.setArgumentValue(fieldName, validation.value);
                        return;
                    }
                    if (['false', 'no', 'n', '0', 'disable', 'disabled', 'deny', 'denied'].includes(lower)) {
                        const validation = context.validateArgumentValue(fieldName, false);
                        if (!validation.valid) {
                            return;
                        }
                        context.setArgumentValue(fieldName, validation.value);
                        return;
                    }
                }

                if (fieldType === 'integer' || fieldType === 'number') {
                    const numeric = Number(value);
                    if (Number.isFinite(numeric)) {
                        const normalizedNumeric = fieldType === 'integer' ? Math.trunc(numeric) : numeric;
                        const validation = context.validateArgumentValue(fieldName, normalizedNumeric);
                        if (!validation.valid) {
                            return;
                        }
                        context.setArgumentValue(fieldName, validation.value);
                        return;
                    }
                }

                if (fieldType && fieldType !== 'string') {
                    const coerced = context.coerceScalarValue(value);
                    const validation = context.validateArgumentValue(fieldName, coerced);
                    if (!validation.valid) {
                        return;
                    }
                    context.setArgumentValue(fieldName, validation.value);
                    return;
                }

                const validation = context.validateArgumentValue(fieldName, value);
                if (!validation.valid) {
                    return;
                }
                context.setArgumentValue(fieldName, validation.value);
            };

            for (const token of tokensForAssignment) {
                const emailField = token.includes('@')
                    ? takeField(requiredQueue, (name) => {
                        const definition = context.definitionMap.get(name);
                        const description = definition?.description || '';
                        return /email/i.test(name) || /email/i.test(description);
                    }) || takeField(optionalQueue, (name) => {
                        const definition = context.definitionMap.get(name);
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

        if (context.skill.disableAutoTokenAssignment !== true) {
            assignUnlabeledTokens();
        }

        if (ambiguous.size) {
            console.warn(`The following arguments were not understood: ${Array.from(ambiguous).join(', ')}.`);
        }

        if (!context.missingRequiredArgs().length) {
            return true;
        }

        const pendingAfterManual = context.missingRequiredArgs();

        const flexSearchMatches = new Map();
        for (const argName of pendingAfterManual) {
            if (!context.optionIndexMap.has(argName)) {
                continue;
            }

            const flexResult = context.matchOptionWithFlexSearch(argName, trimmedInput);
            if (flexResult.matched && flexResult.confidence >= 0.8) {
                flexSearchMatches.set(argName, flexResult.value);
            }
        }

        for (const [argName, value] of flexSearchMatches.entries()) {
            const validation = context.validateArgumentValue(argName, value);
            if (validation.valid) {
                context.setArgumentValue(argName, validation.value);
            }
        }

        if (!context.missingRequiredArgs().length) {
            return true;
        }

        const currentPending = context.missingRequiredArgs();
        if (currentPending.length < missingRequiredAtStart.length) {
            return false;
        }

        const { applied, invalid } = await llm.extractArgumentsFromInput({
            pendingArguments: pendingAfterManual,
            trimmedInput,
        });

        if (invalid.size) {
            console.warn(`The model returned unsupported options for arguments: ${Array.from(invalid).join(', ')}.`);
        }

        if (!applied) {
            console.warn('Unable to determine values for the remaining arguments. Please provide them again.');
        }

        return context.missingRequiredArgs().length === 0;
    };

    while (true) {
        const missingRequiredAtStart = context.missingRequiredArgs();

        if (!missingRequiredAtStart.length) {
            return;
        }

        if (missingRequiredAtStart.length > 0) {
            const missingOptional = optionalPromptShown ? [] : context.missingOptionalArgs();

            const requiredDescriptors = missingRequiredAtStart.map(context.describeArgument);
            const promptSections = ['Missing required arguments:'];
            const formattedRequired = formatArgumentList(requiredDescriptors);
            if (formattedRequired) {
                promptSections.push(formattedRequired);
            }

            if (missingOptional.length) {
                const optionalDescriptors = missingOptional.map(context.describeArgument);
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
                if (!optionalPromptShown && context.optionalArgumentNames.length) {
                    optionalPromptShown = true;
                }
                continue;
            }

            if (isCancelMessage(trimmedInput)) {
                throw new Error('Skill execution cancelled by user.');
            }

            await handleArgumentInput(trimmedInput, missingRequiredAtStart);
            continue;
        }
    }
};
