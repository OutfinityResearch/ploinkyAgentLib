# DS000 - MainAgent Overview

## Purpose

MainAgent is the primary entry point for achillesAgentLib. It manages skill discovery, session lifecycle, and LLM-powered task execution.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                        MainAgent                            │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │  Skill Registry  │  │       Session Manager        │    │
│  │  _skills (Map)   │  │      _session (single)       │    │
│  │  _skillAliases   │  │                              │    │
│  │     (Map)        │  │    create / reuse / clear    │    │
│  └────────┬─────────┘  └──────────────┬───────────────┘    │
│           │                           │                    │
│  ┌────────▼───────────────────────────▼───────────────┐    │
│  │              Execution Layer                        │    │
│  │                                                     │    │
│  │  executePrompt()  →  LoopAgentSession              │    │
│  │  executeSkill()   →  Subsystem → Skill execution   │    │
│  └────────┬──────────────────────────┬────────────────┘    │
│           │                          │                     │
│  ┌────────▼─────────┐  ┌─────────────▼────────────────┐   │
│  │  SubsystemFactory │  │     SecuritySupervisor       │   │
│  │  (lazy creation)  │  │  (tool approval + output)    │   │
│  └────────┬─────────┘  └──────────────────────────────┘   │
│           │                                                │
│  ┌────────▼──────────────────────────────────────────┐    │
│  │                  Subsystems                        │    │
│  │  orchestrator | dcg | cskill | ploinky | dbtable  │    │
│  └───────────────────────────────────────────────────┘    │
│                                                           │
│  Internal: LLMAgent (created automatically)              │
│  Internal: Logger (unified info/warn/debug)              │
│  Internal: modelConfig (tag → model mapping)             │
└───────────────────────────────────────────────────────────┘
```

## Directory Structure

```
MainAgent/
├── index.mjs
├── MainAgent.mjs
├── services/
│   ├── discoverSkills.mjs
│   └── SubsystemFactory.mjs
└── supervisor/
    └── SecuritySupervisor.mjs
```

## Constructor Behavior

MainAgent creates its own LLMAgent internally. The caller does not provide an LLM instance.

**Accepted parameters:**
- `startDir` — root directory for skill discovery (defaults to current working directory)
- `supervisor` — tool approval controller (creates default if omitted)
- `logger` — unified logger with info/warn/debug methods (creates default if omitted)
- `llmAgentOptions` — options forwarded to the internal LLMAgent constructor
- `modelConfig` — object mapping tags to model names (e.g., `{ thinking: 'claude-sonnet-4', fast: 'gpt-4o-mini' }`)
- `disableInternalSkills` — boolean flag (default `true`); when true, skips registration of package-internal skills from `skills/`

**What happens on construction:**
1. Creates internal LLMAgent with modelConfig
2. Creates or accepts unified logger
3. Initializes skill registry and alias map
4. Initializes a single session holder
5. Creates SubsystemFactory with MainAgent and modelConfig
6. Creates default SecuritySupervisor if none provided
7. Discovers and registers internal skills from the package's `skills/` directory (only when `disableInternalSkills` is false)
8. Discovers and registers user skills from startDir

## Model Configuration

MainAgent accepts a `modelConfig` parameter that maps semantic tags to model names. This configuration is forwarded to the internal LLMAgent and used by all subsystems for model selection.

**Default tags:**
| Tag | Default Model | Purpose |
|-----|---------------|---------|
| `coding` | `code` | Code generation tasks |
| `fast` | `fast` | Quick responses |
| `free` | `fast` | Free-tier model |
| `long-context` | `deep` | Large context windows |
| `research` | `deep` | Deep analysis |
| `thinking` | `plan` | Reasoning and planning |
| `writing` | `write` | Text composition |
| `vision` | `plan` | Vision-capable model |

**Example:**
```javascript
const agent = new MainAgent({
    startDir: '/path/to/project',
    modelConfig: {
        thinking: 'claude-sonnet-4',
        fast: 'gpt-4o-mini',
        code: 'claude-sonnet-4',
        writing: 'gpt-4o',
        research: 'claude-3-opus',
    },
});
```

## Core Capabilities

- **Skill discovery** — scans downward from startDir for skills directories
- **Skill aliasing** — each skill is accessible by canonical name and short name
- **Session management** — creates and reuses one agentic session
- **Prompt execution** — sends user messages to LLM via loop sessions
- **Orchestrated tool hiding** — hides skills explicitly owned by orchestrator allowlists from top-level prompt sessions
- **Parent session context forwarding** — passes the active loop session snapshot to skill tools through execution context
- **Direct skill execution** — runs a specific skill by name
- **Subsystem access** — lazy creation and caching of subsystem instances
- **Supervised tool approval** — delegates tool authorization to supervisor
- **Model configuration** — semantic tag-to-model mapping for all LLM calls
- **Session interruption control** — exposes `cancelCurrentSession(reason)` to interrupt the active agentic session
- **Runtime skill state** — exposes `enableSkills(names)` and `disableSkills(names)` for atomic catalog-state changes

## Rules

- MainAgent does NOT accept an external LLMAgent instance
- MainAgent does NOT accept a dbAdapter parameter
- MainAgent does NOT accept a separate debugLogger parameter
- Skill discovery is downward-only; no upward search
- Skills listed in an orchestrator's Allowed Skills or Allowed Preparation Skills sections are not exposed as top-level tools during executePrompt sessions
- MainAgent stores only one active session; executePrompt reuses it after first creation
- Disabled skills remain registered but are excluded from build, direct execution, top-level tools, and orchestrator tools
- Enabling or disabling a batch replaces the active session's tool surface without recreating the session
- Model selection is resolved via LLMAgent.modelConfig and getModelByTag()
- The modelConfig is forwarded to all subsystems through SubsystemFactory

## What MainAgent Does NOT Do

- Does NOT resolve which model to use (delegated to LLMAgent.getModelByTag)
- Does NOT handle human review modes
- Does NOT manage conversation summaries
- Does NOT perform text-based skill search
- Does NOT expose processing callbacks
- Does NOT reload skills after initial discovery
- Does NOT expose sessionId-based APIs or multi-session routing

## Session Interruption Behavior

- `cancelCurrentSession(reason)` delegates interruption to both the active session instance and the LLMAgent transport cancellation path.
- Interrupted sessions persist an interruption event in their history and enter `interrupted` status.
- A subsequent `executePrompt()` call reuses the same session object and resumes execution from normal active flow.
