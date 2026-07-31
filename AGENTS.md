# AchillesAgentLib Architecture

## Overview

AchillesAgentLib is a modular, skill-based agent framework that enables LLM-powered task execution through specialized subsystems. The architecture follows a hierarchical pattern where a central `MainAgent` discovers, registers, and orchestrates execution of various skill types.

## Documentation Work

For any work under `docs/`, follow `DOCUMENTATION_SPECIFICATION.md`. That file defines the current editorial and technical standard for documentation pages and should be treated as the authoritative guide for future documentation changes.

Design specifications live under `docs/specs/`. `docs/specs/matrix.md` lists the current DS set. Agentic Knowledge Units are shipped as an additive local memory utility under `AgenticKnowledgeUnits/`; the v1 implementation follows `docs/specs/DS008-AgenticKnowledgeUnits.md`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            MainAgent                                    │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      Skill Discovery                            │    │
│  │  - Scans skills directories                                     │    │
│  │  - Registers skills by descriptor type                           │    │
│  │  - Creates aliases for flexible skill resolution                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                │                                        │
│  ┌─────────────────────────────▼─────────────────────────────────────┐  │
│  │                       Subsystem Router                            │  │
│  │  Routes skill execution to appropriate subsystem based on type    │  │
│  └─────────────────────────────┬─────────────────────────────────────┘  │
│                                │                                        │
│  ┌─────────────────────────────▼─────────────────────────────────────┐  │
│  │                        Subsystems                                 │  │
│  │  ┌──────────────┐ ┌─────────────┐ ┌─────────────┐                 │  │
│  │  │ dynamic-code │ │ code-skill  │ │orchestrator │                 │  │
│  │  │ (dcgskill.md) │ │ (cskill.md) │ │ (oskill.md) │                 │  │
│  │  └──────────────┘ └─────────────┘ └─────────────┘                 │  │
│  │  ┌─────────────┐ ┌─────────────┐                                 │  │
│  │  │   dbtable   │ │  ploinky *  │                                 │  │
│  │  │ (tskill.md) │ │ (no file)   │                                 │  │
│  │  └─────────────┘ └─────────────┘                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. MainAgent (`MainAgent/MainAgent.mjs`)

The main entry point and coordinator for skill-based execution.

**Key Responsibilities:**
- **Skill Discovery**: Scans directories for `skills` folders
- **Skill Registration**: Parses skill markdown files and registers them by type
- **Subsystem Management**: Lazily instantiates subsystems on demand
- **Execution Routing**: Routes prompts to appropriate skills/orchestrators
- **Alias Resolution**: Maintains skill aliases for flexible invocation
- **Model Configuration**: Accepts `modelConfig` for semantic tag-to-model mapping

**Skill File Types:**
| File | Type | Subsystem |
|------|------|-----------|
| `dcgskill.md` | dynamic-code-generation | DynamicCodeGenerationSubsystem |
| `cskill.md` | cskill | CodeSkillsSubsystem |
| `oskill.md` | orchestrator | OrchestratorSkillsSubsystem |
| `tskill.md` | dbtable | DBTableSkillsSubsystem |

`PloinkyAgentSkillsSubsystem` (type `ploinky`) does not participate in filesystem skill discovery. It is instantiated lazily by `OrchestratorSkillsSubsystem` when an orchestrator declares `## Allowed Agents`.

All skill descriptor families may include an optional `## Help` section. The runtime does not use this section for planning or execution; host UIs may use it as user-facing invocation guidance in command menus and autocomplete surfaces.

**Key Methods:**
```javascript
// Execute with automatic skill selection
await agent.executePrompt(taskDescription, options);

// Execute with explicit skill
await agent.executeSkill('my-skill', 'task description');

// Toggle registered skills without removing them from the catalog
agent.disableSkills(['my-skill-cskill']);
agent.enableSkills(['my-skill-cskill']);
```

Every registered skill carries an `enabled` boolean. Disabled skills remain visible through `getSkills()` but cannot execute, build, or appear in MainAgent and orchestrator tool surfaces.

**Model Configuration:**

MainAgent accepts a `modelConfig` parameter that maps semantic tags to model names:

