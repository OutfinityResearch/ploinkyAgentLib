import { createSkillContext } from './SkillExecutor/SkillContext.mjs';
import { prefillFromTaskDescription, applyDescriptionDefaults } from './SkillExecutor/PrefillUtils.mjs';
import { createLLMOrchestrator } from './SkillExecutor/LLMOrchestrator.mjs';
import { collectMissingArguments } from './SkillExecutor/ArgumentCollectionLoop.mjs';
import { promptForConfirmation } from './SkillExecutor/ConfirmationLoop.mjs';

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

    const context = await createSkillContext({ skill, providedArgs });
    const llm = createLLMOrchestrator({ context, taskDescription });

    if (taskDescription && typeof taskDescription === 'string' && taskDescription.trim()) {
        prefillFromTaskDescription(context, taskDescription);
    }

    await llm.autofillMissingArgs();
    applyDescriptionDefaults(context);

    let needsArgumentCollection = true;

    while (true) {
        if (needsArgumentCollection) {
            await collectMissingArguments({
                context,
                readUserPrompt,
                llm,
            });
            needsArgumentCollection = false;
        }

        if (skill.needConfirmation !== true || skipConfirmation) {
            break;
        }

        const confirmationResult = await promptForConfirmation({
            context,
            readUserPrompt,
            llm,
        });

        if (confirmationResult === 'confirmed') {
            break;
        }

        if (confirmationResult === 'needsCollection') {
            needsArgumentCollection = true;
            continue;
        }
    }

    const orderedNames = context.argumentDefinitions.length
        ? context.argumentDefinitions.map(def => def.name)
        : context.requiredArguments.slice();

    const namedPayload = { ...context.normalizedArgs };

    if (!orderedNames.length) {
        return action(namedPayload);
    }

    const positionalValues = orderedNames.map(name => context.normalizedArgs[name]);

    if (action.length > 1 && action.length === positionalValues.length) {
        return action(...positionalValues);
    }

    if (orderedNames.length === 1 && action.length === 1) {
        return action(positionalValues[0]);
    }

    if (action.length <= 1) {
        return action(namedPayload);
    }

    return action(positionalValues);
}

export default executeSkill;
export { executeSkill };
