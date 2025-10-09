import { friendlyName } from './context.mjs';

const joinList = (items) => {
    if (!items.length) {
        return '';
    }
    if (items.length === 1) {
        return items[0];
    }
    const head = items.slice(0, -1).join(', ');
    return `${head} and ${items[items.length - 1]}`;
};

function buildMissingMessage(context, validation) {
    const lines = [];

    if (validation.invalid.length) {
        lines.push(`Ignored values for ${joinList(validation.invalid.map(friendlyName))} because they did not match the expected format.`);
    }

    if (validation.missingRequired.length) {
        lines.push('To continue I need the following details:');
        for (const name of validation.missingRequired) {
            const description = context.describeArgument(name);
            const samples = context.getOptionSamples(name, 10);
            if (samples.length) {
                lines.push(`• ${description}. For example: ${samples.join(', ')}${samples.length >= 10 ? ', ...' : ''}`);
            } else {
                lines.push(`• ${description}.`);
            }
        }
    }

    if (validation.missingOptional.length) {
        lines.push(`Optional details you may add: ${joinList(validation.missingOptional.map(context.describeArgument))}.`);
    }

    lines.push('Reply in natural language (e.g. "high priority and approved status") or type "cancel" to stop.');

    return lines.join('\n');
}

function buildNarrative(context) {
    const descriptor = context.skill.humanDescription || context.skill.description || `the skill ${context.skill.name}`;
    const lines = [`About to apply ${descriptor}.`];
    const definitions = context.argumentDefinitions;
    const names = definitions.length ? definitions.map(def => def.name) : Object.keys(context.normalizedArgs);

    if (!names.length) {
        lines.push('No arguments are configured.');
    } else {
        lines.push('We will use the following values:');
        for (const name of names) {
            const value = Object.prototype.hasOwnProperty.call(context.normalizedArgs, name)
                ? context.normalizedArgs[name]
                : undefined;
            lines.push(`• ${friendlyName(name)}: ${context.presentValue(name, value)}`);
        }
    }

    lines.push('Confirm by replying "accept", "cancel", or describe any adjustments.');
    return lines.join('\n');
}

export {
    buildMissingMessage,
    buildNarrative,
};