```javascript
const agent = new MainAgent({
    startDir: '/path/to/project',
    modelConfig: {
        thinking: 'claude-sonnet-4',
        fast: 'gpt-4o-mini',
        code: 'claude-sonnet-4',
        writing: 'gpt-4o',
        research: 'claude-3-opus',
        'long-context': 'claude-3-opus',
        vision: 'gpt-4o',
        free: 'gpt-4o-mini',
        coding: 'claude-sonnet-4',
    },
});
```

Default tags map to model identifiers resolved through LLMConfig.json:
| Tag | Default | Purpose |
|-----|---------|---------|
| `coding` | `code` | Code generation |
| `fast` | `fast` | Quick responses |
| `free` | `fast` | Free-tier model |
| `long-context` | `deep` | Large context |
| `research` | `deep` | Deep analysis |
| `thinking` | `plan` | Reasoning |
| `writing` | `write` | Text composition |
| `vision` | `plan` | Vision tasks |

**Session Management:**

MainAgent manages sessions through its internal session map:

```javascript
// Execute prompt (creates/reuses session automatically)
const result = await agent.executePrompt('add equipment Drill', {
    sessionId: 'user-123',
});

// Delete session
agent.deleteSession('user-123');

// List active sessions
const sessions = agent.getActiveSessions();

// Check if session exists
if (agent.hasSession('user-123')) { ... }

// Clear all sessions
agent.clearSessions();
```

**Auto-Injection:** When `executePrompt()` is called, sessionMemory is automatically injected into `options.context` based on:
1. `options.context.sessionId` (explicit)
2. `options.context.user.sessionId` (from user object)
3. `options.context.user.sessionToken` (fallback)
4. Default session (if none specified)

```javascript
// sessionMemory is auto-injected - no need to pass explicitly
await agent.executePrompt('add equipment Drill', {
    context: {
        user: { sessionId: 'user-123' },  // Session resolved from user
    },
});
```

**Session Lifecycle (Memory Leak Prevention):**

```javascript
const agent = new MainAgent({
    // ... other options
});

// Get active sessions
const sessions = agent.getActiveSessions();

// Graceful shutdown (clears all sessions)
agent.shutdown();
```

---

### 2. LLMAgent (`LLMAgents/LLMAgent.mjs`)

The core LLM interface that all subsystems use for AI-powered operations.

**Key Features:**
- Configurable invoker strategy for different LLM providers
- Memory integration (global, user, session, skill-scoped)
- Multiple response shapes: text, json, code
- Task execution with review modes
- Intent classification and message interpretation

**Key Methods:**
```javascript
// Simple completion
const result = await llmAgent.complete({ prompt, history, mode: 'fast' });

// Execute prompt with memory context
const result = await llmAgent.executePrompt(promptText, {
    mode: 'fast',           // 'fast' or 'deep'
    responseShape: 'json',  // 'text', 'json', 'code', 'json-code'
    sessionMemory,
});

// Task execution
const result = await llmAgent.doTask(agentContext, description, options);

// Message interpretation for conversational flows
const interpretation = await llmAgent.interpretMessage(message, { intents: ['accept', 'cancel', 'update'] });
```

---

### 3. LightSOPLang Interpreter (`lightSOPLang/interpreter.mjs`)

A domain-specific language for defining execution plans with dependency-based parallelization.

**Syntax:**
```
@variableName commandName arg1 arg2 $dependencyVar
```

**Features:**
- **Dependency Resolution**: Variables prefixed with `$` create dependencies
- **Topological Execution**: Commands run in parallel when dependencies allow
- **Auto-Recovery**: Can regenerate plans via LLM when commands fail
- **English Mode**: Accepts `#!english` scripts that LLM translates to commands

**Example Script:**
```
@prompt prompt
@files listFiles $prompt
@analysis analyzeCode $files
@lastAnswer finalAnswer $analysis
```

**Status Types:**
- `STATUS_SUCCESS`: Command completed successfully
- `STATUS_FAIL`: Command failed with error
- `STATUS_UNDEFINED`: Command not yet executed
- `STATUS_CANCELED`: Command was canceled

---

## Subsystems

### 4. OrchestratorSkillsSubsystem (`OrchestratorSkillsSubsystem/OrchestratorSkillsSubsystem.mjs`)

Coordinates multiple skills to accomplish complex tasks.

**Skill Definition (oskill.md):**
```markdown
# MyOrchestrator

Orchestrates multiple skills for complex workflows.

## Instructions
Guidelines for the LLM when creating execution plans.

## Allowed-Skills
- skill-one
- skill-two
- skill-three

## Description
- create: Creating new items
- update: Updating existing items
- query: Querying data

## Loop
true

```

