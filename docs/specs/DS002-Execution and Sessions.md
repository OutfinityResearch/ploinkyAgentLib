# DS002 - Execution and Sessions

## executePrompt

Primary method for user-to-LLM communication. Manages a single session lifecycle automatically.

**Parameters:**
- message — the user's text input
- options — optional object containing model, tags, systemPrompt, and signal

**Session resolution:**
- MainAgent keeps one in-memory LoopAgentSession instance
- If the session does not exist, executePrompt creates it
- If the session exists, executePrompt reuses it and appends the new message
- A caller may supply `initialHistory` as ordered `{ role, message }` user/assistant records only while the first call creates the session; supplying non-empty initial history to an active session is rejected to prevent duplicate hydration

**Flow:**
```
executePrompt(message, options)
    │
    ▼
Check if _session exists
    │
    ├─► [no session]
    │   1. Build tools from ALL registered skills
    │   2. Create new LoopAgentSession via LLMAgent
    │   3. Pass model, tags, systemPrompt, supervisor through
    │   4. Store session in _session
    │
    └─► [session exists]
        1. Call _session.newPrompt(message, { signal, model?, tags?, reasoningEffort? })
        2. Explicit per-prompt model options replace the active session options before the turn starts
        3. History from previous turns is preserved
    │
    ▼
Return session result
```

**Tool building for sessions:**
- Registered skills are exposed as tools unless they are explicitly listed in an orchestrator skill's Allowed Skills or Allowed Preparation Skills sections
- Disabled skills remain in the registry but are excluded from MainAgent tools and both orchestrator allowlist surfaces
- Each tool has a handler that calls executeSkill internally
- Tool names are sanitised short names
- Tool descriptions come from the skill descriptor
- Orchestrator-owned skills remain executable through executeSkill so the orchestrator can call them, but they are not exposed as top-level tools during executePrompt sessions
- When a tool is called from a LoopAgentSession, the handler passes a parent session snapshot through `options.parentContext` so executed skills can receive the current conversation history and resolved tool results
- A tool invoked from a LoopAgentSession inherits the parent session's active model, tags, and reasoning effort. The historical `plan` fallback is used only when the parent session has no active model.
- Orchestrator sub-sessions must not inject the parent session snapshot directly into their system prompt. The parent snapshot is an internal execution context for called skills and for explicit preparation clarification, not the same thing as the sub-session's prepared context.
- When an orchestrator skill defines `Preparation`, the preparation phase may expose the internal `clarify_context` tool/command. It answers specific questions from `options.parentContext` only, so the sub-session can load just the parent details it needs.

## executeSkill

Direct execution of a registered skill by name or alias.

**Parameters:**
- skillName — name or alias of the skill
- prompt — input text for the skill
- options — optional object passed through to the subsystem

**Flow:**
```
executeSkill(skillName, prompt, options)
    │
    ▼
Resolve skill record via alias lookup
    │
    ├─► [not found] → throw Error
    │
    └─► [found]
        1. Get subsystem by skill type
        2. Call subsystem.executeSkillPrompt()
        3. Pass skillRecord, this agent reference, prompt, options
    │
    ▼
Return subsystem result
```

## Session Lifecycle

MainAgent stores one LoopAgentSession in `_session`.

**Creation:**
- First executePrompt call creates `_session`

**Reuse:**
- Subsequent executePrompt calls reuse `_session`
- Conversation history is preserved across turns
- When the reused call explicitly supplies `model`, `tags`, or `reasoningEffort`, those values become active before history compression, preparation, pending-input interpretation, and planning for that turn

**Shutdown:**
- shutdown clears `_session`

**Interruption:**
- When an AbortSignal aborts or `cancelCurrentSession()` is called, the active session enters `interrupted` status
- The session appends an interruption event to history, so later planning turns can observe the interruption context
- A new user prompt exits `interrupted` state and returns the session to normal execution

## Model and Tags Passthrough

MainAgent does NOT resolve which model to use. The model and tags parameters pass through unchanged:

```
MainAgent → LLMAgent → invokerStrategy → LLMClient.resolveModelForInvocation()
```

Actual model resolution happens in LLMClient.

The active values belong to the in-memory session and may change between prompts without recreating that session. Loop and SOP session internals use the active model for their LLM calls. A dedicated override remains authoritative where one is explicitly configured, including `historyCompressionModel` for Loop compression and `llmModel` in SOP plan-generator or interpreter options.

Loop and SOP planning preserve their existing runtime history formats. Before each model call, the session derives a provider-facing conversation with system instructions first, prior user/assistant turns in chronological order, and the current user prompt last. This prevents a role-aware provider from receiving the serialized transcript as one user message while avoiding a migration of session snapshots or persisted history.

When a new loop session receives `initialHistory`, it converts user records into internal user entries and assistant records into internal final-answer entries before processing the current prompt. System roles, empty messages, and malformed records are rejected. This preserves the internal session schema while allowing a host to restore an external conversation without serializing it into the current user message.

## What Execution Does NOT Do

- Does NOT expose sessionId-based APIs
- Does NOT support concurrent multi-session routing in MainAgent
- Does NOT support review modes (none, llm, human)
- Does NOT generate conversation summaries
- Does NOT select orchestrators automatically for executePrompt
- Does NOT perform heuristic skill selection
- Does NOT inject session memory into options
- Does NOT inject I/O services into options
- Does NOT support SOP sessions (executePrompt uses loop sessions)

## Testable Functionality

Test files should be created in tests/mainAgent/

**executePrompt tests should cover:**
- Creates new session when none exists
- Reuses existing session on subsequent calls
- Passes model parameter through unchanged
- Passes tags parameter through unchanged
- Passes systemPrompt through to session
- Passes initialHistory through only during session creation
- Passes signal through to session creation and reused session prompts
- Updates the active model on a reused session without discarding history
- Propagates the active parent-session model to delegated skill execution
- Returns session result

**executeSkill tests should cover:**
- Finds skill by canonical name
- Finds skill by short name (alias)
- Throws error when skill not found
- Delegates to correct subsystem
- Passes options through to subsystem
- Rejects a disabled skill without fallback

**Session management tests should cover:**
- First executePrompt creates session
- Second executePrompt reuses existing session
- shutdown clears session
- cancelCurrentSession marks active session interrupted
