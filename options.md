# LLMAgent Prompt Options

The `LLMAgent` family of helpers exposes a consistent set of options for prompt-driven methods
(`executePrompt`, `complete`, `doTask`, etc.). This cheat sheet captures the most relevant fields
and how the new skill subsystems consume them.

## Common Fields

| Option          | Type            | Description |
|-----------------|-----------------|-------------|
| `mode`          | `"fast" \| "deep"` | Preferred latency/quality trade-off. Falls back to the other mode if no model is available. |
| `model`         | `string`        | Explicit model name. Overrides `mode` preference. |
| `context`       | `object`        | Arbitrary metadata exposed to invoker strategies (e.g. `{ intent: 'code-skill-default' }`). |
| `history`       | `Array<{role, message}>` | Conversation turns to prepend to the request. |
| `sessionMemory` | `Array \| {history}` | Captures prior user/assistant messages. `executePrompt` stitches it into the request and updates it after completion. |
| `responseShape` | `'json' \| 'json-code' \| 'code' \| 'markdown'` | When provided, the agent validates/coerces the raw response before returning it. For example, `'json'` parses the payload, while `'json-code'` ensures a JSON object with a `code` property. |

## `executePrompt(promptText, options)`

- Accepts the common fields above.
- When any of the memory buckets (`globalMemory`, `userMemory`, `sessionMemory`, `skillShortMemory`)
  are provided, their string representations are prepended to the synthesized prompt before
  delegating to `doTask`.
- When `responseShape` is specified, the method validates and normalises the raw LLM output before
  returning it to the caller.

## `doTask(agentContext, description, options)`

- `agentContext` or `options.sessionMemory` supplies the conversational history included in the
  generated prompt.
- `options.outputSchema` embeds a JSON schema in the instructions and is honoured by most LLM
  providers.

## `complete(options)`

- Low-level wrapper around the provider invoker. All options above are supported.
- Additional helper when working with code skills: `context.responseShape` is not strictly required,
  but providing `{ responseShape: 'json-code' }` can help future invoker strategies tune prompts.

## Subsystem-Specific Options

### Code Skills

- Use the `LLM Mode` section inside the `dcgskill.md` descriptor to toggle between `fast` and `deep`
  reasoning. The subsystem passes the selected mode via the options object so both the default
  executor and custom modules can honour it (see `context.llmMode`).
- The subsystem calls `LLMAgent.executePrompt(..., { responseShape: 'json' })` for decision
  prompts and `responseShape: 'json-code'` when JavaScript snippets are required. Invalid responses
  raise descriptive errors and the raw snippet is included in the exception message to aid
  debugging.
- Responses wrapped in Markdown fences are automatically unwrapped before JSON parsing.

### Ploinky Agent / Orchestrator

- These subsystems treat descriptors as informational (no interactive loop). The returned payload is
  a structured summary derived from the descriptor sections.

---

Keep this document updated as new subsystems or options appear so tests and utilities stay aligned
with the public contract.
