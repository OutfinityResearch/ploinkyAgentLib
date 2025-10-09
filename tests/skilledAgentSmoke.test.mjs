import test from 'node:test';

import { LLMAgent } from '../LLMAgents/index.mjs';
import { chooseSkillWithLLM } from '../SkilledAgents/index.mjs';
import registerSkills from './helpers/initializeSkills.mjs';
const createLLMAgent = () => new LLMAgent({
    name: 'MockLLM',
});

test('SkilledAgent executes a skill using LLMAgent assistance', async () => {
    const agent = registerSkills(createLLMAgent());
    const result = await agent.rankSkill('help', {
        limit: 5,
        roles: ['Admin', 'ProjectManager', 'SystemAdmin', 'Storeman', 'SPC', 'Viewer'],
    });
    console.log('rankSkill result:', result);
    
    // Only call chooseSkillWithLLM if rankSkill returns multiple results
    const resultKeys = Object.keys(result);
    if (resultKeys.length > 1) {
        console.log('Multiple skills found, using chooseSkillWithLLM to select one');
        const previousKey = process.env.OPENAI_API_KEY;
        let tempKeyAdded = false;
        if (!previousKey) {
            process.env.OPENAI_API_KEY = 'test-api-key';
            tempKeyAdded = true;
        }
        try {
            const mockInvoker = async () => resultKeys[0];
            mockInvoker.listAvailableModels = () => ({
                fast: [{
                    name: 'mock-model',
                    providerKey: 'openai',
                    apiKeyEnv: 'OPENAI_API_KEY',
                }],
                deep: [],
            });
            const selectionAgent = new LLMAgent({
                name: 'MockSelector',
                invokerStrategy: mockInvoker,
            });
            const chosenSkill = await chooseSkillWithLLM(result, {
                llmAgent: selectionAgent,
                skillRegistry: agent.skillRegistry,
                query: 'list',
            });
            console.log('Chosen skill:', chosenSkill);
        } finally {
            if (tempKeyAdded) {
                delete process.env.OPENAI_API_KEY;
            }
        }
    } else if (resultKeys.length === 1) {
        console.log('Single skill found, no need for LLM selection');
        console.log('Selected skill:', resultKeys[0]);
    } else {
        console.log('No skills found');
    }
});
