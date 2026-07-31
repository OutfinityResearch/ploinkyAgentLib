import { LLMAgent } from '../../LLMAgents/LLMAgent.mjs';

function plannerMarkdownDecision({ tool, prompt, reason = 'test' }) {
    return [
        '## tool',
        tool,
        '',
        '## prompt',
        prompt,
        '',
        '## reason',
        reason,
    ].join('\n');
}

class StubLLMAgent extends LLMAgent {
    constructor({ onExecutePrompt = null } = {}) {
        super({ name: 'StubLLMAgent' });
        this.onExecutePrompt = onExecutePrompt;
    }

    executePrompt(prompt, options = {}) {
        if (typeof this.onExecutePrompt === 'function') {
            const override = this.onExecutePrompt(prompt, options);
            if (override !== undefined) {
                return override;
            }
        }

        const context = options.context || {};
        const intent = context.intent || '';
        const skillName = context.skillName || '';

        if (intent === 'orchestrator-plan') {
            if (skillName === 'planner-orchestrator-orchestrator') {
                return {
                    plan: [
                        { intent: 'reporting', skill: 'llm-reporter-cskill', run: true, input: prompt, reason: 'Primary reporting path' },
                        { intent: 'data-fetch', skill: 'inventory-data-retrieval-ploinky', run: true, input: prompt, reason: 'Retrieve supporting data' },
                    ],
                    notes: '',
                };
            }
            if (skillName === 'fallback-planner-orchestrator') {
                return { plan: [], notes: '' };
            }
            if (skillName === 'llm-planner-orchestrator') {
                return {
                    plan: [
                        { intent: 'summary', skill: 'llm-reporter-cskill', run: true, input: prompt, reason: 'Summarise findings' },
                        { intent: 'data-fetch', skill: 'llm-data-lookup-ploinky', run: true, input: prompt, reason: 'Gather data for summary' },
                    ],
                    notes: 'Default stub plan',
                };
            }
        }

        if (intent === 'agentic-session-planner') {
            const userPrompt = context?.userPrompt || '';

            if (userPrompt.includes('daily warehouse report')) {
                return plannerMarkdownDecision({
                    tool: 'llm-reporter-cskill',
                    prompt: 'Prepare daily warehouse report',
                });
            }

            if (userPrompt.includes('invoice mismatches')) {
                return plannerMarkdownDecision({
                    tool: 'final_answer',
                    prompt: '',
                });
            }

            if (userPrompt.includes('recursive loop')) {
                return plannerMarkdownDecision({
                    tool: 'llm-planner-orchestrator',
                    prompt: 'Loop forever',
                });
            }

            return plannerMarkdownDecision({
                tool: 'final_answer',
                prompt: 'Test completed',
            });
        }

        return {
            action: 'final_answer',
            text: 'Unhandled request',
        };
    }

    async startSOPLangAgentSession(skillsDescription, promptText) {
        return {
            getVariables: async () => ({}),
            getLastResult: () => {
                if (String(promptText || '').includes('Trigger recursive loop')) {
                    return 'Too many planner errors';
                }
                return 'SOP session completed';
            },
        };
    }

    complete(prompt, options = {}) {
        return this.executePrompt(prompt, options);
    }
}

export { StubLLMAgent };
