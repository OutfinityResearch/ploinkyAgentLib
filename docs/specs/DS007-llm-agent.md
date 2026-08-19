---
title: DS007-llm-agent
summary: Defines LLMAgent as the single provider boundary for model calls, contextual prompting, structured interpretation, usage tracking, cancellation, and session creation.
---

## Introduction

[LLMAgent](../wiki.html#definition-llm-agent) isolates the rest of AchillesAgentLib from provider-specific invocation details. It exists so sessions, subsystems, and applications share one contract for model selection, context, response parsing, observability, cancellation, and the construction of agentic sessions.

## Core Content

### Single Provider Invocation Path

`complete()` must be the central path for every provider call. It must preserve the requested model, semantic tags, conversation history, additional context, abort signal, caller model mappings, and reasoning effort when it delegates to the provider strategy.

The method must record cumulative input and output character counts and call metadata so applications can inspect model use through one boundary. A component must not bypass this path merely because it needs a specialized response format.

### Contextual Prompt Execution

`executePrompt()` may combine the immediate prompt with caller-supplied global, user, session, and skill memory. Each memory source must remain explicit so applications control which persistent information becomes model context.

The method must support raw text and the documented JSON, code, and JSON-code coercions. When the caller requires a structured shape, LLMAgent must reject an unparseable response instead of returning ambiguous text as if validation succeeded.

### Deterministic Interpretation Before Model Fallback

`interpretMessage()` and `resolveConfirmation()` must apply deterministic heuristics before asking a model to interpret simple input. This reduces unnecessary provider calls and makes common confirmations reproducible.

`detectIntents()` must require the documented Markdown response structure and fail explicitly when the structure cannot be parsed. Interpretation helpers must not silently invent missing fields or weaken a caller's required output contract.

### Session Construction

Session factory methods must validate their inputs, construct LoopAgentSession or SOPAgenticSession with the current LLMAgent as its model-facing agent, execute the initial prompt, and return the live session object. The factory owns correct construction; the returned session owns subsequent conversation state and continuation.

The effective supervisor, tool or command surface, model choices, limits, history, and preparation options must reach the session through this boundary without being replaced by provider defaults.

### Cancellation and External Limits

`cancel()` must request interruption of in-flight provider work and sessions must propagate their abort signals into LLMAgent calls. Cancellation is cooperative and remains bounded by the selected provider adapter's ability to stop or abandon a request.

LLMAgent must not own provider credentials, service availability, application persistence, or security policy. It carries those externally supplied choices into a consistent model-call contract.
