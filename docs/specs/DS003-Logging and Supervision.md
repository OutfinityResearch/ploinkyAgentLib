# DS003 - Logging and Supervision

## Unified Logger

All runtime logging flows through a single `DebugLogger` instance. There is no separate debug logger, no `console.log`, no `console.warn`, no `console.info` in the runtime chain.

**Logger methods:**
- `log(...args)` — writes to file only (when `ACHILLES_DEBUG` is enabled)
- `debug(...args)` — writes `[DEBUG]` prefixed line to file only
- `info(...args)` — writes `[INFO]` prefixed line to file only
- `warn(...args)` — writes `[WARN]` prefixed line to file only
- `close()` — closes the file stream

**Default behavior:**
- If no custom logger is provided to `MainAgent`, the default is `getDebugLogger()` — the `DebugLogger` singleton
- The `DebugLogger` singleton writes **only to file** (`debuglogs/debug-{pid}.log`) when `ACHILLES_DEBUG` is enabled
- **Zero output to stdout/stderr** — no `console.log`, `console.warn`, `console.info`, or `console.debug` anywhere in the runtime logging chain

## Custom Logger Override

`MainAgent` accepts a `logger` parameter that propagates through the entire component chain:

```javascript
const agent = new MainAgent({
    startDir: '/path/to/project',
    logger: customLogger,  // any object with { log, debug, info, warn, close }
});
```

**Propagation chain:**
```
MainAgent (logger accepted)
  ├── SubsystemFactory → receives logger
  │     ├── OrchestratorSkillsSubsystem → uses logger
  │     ├── CodeSkillsSubsystem → uses logger
  │     ├── DBTableSkillsSubsystem → uses logger
  │     └── DynamicCodeGenerationSubsystem → receives logger
  │
  └── LLMAgent → receives logger
        ├── LoopAgentSession → uses logger (replaces getDebugLogger() singleton)
        └── SOPAgenticSession → uses logger (replaces getDebugLogger() singleton)
```

**Custom logger interface:**
```javascript
{
    log(...args)   // primary logging method
    debug(...args) // optional, prefixed debug log
    info(...args)  // optional, prefixed info log
    warn(...args)  // optional, prefixed warn log
    close()        // optional, cleanup
}
```

When a custom logger is provided, **all components use it instead of the default `DebugLogger`**. This gives full control over log destination, format, and filtering.

## Debug Mode Control

Controlled by the `ACHILLES_DEBUG` environment variable. Only affects the default `DebugLogger` singleton.

| ACHILLES_DEBUG value | `log()` output |
|---------------------|----------------|
| not set | nothing |
| false | nothing |
| true | file only (`debuglogs/debug-{pid}.log`) |
| 1 | file only (`debuglogs/debug-{pid}.log`) |

## Debug Events

The following events are logged at debug level:
- Skill discovery: roots found, total skills discovered
- Duplicate skill detection: canonical name conflict with both directory paths
- Loop session: new prompt, tool calls, tool results
- SOP session: preparation start, plan generation
- Code skills: execution start, completion, argument extraction
- Orchestrator: skill preparation, session type selection

## Warning Events

The following events are logged at warn level:
- Skill descriptor parse failure
- Skill preparation failure
- Skill directory read failure
- DBTable: dependency lookup failures, presenter errors, context code eval errors
- CodeSkills: dynamic import execution failures

## SecuritySupervisor

Controls tool approval during loop session execution and provides output writing capability.

**Default behavior:**
- If no supervisor is provided, a default SecuritySupervisor is created
- The default supervisor always approves tool calls
- The default output writer is a no-op

**Supervisor interface:**
- approve — receives tool choice information, returns approval decision
- getOutputWriter — returns an object with a write method for real-time output

Loop sessions write structured progress events through the supervisor output writer before executing a non-terminal tool selected by the planner. The event shape is `{ type: "tool_reason", tool, reason, stepIndex }`, where `reason` is the planner decision reason. Reserved terminal tools such as `final_answer` and `cannot_complete` must not emit progress events.

**Approval decisions:**
- approve — execute the tool normally
- alwaysApprove — execute the tool and cache the approval for future calls with the exact same tool name and params
- deny — skip the tool handler, store the supervisor reason as an ordinary tool result, and continue planning with that result

Supervisors may return the legacy decision string or a structured object containing `decision`, optional `reason`, optional `status`, and optional opaque `approval` proof. The runtime forwards the approval proof to the selected tool execution context. Cached approvals are keyed by a deterministic serialization of `toolName + params`; a different parameter value always requires a new supervisor decision.

## What Logging Does NOT Do

- Does NOT use `console.log`, `console.warn`, `console.info`, or `console.debug` for runtime logging
- Does NOT write any output to stdout/stderr (all logging is file-only by default)
- Does NOT use `ActionReporter`
- Does NOT expose processing callbacks (onProcessingBegin, onProcessingProgress, onProcessingEnd)

## Testable Functionality

Test files should be created in `tests/mainAgent/`

**Logger tests should cover:**
- Default `DebugLogger` singleton is used when no custom logger provided
- Custom logger is propagated to all subsystems and sessions
- `log()` writes to file only when `ACHILLES_DEBUG` is true
- `log()` is silent when `ACHILLES_DEBUG` is false
- `debug()`, `info()`, `warn()` prefix messages correctly
- Debug log file is created in `debuglogs` directory
- Custom logger overrides default behavior completely
- No `console.*` calls in the runtime logging chain

**Supervisor tests should cover:**
- Default supervisor is created when none provided
- Custom supervisor is used when provided
- Default approve returns approve
- getOutputWriter returns object with write method
- Default output writer write is no-op
- Supervisor is passed to loop session creation
- Loop sessions emit planner tool reasons before tool execution
- alwaysApprove cache is scoped to exact tool params
- Structured denial reasons enter planner context through a result reference without executing the tool handler
- Opaque approval proofs reach the approved tool execution context