**Execution Flow:**
1. Parse descriptor sections (instructions, allowed skills, intents, optional loop metadata)
2. Build a toolbelt from the allowed skills
3. Start an agentic session (`sop` by default, `loop` when the descriptor declares a loop section)
4. Execute the session plan, delegating each command to downstream skills

**Return Shape:**
```
{
  skill,
  metadata,
  result,
  session, // 'sop' | 'loop'
  variables, // only for SOP sessions
  sessionMemory
}
```

 **Key Methods:**
 ```javascript
 // Fast loop session
 const loopResult = await subsystem.executeLoopAgentSession({
     skillRecord,
     mainAgent,
     promptText,
     options,
 });

 // Deep SOP session when loop metadata is empty
 const sopResult = await subsystem.executeSOPAgentSession({
     skillRecord,
     mainAgent,
     promptText,
     options,
 });
 ```

---

### 5. DynamicCodeGenerationSubsystem (`DynamicCodeGenerationSubsystem/DynamicCodeGenerationSubsystem.mjs`)

Executes JavaScript code dynamically, either LLM-generated or from modules.

**Skill Definition (dcgskill.md):**
```markdown
# MathEvaluator

Evaluates mathematical expressions.

## Prompt
Decide whether to respond directly or craft JavaScript to solve the task.

## Argument
Primary natural-language instruction or text payload.

## LLM-Mode
fast
```

**Execution Modes:**
1. **Default Executor**: LLM decides between text response or code execution
2. **Module Executor**: Loads and executes a `.js` file from skill directory

**Response Decision:**
```json
{
    "mode": "text" | "code",
    "text": "Direct answer if mode is text",
    "code": "JavaScript if mode is code; must end with return <string>;",
    "explanation": "optional"
}
```

**Security Note:** Code is executed via `eval()` within an async IIFE wrapper.

---

### 6. DBTableSkillsSubsystem (`DBTableSkillsSubsystem/DBTableSkillsSubsystem.mjs`)

Manages database table operations with LLM-powered query interpretation.

**Skill Definition (tskill.md):**
```markdown
# Customer Skill

## Table Purpose
Stores customer information for the CRM system.

## Fields

### customer_id
#### Description
Unique identifier for each customer (integer).
#### Primary Key
auto-increment

### email
#### Description
Customer email address.
#### Validator
Must be a valid email format.
#### Required
Always required.

### full_name
#### Aliases
name, customer_name
#### Presenter
Format as "FirstName LastName"
#### Resolver
Parse full name into first and last components

### created_at
#### Description
Timestamp of customer creation.
#### Derivator
Computed as current timestamp on creation.

## Business Rules
- Email must be unique across all customers
- Customer names must not be empty

## Relationships
- Type: one-to-many with orders.customer_id
```

**Operation Flow:**
1. LLM analyzes prompt to determine operation (CREATE, UPDATE, SELECT, DELETE)
2. Generate functions for presenters, resolvers, validators, enumerators, derivators
3. Execute appropriate flow with generated functions
4. Interact with dbAdapter for actual database operations

**Generated Functions:**
- `presenter_<field>`: Converts DB value to human-readable format
- `resolver_<field>`: Converts human input to DB format
- `validator_<field>`: Validates field values
- `enumerator_<field>`: Returns valid options for a field
- `derivator_<field>`: Computes derived/virtual fields
- `prepareRecord`: Prepares record for DB insertion
- `validateRecord`: Validates entire record
- `presentRecord`: Formats record for display

---

### 7. PloinkyAgentSkillsSubsystem (`PloinkyAgentSkillsSubsystem/PloinkyAgentSkillsSubsystem.mjs`)

Dynamic coordination subsystem that enables orchestrator skills to discover and call remote Ploinky agents through the router. Does not participate in skill discovery; instantiated lazily by `OrchestratorSkillsSubsystem` when an orchestrator declares `## Allowed Agents`.

**Usage in orchestrator (`oskill.md`):**
```markdown
# MyOrchestrator

## Instructions
Coordinate between local skills and remote agents.

## Allowed-Skills
- localSkill1

## Allowed Agents
- openaiAgent
- researchAgent
```

