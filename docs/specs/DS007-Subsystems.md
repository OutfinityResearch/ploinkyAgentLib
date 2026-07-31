# DS007 — Subsystems

## Overview

Subsystems are specialized execution engines, each responsible for one type of skill. They sit between `MainAgent` and the actual skill logic, handling discovery, preparation, build-time setup, and execution.

## Mandatory Interface

Every subsystem must implement these methods:

| Method | Purpose |
|--------|---------|
| `parseSkillDescriptor` | Parse the skill's markdown file and return a structured descriptor. |
| `prepareSkill` | Fast, synchronous setup. Populates the skill record with metadata. Called automatically during discovery. Must not perform I/O or LLM calls. |
| `buildSkill` | Async, one-time heavy build step (e.g., code generation). Called explicitly via `MainAgent.buildSkills()`. MainAgent dispatches these calls in parallel across skills and waits for all to settle. Safe to call multiple times — already-built skills are skipped. |
| `executeSkillPrompt` | Run the skill with the given prompt and return the result. |

## Subsystem Lifecycle

1. **Discovery** — `MainAgent` finds skill files on disk, calls `parseSkillDescriptor` and `prepareSkill` for each.
2. **Build** — Caller invokes `MainAgent.buildSkills()` to perform expensive setup like code generation. Build calls are started in parallel across discovered skills, then awaited together.
3. **Execution** — Skills are run on demand via `MainAgent.executeSkill()`, which delegates to the appropriate subsystem.

## Subsystems

### CodeSkillsSubsystem (`cskill`)

Executes JavaScript/ESM modules. Skills are defined by a `cskill.md` file and implemented in `src/index.mjs`. Supports code generation from `specs/` during initialization.

### DynamicCodeGenerationSubsystem (`dynamic-code-generation`)

Runs JavaScript code dynamically — either generated at runtime by the LLM or loaded from pre-written modules. Defined by `dcgskill.md`.

### PloinkyAgentSkillsSubsystem (`ploinky`)

Dynamic coordination subsystem that enables orchestrators to discover and call remote Ploinky agents through the router. Does not participate in skill discovery; instantiated lazily by `OrchestratorSkillsSubsystem` when an orchestrator declares `## Allowed Agents`. Provides `fetchAgentCards()` for router discovery and `buildAgentAsTools()` to wrap agents as callable session tools. Uses `AgentHttpClient` (from `PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs`) for HTTP calls to the router's `/agent-card` and `/<agent>/v1/chat/completions` endpoints.

### OrchestratorSkillsSubsystem (`orchestrator`)

Coordinates multiple skills to accomplish complex tasks through agentic sessions (loop or SOP). Defined by `oskill.md`.

### DBTableSkillsSubsystem (`dbtable`)

Manages database table operations with LLM-powered query interpretation, validation, and confirmation flows. Defined by `tskill.md`.

## prepareSkill vs buildSkill

| Aspect | `prepareSkill` | `buildSkill` |
|--------|---------------|-------------|
| **When** | Automatically during discovery | Explicitly via `MainAgent.buildSkills()` |
| **Nature** | Sync, fast | Async, potentially heavy |
| **I/O** | No | Yes |
| **LLM calls** | No | Yes |
| **Idempotent** | Yes | Yes |
