# AchillesAgentLib Agent Guide

## Scope

These instructions apply to the entire AchillesAgentLib repository. The design specifications under `docs/specs/` are the source of truth for behavior, architecture, constraints, coding style, and unresolved contract boundaries. AchillesAgentLib is authorized for repository runtime implementation and model-facing work under the rules below.

## Mandatory Reading Order

1. Read `README.md` for the user-facing purpose and verified integration path.
2. Read `docs/index.html` for component roles and the end-to-end runtime flow.
3. Read `docs/wiki.html` for canonical project terminology.
4. Read `docs/specs/DS004-coding-style.md` before changing code, module structure, tests, comments, or generated files.
5. Open the complete DS set through `docs/specsLoader.html?spec=matrix.md`, then read the HTML page and DS files relevant to the component being changed.
6. For work under `docs/`, read and follow `DOCUMENTATION_SPECIFICATION.md` as the repository copy of the documentation-writing rules.

## Current Skill Catalog

Runtime code skills distributed under `skills/` are `bash`, `edit`, `glob`, `grep`, `mirror-code-generator`, `read`, `webfetch`, and `write`. Their `cskill.md` files define input and output, and executable entry points live inside the same skill folders.

Update this catalog, the matching HTML pages, and the matching DS files whenever a product skill folder is added, removed, or renamed. Imported skills in downstream applications remain documented inside their copied skill folders; do not add imported-skill pages or DS files to the host project's `docs/` tree.

## Repository Rules

- Write documentation, specifications, source comments, and agent guidance in English.
- Treat `docs/specs/DS004-coding-style.md` as the canonical coding-style, source-layout, file-size, and test-organization contract.
- Keep DS numbering contiguous. Every ordinary DS file requires exactly `title` and `summary` frontmatter and uses `Introduction` and `Core Content` as its only top-level content sections; do not add a `Conclusion` section.
- Put rationale, limitations, assumptions, alternatives, and unresolved contract boundaries declaratively in the affected DS file's `Core Content`; do not use a separate decision log.
- Run `detect-main-behaviors` before creating or changing `DS003-main-behavior.md`, and whenever source or product changes may alter user outcomes, essential paths, public interfaces, broad subsystems, major hidden consequences, special behavior, or the architectural skeleton.
- When source behavior, interfaces, architecture, workflows, or constraints change, update both the affected HTML documentation and DS specifications.
- Keep `docs/wiki.html` as the single canonical terminology source and link project-specific terms to stable wiki anchors.
- Do not edit `.generated.mjs` files directly. Change their source Markdown and regenerate them.
- Keep skill examples and executable code inside the relevant skill folder; do not introduce a shared root `src/` tree for portable skill implementations.
- Preserve existing user changes and avoid destructive Git operations.

## Runtime Defaults

- `MainAgent` discovers workspace skills below `startDir`; package-internal skills are disabled unless `disableInternalSkills` is `false`.
- General `executePrompt()` calls use one reusable LoopAgentSession. `executeSkill()` invokes one named enabled skill directly.
- All LLM interactions use `LLMAgent`. Model inputs resolve through `LLMConfig.json`, optional `LLM_MODELS_CONFIG_PATH`, supported environment variables, or caller-supplied `modelConfig`; caller configuration is the manual override.
- Apply configured task tags for routing-sensitive documentation, specification, orchestration, bootstrap, and testing work. Preserve caller-supplied `reasoningEffort` through sessions and provider calls.
- `ACHILLES_SKILL_TIMEOUT` controls dynamic-code execution timeout; `ACHILLES_DBTABLE_TIMEOUT` controls DBTable execution timeout; `ACHILLES_DEBUG=true` enables diagnostic logging.
- Run `npm test` after configuring provider credentials and any generated-router descriptor required by integration tests. Run deterministic component tests with `node --test <test-file>`. After changes under `cli/skill-manager-cli/`, run `tests/skill-manager/` when that tree exists.

## Key Paths

| Path | Role |
| --- | --- |
| `index.mjs` | Public package exports. |
| `MainAgent/MainAgent.mjs` | Skill catalog, top-level routing, and prompt-session owner. |
| `LLMAgents/LLMAgent.mjs` | Model-facing service and session factory. |
| `MainAgent/services/SubsystemFactory.mjs` | Skill type to subsystem mapping. |
| `CodeSkillsSubsystem/`, `DynamicCodeGenerationSubsystem/`, `OrchestratorSkillsSubsystem/`, `DBTableSkillsSubsystem/` | Local skill-family executors. |
| `PloinkyAgentSkillsSubsystem/` | Remote-agent discovery and tool wrapping for orchestrators. |
| `LLMAgents/LoopAgenticSession/`, `LLMAgents/SOPAgenticSession/`, `lightSOPLang/` | Multi-step session and plan execution runtimes. |
| `AgenticKnowledgeUnits/` | Deterministic local project-memory utility. |
| `BacklogManager/`, `utils/MarkdownDataStore.mjs` | Public file-backed support utilities. |
| `skills/` | Runtime code skills distributed by this package. |
| `docs/index.html`, `docs/wiki.html` | Documentation and canonical terminology entry points. |
| `docs/specs/`, `docs/specsLoader.html` | Authoritative design contracts and browser loader. |