**Execution:** When the orchestrator session starts, the subsystem queries the router's `/agent-card` endpoint via `fetchAgentCards()`, then wraps each declared agent as a callable tool via `buildAgentAsTools()`. Each agent tool sends the session's prompt text through `AgentHttpClient.chatCompletions()` (from `PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs`) and returns the response text. Agent tools are merged into the session's toolbelt alongside local skill tools.

---

## Utility Components

### Sanitiser (`utils/Sanitiser.mjs`)

Normalizes skill names and identifiers.

```javascript
Sanitiser.sanitiseName('My Skill Name');  // 'my-skill-name'
Sanitiser.sanitiseName('skill_v2.0');     // 'skill-v2-0'
```

## Execution Flow

### 1. Without Explicit Skill
```
executePrompt(taskDescription)
    └─► selectOrchestratorForPrompt(taskDescription)
        ├─► [orchestrator found] → OrchestratorSubsystem.executeSkillPrompt()
        └─► [no orchestrator] → chooseSkillWithLLM() → executeWithReviewMode()
```

### 2. With Explicit Skill
```
executeWithReviewMode(taskDescription, { skillName })
    └─► getSkillRecord(skillName)
        └─► ensureSubsystem(skillRecord.type)
            └─► subsystem.executeSkillPrompt({ skillRecord, promptText, options })
```

### 3. Orchestrator Execution
```
OrchestratorSubsystem.executeSkillPrompt()
    ├─► [loop?] → executeLoopAgentSession()  // fast loop session
    └─► [default] → executeSOPAgentSession()  // deep agentic session
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ACHILLES_ORCHESTRATOR_TIMEOUT` | Timeout for orchestrator skills (ms) | 90000 |
| `ACHILLES_SKILL_TIMEOUT` | Timeout for code skills (ms) | 60000 |
| `ACHILLES_DBTABLE_TIMEOUT` | Timeout for DB table skills (ms) | 60000 |

---

## Internal Skills System

MainAgent includes a system for internal helper skills that are always exposed for direct invocation.

### Available Internal Skills

#### mirror-code-generator

Generates JavaScript/ESM code from specification files in a skill's `specs/` directory.

**Input:** Path to a skill directory containing a `specs/` subdirectory with `.md` or `.mds` specification files.

**Output:**
```javascript
{
    message: 'Code generation completed for /path/to/skill',
    generatedFiles: ['index.mjs', 'utils/helpers.mjs']  // relative paths
}
```

**Usage Example:**
```javascript
const agent = new MainAgent({
    startDir: '/path/to/project',
});

const result = await agent.executeSkill(
    'mirror-code-generator',
    '/path/to/my-skill'
);

console.log(result);
// {
//     skill: 'mirror-code-generator',
//     result: {
//         message: 'Code generation completed for /path/to/my-skill',
//         generatedFiles: ['index.mjs']
//     }
// }
```

### Adding New Internal Skills

Internal skills are implemented as orchestrator module skills. To add a new internal skill:

1. Create a module file in `skills/` with the required exports:
```javascript
// skills/my-new-skill/src/index.mjs

export const shortName = 'my-new-skill';

export const descriptor = {
    title: 'My New Skill',
    summary: 'Description of what this skill does.',
    sections: {},
};

export async function action(context) {
    const { promptText, mainAgent, llmAgent } = context;
    // Implementation logic here
    return {
        message: 'Operation completed',
        // ... other result properties
    };
}
```

2. Register the module path in `INTERNAL_SKILLS` in `SkillExecutor.mjs`:
```javascript
const INTERNAL_SKILLS = {
    'mirror-code-generator': '../mirror-code-generator.mjs',
    'my-new-skill': '../my-new-skill.mjs',
};
```

The skill will be automatically registered as a `cskill` when its module exports `skillType = 'cskill'` and executed through the `CodeSkillsSubsystem`.

---

## Directory Structure

```
skills/
├── my-orchestrator/
│   └── oskill.md           # Orchestrator skill definition
├── my-dynamic-code-skill/
│   ├── dcgskill.md           # Dynamic code generation skill definition
│   └── my-dynamic-code-skill.js    # Optional module implementation
└── my-db-skill/
    ├── tskill.md           # DB table skill definition
    └── tskill.generated.mjs # Auto-generated functions
```

---

## Best Practices

