import { invokeAgent } from '../../invocation/modelInvoker.mjs';
import { getAgent } from '../../agents/agentRegistry.mjs';
import { safeJsonParse } from '../../utils/json.mjs';
import { startTyping, stopTyping } from '../../utils/typingIndicator.mjs';

export const createLLMOrchestrator = ({ context, taskDescription = '' }) => {
    const autofillMissingArgs = async () => {
        if (!context.missingRequiredArgs().length) {
            return false;
        }

        let agent;
        try {
            agent = getAgent();
        } catch (error) {
            return false;
        }

        const flexSearchPrefills = new Map();
        for (const argName of context.missingRequiredArgs()) {
            if (!context.optionIndexMap.has(argName)) {
                continue;
            }

            const flexResult = context.matchOptionWithFlexSearch(argName, taskDescription);
            if (flexResult.matched && flexResult.confidence >= 0.8) {
                flexSearchPrefills.set(argName, flexResult.value);
            }
        }

        for (const [argName, value] of flexSearchPrefills.entries()) {
            const validation = context.validateArgumentValue(argName, value);
            if (validation.valid) {
                context.setArgumentValue(argName, validation.value);
            }
        }

        if (!context.missingRequiredArgs().length) {
            return flexSearchPrefills.size > 0;
        }

        const allowedKeys = JSON.stringify(context.allArgumentNames);
        const skillNameLower = (context.skill.name || '').toLowerCase();
        const commandWords = skillNameLower.split(/[-_\s]+/).filter(Boolean);

        const argumentNameVariations = context.allArgumentNames.map(argName => {
            const variations = [argName];
            const spaceSeparated = argName.replace(/_/g, ' ');
            if (spaceSeparated !== argName) {
                variations.push(spaceSeparated);
            }
            const noSeparator = argName.replace(/_/g, '');
            if (noSeparator !== argName && noSeparator !== spaceSeparated) {
                variations.push(noSeparator);
            }
            return { canonical: argName, variations };
        });

        const variationsText = argumentNameVariations
            .map(({ canonical, variations }) => `"${canonical}" can be spoken as: ${variations.map(v => `"${v}"`).join(' or ')}`)
            .join('\n');

        const typeHints = context.argumentDefinitions.map(def => {
            const argType = def.type || 'string';
            const hasOptions = context.optionMap.has(def.name);
            if (hasOptions) {
                const flexResult = context.matchOptionWithFlexSearch(def.name, taskDescription);
                if (flexResult.matches && flexResult.matches.length > 0) {
                    const topMatches = flexResult.matches.slice(0, 3).map(o => o.label).join(', ');
                    return `${def.name}: enum/option (top matches: ${topMatches}) - stop at first matching option`;
                }
                const options = context.optionMap.get(def.name);
                const optionLabels = options.map(o => o.label).slice(0, 3).join(', ');
                return `${def.name}: enum/option (sample values: ${optionLabels}${options.length > 3 ? ', ...' : ''}) - stop at first matching option`;
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
            `Skill name: ${context.skill.name}`,
            `Skill description: ${context.skill.description}`,
            `Existing arguments: ${JSON.stringify(context.normalizedArgs, null, 2)}`,
            `Missing arguments: ${JSON.stringify(context.missingRequiredArgs())}`,
            `Optional arguments: ${JSON.stringify(context.missingOptionalArgs())}`,
        ];

        if (context.argumentDefinitions.length) {
            sections.push(`Argument definitions: ${JSON.stringify(context.argumentDefinitions, null, 2)}`);
        }

        if (taskDescription && typeof taskDescription === 'string') {
            sections.push(`Original user request: ${taskDescription}`);
        }

        sections.push('Apply the voice input pattern rules above. Remember to capture multi-word values until the next argument name. Map phrases to appropriate arguments. Return JSON only, empty object {} if no parameters found.');

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

        const status = context.applyUpdatesMap(parsed);
        return status !== 'unchanged';
    };

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
            `Current arguments: ${JSON.stringify(context.normalizedArgs, null, 2)}`,
        ];

        if (summaryText) {
            humanSections.push(`Summary shown to user:\n${summaryText}`);
        }

        if (context.argumentDefinitions.length) {
            humanSections.push(`Argument definitions: ${JSON.stringify(context.argumentDefinitions, null, 2)}`);
        }

        humanSections.push('Return JSON only. Use "confirm" to proceed, "cancel" to stop, or "edit" with updates to adjust specific arguments.');

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

    const extractArgumentsFromInput = async ({ pendingArguments, trimmedInput }) => {
        let agent;
        try {
            agent = getAgent();
        } catch (error) {
            throw new Error(`Unable to obtain language model for parsing arguments: ${error.message}`);
        }

        const systemPrompt = 'You extract structured JSON arguments for tool execution. Respond with JSON only, no commentary.';
        const humanPromptSections = [
            `Skill name: ${context.skill.name}`,
            `Skill description: ${context.skill.description}`,
        ];

        if (context.argumentDefinitions.length) {
            humanPromptSections.push(`Argument definitions: ${JSON.stringify(context.argumentDefinitions, null, 2)}`);
        }

        humanPromptSections.push(`Missing argument names: ${JSON.stringify(pendingArguments)}`);

        const availableOptions = pendingArguments
            .map((name) => {
                const options = context.optionMap.get(name);
                if (!options || !options.length) {
                    return null;
                }

                const flexResult = context.matchOptionWithFlexSearch(name, trimmedInput);
                if (flexResult.matches && flexResult.matches.length > 0) {
                    const topMatches = flexResult.matches.slice(0, 3).map(option => option.display).join(', ');
                    return `${name} (top matches): ${topMatches}`;
                }

                const formatted = options.slice(0, 3).map(option => option.display).join(', ');
                return `${name} (sample options): ${formatted}${options.length > 3 ? ', ...' : ''}`;
            })
            .filter(Boolean);

        if (availableOptions.length) {
            humanPromptSections.push(`Available options:\n${availableOptions.join('\n')}`);
        }

        humanPromptSections.push(`User response: ${trimmedInput}`);
        humanPromptSections.push('Return a JSON object containing values for the missing argument names. Omit any extraneous fields.');

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
            return { applied: false, invalid: new Set() };
        }

        const pendingSet = new Set(pendingArguments);
        const invalidFromModel = new Set();
        let appliedFromModel = false;

        for (const [name, value] of Object.entries(parsedExtraction)) {
            if (!pendingSet.has(name)) {
                continue;
            }
            if (value === undefined || value === null) {
                continue;
            }
            const optionCheck = context.normalizeOptionValue(name, value);
            if (!optionCheck.valid) {
                invalidFromModel.add(name);
                continue;
            }

            const candidateValue = context.optionMap.has(name) ? optionCheck.value : value;
            const validation = context.validateArgumentValue(name, candidateValue);
            if (!validation.valid) {
                invalidFromModel.add(name);
                continue;
            }

            context.setArgumentValue(name, validation.value);
            appliedFromModel = true;
        }

        return { applied: appliedFromModel, invalid: invalidFromModel };
    };

    const generateActionExplanation = async () => {
        let agent;
        try {
            agent = getAgent();
        } catch (error) {
            return `The skill '${context.skill.name}' will run with the current parameters to carry out the requested action.`;
        }

        const systemPrompt = 'You craft one concise, formal sentence that explains the upcoming action and its consequence. Maintain a neutral tone, avoid enthusiastic or exaggerated language, and do not use phrases such as "we\'re excited" or "can\'t wait". No bullet points and no technical jargon.';
        const humanSections = [
            `Skill name: ${context.skill.name}`,
            `Skill description: ${context.skill.description || context.skill.humanDescription || ''}`,
            `Current arguments: ${JSON.stringify(context.normalizedArgs, null, 2)}`,
        ];

        startTyping();

        try {
            const raw = await invokeAgent(agent, [
                { role: 'system', message: systemPrompt },
                { role: 'human', message: humanSections.join('\n\n') },
            ], { mode: 'fast' });
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (text) {
                return text.replace(/\s+/g, ' ');
            }
        } catch (error) {
            return `The skill '${context.skill.name}' will run with the current parameters to carry out the requested action.`;
        } finally {
            stopTyping();
        }

        return `The skill '${context.skill.name}' will run with the current parameters to carry out the requested action.`;
    };

    return {
        autofillMissingArgs,
        interpretConfirmationResponse,
        extractArgumentsFromInput,
        generateActionExplanation,
    };
};
