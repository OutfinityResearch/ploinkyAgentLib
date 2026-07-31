# DS004 - LLMAgent

## Purpose

LLMAgent is the mediation layer for model calls, text interpretation, output coercion, and agentic session creation. It sits between the top-level agent (MainAgent) and the LLM provider infrastructure.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        LLMAgent                           │
│                                                           │
│  ┌─────────────────┐   ┌──────────────────────────────┐  │
│  │  Model Config   │   │     Traffic Counters         │  │
│  │  (tag → model)  │   │  _inputCounter, _outputCounter│  │
│  └────────┬────────┘   └──────────────────────────────┘  │
│           │                                               │
│  ┌────────▼──────────────────────────────────────────┐   │
│  │              Execution Hub                         │   │
│  │                                                    │   │
│  │  complete() ──> extraComplete() ──> invokerStrategy│   │
│  │       ▲                                            │   │
│  │       │                                            │   │
│  │  interpretMessage() ───────────────────────────────┤   │
│  │  resolveConfirmation() ────────────────────────────┤   │
│  │  detectIntents() ──────────────────────────────────┤   │
│  │  executePrompt() ──> extraDoTask() ────────────────┤   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │              Session Creation                     │    │
│  │  startLoopAgentSession() → LoopAgentSession      │    │
│  │  startSOPLangAgentSession() → SOPAgenticSession  │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## Core Capabilities

- **Prompt completion** — sends prompts to LLM via configured invoker strategy
- **Structured responses** — coerces output to JSON, code, or text formats
- **Intent classification** — interprets user messages for action intent
- **Confirmation resolution** — determines yes/no/unclear from user input
- **Loop session creation** — starts bounded multi-step agentic sessions
- **SOP session creation** — starts structured plan-then-execute sessions
- **Memory context injection** — incorporates global, user, session, and skill memory into prompts
- **Model configuration** — semantic tag-to-model mapping via modelConfig
- **Traffic tracking** — counts input/output characters for performance metrics

## Constructor Behavior

LLMAgent requires a name and an invoker strategy function.