1. **Skill Naming**: Use descriptive, hyphenated names that reflect the skill's purpose
2. **Orchestrator Design**: Keep orchestrators focused; compose multiple for complex workflows
3. **Code Skills**: Prefer module-based implementation for complex logic; parse structured data from the prompt text (no automatic argument extraction)
4. **DB Skills**: Define clear validators and presenters for data integrity
5. **Testing**: Mock the LLMAgent and dbAdapter for unit tests

---

## Error Handling

All subsystems follow consistent error patterns:

```javascript
try {
    const result = await subsystem.executeSkillPrompt({ ... });
} catch (error) {
    // Errors include:
    // - Skill not found
    // - LLM execution failure
    // - Timeout exceeded
    // - Validation failure
    // - Module load failure
}
```

---

## SkillManagerAgent (`cli/skill-manager-cli/`)

A specialized CLI agent for managing, generating, and testing skill definition files in `skills` directories.

### Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          SkillManagerAgent                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    MainAgent                                        │  │
│  │  - Discovers skills from workingDir + built-in skills                │  │
│  │  - Routes prompts via 'skill-manager' orchestrator                   │  │
│  └───────────────────────────────┬──────────────────────────────────────┘  │
│                                  │                                          │
│  ┌───────────────────────────────▼──────────────────────────────────────┐  │
│  │                    Built-in Skills (skills/)                 │  │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │  │
│  │  │ skill-manager  │ │  list-skills   │ │  read-skill    │            │  │
│  │  │   (oskill)     │ │   (dcgskill)     │ │   (dcgskill)     │            │  │
│  │  └────────────────┘ └────────────────┘ └────────────────┘            │  │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │  │
│  │  │  write-skill   │ │ update-section │ │ delete-skill   │            │  │
│  │  │   (dcgskill)     │ │   (dcgskill)     │ │   (dcgskill)     │            │  │
│  │  └────────────────┘ └────────────────┘ └────────────────┘            │  │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │  │
│  │  │validate-skill  │ │  get-template  │ │preview-changes │            │  │
│  │  │   (dcgskill)     │ │   (dcgskill)     │ │   (dcgskill)     │            │  │
│  │  └────────────────┘ └────────────────┘ └────────────────┘            │  │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │  │
│  │  │ generate-code  │ │   test-code    │ │ skill-refiner  │            │  │
│  │  │   (dcgskill)     │ │   (dcgskill)     │ │   (oskill)     │            │  │
│  │  └────────────────┘ └────────────────┘ └────────────────┘            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
cli/skill-manager-cli/
├── index.mjs                    # CLI entry point
├── SkillManagerAgent.mjs        # Main agent class
├── skillSchemas.mjs             # Schema definitions & templates
├── spinner.mjs                  # CLI spinner animation
├── prompts/                     # LLM prompt templates
│   ├── index.mjs                # Central export
│   ├── codeGeneration.prompts.mjs  # Code generation prompts
│   └── skillRefiner.prompts.mjs    # Skill refinement prompts
└── skills/             # Built-in skills
    ├── skill-manager/           # Main orchestrator (oskill)
    ├── list-skills/             # List discovered skills
    ├── read-skill/              # Read skill .md content
    ├── write-skill/             # Create/write skill files
    ├── update-section/          # Update specific sections
    ├── delete-skill/            # Delete skill directories
    ├── validate-skill/          # Validate against schema
    ├── get-template/            # Get blank templates
    ├── preview-changes/         # Show diff before writing
    ├── generate-code/           # Generate .mjs from tskill
    ├── test-code/               # Test generated code
    └── skill-refiner/           # Iterative improvement (oskill)

tests/skill-manager/             # Test files (separate location)
├── SkillManagerAgent.test.mjs
├── SkillManagerAgent.integration.test.mjs
├── skillModules.test.mjs
├── allSkills.test.mjs
├── codeGeneration.test.mjs
└── run-all.mjs
```

### Key Components

#### SkillManagerAgent.mjs

Main agent class for skill management.

```javascript
import { SkillManagerAgent } from 'achillesAgentLib/cli/skill-manager-cli/SkillManagerAgent.mjs';

const agent = new SkillManagerAgent({
    workingDir: '/path/to/project',  // Where user skills live
    llmAgent: customLLMAgent,        // Optional custom LLM
});

// Process natural language prompts
const result = await agent.processPrompt('list all skills');

// Execute specific skill directly
await agent.executeSkill('read-skill', 'my-skill');

// Start interactive REPL
await agent.startREPL();

