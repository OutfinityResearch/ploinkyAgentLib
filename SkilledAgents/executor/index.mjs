import { createExecutionContext } from './context.mjs';
import { mainLoop } from './mainLoop.mjs';

async function executeSkill({
    skillName,
    providedArgs = {},
    getSkill,
    getSkillAction,
    readUserPrompt,
    taskDescription = '',
    llmAgent = null,
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

    const context = await createExecutionContext({
        skill,
        action,
        providedArgs,
        llmAgent,
    });

    const finalArgs = await mainLoop(context, {
        readUserPrompt,
        taskDescription,
    });

    const argumentDefinitions = context.argumentDefinitions;
    const requiredArguments = context.requiredArguments;

    const orderedNames = argumentDefinitions.length
        ? argumentDefinitions.map(def => def.name)
        : requiredArguments.slice();

    if (!orderedNames.length) {
        return action({ ...finalArgs });
    }

    const positionalValues = orderedNames.map(name => finalArgs[name]);

    if (action.length > 1) {
        return action(...positionalValues);
    }

    if (orderedNames.length === 1) {
        return action(positionalValues[0]);
    }

    return action({ ...finalArgs });
}

export {
    executeSkill,
};