**Accepted parameters:**
- `name` — agent identifier (defaults to "DefaultLLMAgent")
- `invokerStrategy` — function that handles the actual LLM invocation (defaults to the library's default strategy)
- `modelConfig` — object mapping semantic tags to model names (e.g., `{ thinking: 'claude-sonnet-4', fast: 'gpt-4o-mini' }`)

**What happens on construction:**
1. Validates name is a non-empty string
2. Resolves invoker strategy (uses default if not provided)
3. Validates invoker strategy is a function
4. Resolves modelConfig from `LLMConfig.json` defaults if not provided
5. Initializes input/output character counters
6. Initializes call log for per-call diagnostics

## Model Configuration

LLMAgent maintains a `modelConfig` object that maps semantic tags to model names. This allows subsystems and skills to request models by purpose rather than by concrete name.

**Default modelConfig** is loaded from `LLMConfig.json` under the `defaults` key. If no `modelConfig` is provided to the constructor, LLMAgent reads the defaults from the configuration file. Example from `LLMConfig.json`:
```json
{
    "defaults": {
        "coding": "soul_gateway/code",
        "fast": "soul_gateway/fast",
        "thinking": "soul_gateway/plan",
        "writing": "soul_gateway/write",
        "research": "soul_gateway/deep"
    }
}
```

**Methods:**
- `getModelByTag(tag)` — resolves a tag to a model name. Returns the mapped model if the tag exists in modelConfig, otherwise returns the tag itself (normalized).
- `setModelConfig(modelConfig)` — replaces the current modelConfig. Pass null to reset to defaults.

Provider configuration is resolved by the LLM provider loaders, not by `LLMAgent` instances directly. The canonical path for the `soul_gateway` provider is `PLOINKY_AGENT_API_KEY`, resolved by the provider loader. Generated Ploinky agent credentials marked with `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY=generated` route through the local router service, while operator URL overrides still use `SOUL_GATEWAY_BASE_URL` or `SOUL_GATEWAY_URL`.

**Example:**
```javascript
const agent = new LLMAgent({
    modelConfig: {
        thinking: 'claude-sonnet-4',
        fast: 'gpt-4o-mini',
    },
});

agent.getModelByTag('thinking'); // 'claude-sonnet-4'
agent.getModelByTag('fast');     // 'gpt-4o-mini'
agent.getModelByTag('unknown');  // 'unknown' (fallback)
```

## Method Call Flow

All LLM calls converge through `complete()`, which delegates to `extraComplete()` in `LLMAgentExtra.mjs`:

```
interpretMessage() ──┐
resolveConfirmation()├──> complete() ──> extraComplete() ──> invokerStrategy()
detectIntents()      ┘
executePrompt() ──> extraDoTask() ──> complete() ──> ...
```

The `_recordInputChars()` and `_recordOutputChars()` methods are called automatically inside `extraComplete()` to track traffic.

## Execution Methods

### complete(options)

The central hub for all LLM calls. Accepts a prompt, optional history, model, tags, and context. Delegates to `extraComplete()` which:
1. Records input character count
2. Calls the invoker strategy with resolved model
3. Records output character count
4. Logs the interaction (model, tags, duration)
5. Pushes entry to the per-call log

**Used by:** `interpretMessage`, `resolveConfirmation`, `detectIntents`, `extraDoTask` (which backs `executePrompt`).

`history` is an ordered array of `{ role, message }` records. The default invoker copies that array and appends `prompt` as the final `{ role: 'user', message: prompt }` record before provider conversion. This keeps system instructions, earlier user turns, earlier assistant turns, and the current user request structurally distinct. Provider adapters preserve the OpenAI-style roles or translate them to the provider's native equivalent: Anthropic extracts system text, Gemini maps assistant to `model`, Responses/Codex and Copilot Responses map system to `developer`, and classic completions flatten the same ordered roles into labeled text.

High-level sessions may retain richer domain-specific history records for runtime bookkeeping. They derive the role-aware `complete()` history at invocation time; they do not mutate their persisted or in-memory session history schema to match the provider payload.

Error reporting remains attached to the original invocation path. If a provider adapter returns `null`, `undefined`, an object without a text `output`, or another unsupported shape, `complete()` states that exact shape instead of exposing the internal `invokerStrategy` contract. Provider HTTP failures use the standard HTTP status and reason phrase, while structured upstream payloads contribute only their message rather than serialized response bodies. Structured-output coercion errors identify the required JSON, code, or Markdown contract without embedding the model response in normal user-facing output.

### executePrompt(promptText, options)

Completion with memory context injection. Prepends memory segments (global, user, session, skill) to the prompt, then routes through `extraDoTask()` → `complete()`. Supports `responseShape` coercion:
- `'json'` — extracts and parses JSON, throws on failure
- `'code'` — strips markdown code fences
- `'json-code'` — extracts JSON object requiring a `code` field

**Used by:** All subsystems (CodeSkills, DCG, PloinkyAgent, DBTable, Orchestrator), evals suite.

### detectIntents(skillsDescription, userPrompt, options)

Analyzes a user prompt against a described skill space to determine which skills are relevant and what intents are present. Returns an object parsed from markdown sections in the LLM response.

**Used by:** `evalsSuite/evalDetectIntents.mjs` — evaluates intent detection accuracy.

## Interpretation Methods

### interpretMessage(message, options)

Classifies a short user message into bounded operational signals: `accept`, `cancel`, `update`, `ideas`, or `unknown`. Uses a two-stage approach:
1. **Heuristic matching** — fast pattern-based classification via `classifyIntent()`
2. **LLM fallback** — if heuristics are inconclusive, sends the message to the LLM for classification

**Used by:** `LoopAgenticSession/LoopAgentSession.mjs` and `SOPAgenticSession/SOPAgenticSession.mjs` — when a tool is awaiting user input, determines whether the user's reply should continue the pending tool (accept/cancel/update) or start a fresh instruction.

### resolveConfirmation(userInput, options)

Determines whether user input represents `yes`, `no`, or `unclear`. Uses a two-stage approach:
1. **Pattern matching** — checks against known yes/no patterns (`yes`, `y`, `ok`, `sure`, `no`, `n`, `cancel`, etc.)
2. **LLM fallback** — for ambiguous input (`maybe`, `I think so`), sends to LLM for classification

Returns `{ decision: 'yes'|'no'|'unclear', confidence: number }`.

**Used by:** `ConfirmationUtils.mjs` — called by DBTableSkills flow handlers (create, update, delete, validation) when confirming operations with the user.

## Session Creation

### startLoopAgentSession(tools, initialPrompt, options)

Creates a `LoopAgentSession` — a bounded multi-step execution where the LLM planner decides which tool to call at each step. The session runs until a final answer is reached or limits are hit.

Notable options passed through to the loop runtime include:
- Execution limits (`maxStepsPerTurn`, `maxErrors`, `maxRetriesPerTurn`)
- Planner routing model/tags (`model`, `tags`)
- Supervisor control (`supervisor`)
- Cancellation signal (`signal`)
- Initial role-aware history (`initialHistory`) for hydrating a newly created session
- History compression controls (`historyCompressionEnabled`, `historyCompressionThresholdTokens`, `historyCompressionKeepRecentEntries`, `historyCompressionMaxSummaryTokens`, `historyCompressionModel`)

**Used by:** `MainAgent.executePrompt()`.

### startSOPLangAgentSession(skillsDescription, initialPrompt, options)

Creates a `SOPAgenticSession` — a structured plan-then-execute workflow using LightSOPLang. The LLM generates a plan of tool invocations with dependencies, then executes them (potentially in parallel).

**Used by:** `OrchestratorSkillsSubsystem`.

## Traffic Counters

### getInputCounter() / getOutputCounter()

Return cumulative character counts for all LLM calls made by this agent instance. Used by the evals suite to measure token volume and performance across test runs.

### _recordInputChars(count) / _recordOutputChars(count)

Private methods called automatically by `extraComplete()`. Accumulate character counts for input prompts and output responses.

## Cancellation

### cancel()

Aborts all in-flight LLM requests by calling `cancelRequests()` from `LLMClient`. Used as a safety mechanism for timeouts, UI interruption, or shutdown scenarios. Session runtimes may also invoke this method when they transition to an interrupted state.

## Model and Tags

Model and tags are resolved through `getModelByTag()`. When a method receives a `model` parameter, it uses that directly. When no model is specified, it falls back to `getModelByTag('thinking')`. The actual model string is then resolved by the invoker strategy through LLMClient's `resolveModelForInvocation`.

## What LLMAgent Does NOT Do

- Does NOT hold a supervisor instance (passed through session options)
- Does NOT manage skill discovery or registration
- Does NOT execute skills directly (delegated to subsystems)
- Does NOT manage session lifecycle beyond creation
- Does NOT read environment variables for model selection itself; provider and credential loaders may read environment variables before invocation
- Does NOT handle I/O directly (uses `IOServices` singleton for input/output)

## Decisions & Questions

### Question #1: How is the `soul_gateway` provider credential resolved? (updated 2026-06-24)

Response:
There is no explicit hosted-key precedence. The earlier compatibility bridge — where an operator-supplied `SOUL_GATEWAY_API_KEY` marked `explicit` could win over generated local credentials — was removed in the subject-identity decoupling hard cut. The `soul_gateway` provider now resolves its credential solely from the generated `PLOINKY_AGENT_API_KEY` (signed-subject), routing through the embedded Ploinky router service. The removed `SOUL_GATEWAY_API_KEY` alias and its provenance/precedence handling no longer exist; operator access to a remote gateway is configured as a normal provider account, not by substituting the agent credential.

Implementation:

```text
utils/LLMProviders/providers/envConfigLoader.mjs — soul_gateway provider def; resolveSoulGatewayEnvNames() returns ['PLOINKY_AGENT_API_KEY']; resolveSoulGatewayBaseURL() treats the credential as generated based on PLOINKY_AGENT_API_KEY only
LLMConfig.json — soul_gateway provider apiKeyEnv = PLOINKY_AGENT_API_KEY
```

### Question #2: Why are provider response bodies omitted from ordinary error messages?

Response:
Provider bodies can be verbose, implementation-specific, or contain data that should remain diagnostic metadata. A short provider label plus the standard HTTP status phrase explains the failure category without leaking the upstream payload. Errors are still thrown at the provider call site so callers retain the original stack and source location.

## Testable Functionality

Test files should be created in tests/mainAgent/ or tests/llmAgent/

**LLMAgent tests should cover:**
- Constructor requires non-empty name
- Constructor accepts custom invoker strategy
- Constructor uses default invoker strategy when not provided
- Constructor accepts modelConfig
- Default modelConfig loaded from LLMConfig.json
- getModelByTag resolves known tags correctly
- getModelByTag returns normalized tag for unknown tags
- getModelByTag handles null/undefined input
- setModelConfig updates the config
- setModelConfig with null resets to defaults
- complete sends prompt and returns text
- complete preserves system/user/assistant history and appends the current prompt with role `user`
- executePrompt injects memory context
- executePrompt coerces response to JSON
- executePrompt coerces response to code
- interpretMessage classifies accept intent
- interpretMessage classifies cancel intent
- resolveConfirmation detects yes response
- resolveConfirmation detects no response
- startLoopAgentSession creates session with tools
- startLoopAgentSession passes supervisor through options
- startLoopAgentSession passes model through options
- startLoopAgentSession passes history compression options through
- startLoopAgentSession passes signal through
- startLoopAgentSession passes initialHistory through
- startSOPLangAgentSession creates SOP session
- Traffic counters accumulate correctly