// Get only user skills (excludes built-in)
const userSkills = agent.getUserSkills();

// Reload skills after changes
agent.reloadSkills();
```

#### skillSchemas.mjs

Defines skill type schemas, templates, and validation logic.

```javascript
import {
    SKILL_TYPES,           // Schema definitions for each type
    SKILL_TEMPLATES,       // Blank templates for each type
    detectSkillType,       // Auto-detect type from content
    validateSkillContent,  // Validate against schema
    parseSkillSections,    // Parse markdown sections
    updateSkillSection,    // Update specific section
} from './skillSchemas.mjs';

// Detect skill type
const type = detectSkillType(content);  // 'tskill', 'dcgskill', etc.

// Validate content
const result = validateSkillContent(content);
// { valid: true/false, errors: [], warnings: [], detectedType: '...' }

// Update a section
const updated = updateSkillSection(content, 'Summary', 'New summary text');
```

#### prompts/ Directory

All LLM prompts are kept in separate `.mjs` files for maintainability:

```javascript
// codeGeneration.prompts.mjs
export function buildCodeGenPrompt(skillName, content, sections) {
    return `Generate JavaScript/ESM code for...`;
}

// skillRefiner.prompts.mjs
export function buildEvaluationPrompt(testResult, requirements) { ... }
export function buildFixesPrompt(skillContent, failures, history) { ... }
```

### Built-in Skills

#### skill-manager (oskill)

The main orchestrator that routes user requests to appropriate operations.

**Allowed Skills:**
- `list-skills` - List discovered skills
- `read-skill` - Read skill definition content
- `write-skill` - Create/write skill files
- `update-section` - Update specific sections
- `delete-skill` - Remove skill directories
- `validate-skill` - Validate against schema
- `get-template` - Get blank templates
- `preview-changes` - Show diff before writing
- `generate-code` - Generate .mjs from tskill
- `test-code` - Test generated code
- `skill-refiner` - Iterative improvement

**Usage Pattern:**
```
User: "update joker to tell programming jokes"
↓
skill-manager orchestrator
↓
Plan: [
  { skill: "read-skill", input: "joker" },
  { skill: "update-section", input: {skillName: "joker", section: "Prompt", content: "..."} }
]
```

#### generate-code (dcgskill)

Generates `.mjs` code from `tskill.md` definitions using LLM.

- Input: skill name
- Output: `tskill.generated.mjs` file with validators, presenters, etc.
- Uses: `prompts/codeGeneration.prompts.mjs`

#### skill-refiner (oskill)

Iteratively improves skills until requirements are met.

```
read skill → generate code → test → evaluate → fix → repeat
```

- Max iterations configurable
- Uses LLM to evaluate test results and generate fixes
- Uses: `prompts/skillRefiner.prompts.mjs`

### CLI Usage

```bash
# Start interactive REPL
skill-manager --dir /path/to/project

# Single-shot command
skill-manager "list all skills"

# With LLM mode
skill-manager --deep "create a tskill called inventory"
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `list`, `ls` | List user skills |
| `list all`, `ls -a` | List all skills (including built-in) |
| `reload` | Refresh skills from disk |
| `help` | Show quick reference |
| `exit`, `quit`, `q` | Exit REPL |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ACHILLES_ORCHESTRATOR_MODE` | LLM mode: `fast` (default) or `deep` |
| `ANTHROPIC_API_KEY` | Required for Anthropic LLM |
| `OPENAI_API_KEY` | Alternative: OpenAI API key |

### Dynamic Code Generation Workflow

1. **Create tskill.md** - Define entity schema with fields
2. **Validate** - `validate-skill skillName`
3. **Generate** - `generate-code skillName` → creates `tskill.generated.mjs`
4. **Test** - `test-code skillName` to verify generated code
5. **Refine** - `skill-refiner skillName` for iterative improvement

### Development Notes

- **Do not edit `tskill.generated.mjs` directly** - Modify `tskill.md` and regenerate
- **Prompts in separate files** - All LLM prompts in `prompts/*.prompts.mjs`
- **Built-in skills hidden** - REPL shows only user skills by default
- **Tests** - 211 tests across 5 test files
- After any change in `cli/skill-manager-cli/` run the `tests/skill-manager/` tests
- The files with the extensions `.generated.mjs` should never be updated directly but instead the `.md` files should be updated and the code will be automatically recreated from the markdown file.
