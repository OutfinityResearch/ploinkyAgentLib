import { SkilledAgent } from '../../SkilledAgents/SkilledAgent.mjs';

const helpSkill = {
    specs: {
        name: 'show-help',
        needConfirmation: false,
        description: 'Show, display, or view help. List, see, browse available actions, commands, skills, or capabilities. Get help, assistance, or information about what you can do. View, display, or list available features.',
        why: 'Users need to discover available actions and understand system capabilities. Help provides visibility into what tasks they can perform based on their roles.',
        what: 'Displays available actions and skills based on user roles. Shows help, assistance, lists capabilities, and provides examples for each action.',
        humanDescription: 'Show available actions and help.',
        arguments: {
            query: {
                type: 'string',
                description: 'Optional search query to filter help results (e.g., "job", "inventory", "material").'
            }
        },
        requiredArguments: [],
        argumentValidators: []
    },
    action: () => 'You can do the following actions: show-help, create-job, list-jobs',
    roles: ['Admin', 'ProjectManager', 'SystemAdmin', 'Storeman', 'SPC', 'Viewer']
};

const createJobSkill = {
    specs: {
        name: 'create-job',
        needConfirmation: true,
        description: 'Create, add, or register a new job. Start, open, or set up a job record with an auto-generated job number for any project or work order.',
        why: 'Every project needs a unique job number to track time, materials, costs, and progress against client expectations.',
        what: 'Creates and adds a new job record. You can register, start, open, or initiate a job for any client project or work order.',
        humanDescription: 'Create a new job record.',
        arguments: {
            job_name: { type: 'string', description: 'The name of the new job.' },
            client_name: { type: 'string', description: 'Client associated with the job.' },
            status: {
                type: 'string', description: 'Job status (defaults to Pending).',
                enumerator: () => [
                    { label: 'Pending', value: 'Pending' },
                    { label: 'In Progress', value: 'In Progress' },
                    { label: 'Completed', value: 'Completed' },
                ],
                presenter: (value) => value.toUpperCase(),
            }
        },
        requiredArguments: ['job_name', 'client_name'],
        argumentValidators: []
    },
    action: () => 'Job created',
    roles: ['Admin', 'ProjectManager', 'SystemAdmin', 'Storeman', 'SPC', 'Viewer']
};

const listJobsSkill = {
    specs: {
        name: 'list-jobs',
        needConfirmation: false,
        description: 'List, see, browse, or view all jobs. Get a complete list of all jobs, including their status, client, and job number.',
        why: 'Users need to see all jobs to manage and track their progress.',
        what: 'Displays a complete list of all jobs. You can view, list, or browse all jobs, including their status, client, and job number.',
        humanDescription: 'List all jobs.',
        arguments: {
            query: {
                type: 'string',
                description: 'Optional search query to filter job results (e.g., "pending", "client", "job number").'
            }
        },
        requiredArguments: [],
        argumentValidators: []
    },
    action: () => 'Job list',
    roles: ['Admin', 'ProjectManager', 'SystemAdmin']
};

const listItemsSkill = {
    specs: {
        name: 'list-items',
        needConfirmation: false,
        description: 'List, see, browse, or view all items. Get a complete list of all items, including their name, description, and quantity.',
        arguments: {
            query: {
                type: 'string',
                description: 'Optional search query to filter item results (e.g., "name", "description", "quantity").'
            }
        },
        requiredArguments: [],
        argumentValidators: []
    },
    action: () => 'Item list',
    roles: ['Admin', 'ProjectManager', 'SystemAdmin', 'Storeman', 'SPC', 'Viewer']
};

const registerSkills = (llmAgent) => {
    const agent = new SkilledAgent({
        llmAgent,
        promptReader: async () => 'accept',
    });
    agent.registerSkill(helpSkill);
    agent.registerSkill(createJobSkill);
    agent.registerSkill(listJobsSkill);
    agent.registerSkill(listItemsSkill);
    return agent;
};

export default registerSkills;
