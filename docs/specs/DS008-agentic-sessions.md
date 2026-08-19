---
title: DS008-agentic-sessions
summary: Defines the adaptive Loop and plan-first SOP session regimes, their memory, continuation, supervision, tool boundaries, stopping rules, and interruption behavior.
---

## Introduction

An LLM agent cannot complete every request in one model response. [Agentic sessions](../wiki.html#definition-agentic-session) provide the process-local memory and control loop required to plan actions, use tools, observe results, pause for input, and continue safely across prompts. AchillesAgentLib provides two regimes because adaptive action selection and dependency-aware plan execution require different state and stopping behavior.

## Core Content

### Shared Session Contract

Both session regimes must retain enough state to explain and continue their current work. They must expose lifecycle status, latest answer, conversation history, model options, execution records, and a serializable snapshot that callers can inspect or pass to child work.

Sessions must reserve explicit final-answer and cannot-complete operations and reject user tools that collide with those names. They must propagate abort signals, stop at configured limits, preserve their object identity when the tool surface changes, and record a refresh in history so later decisions see the changed execution boundary.

### Adaptive Loop Sessions

[LoopAgentSession](../wiki.html#definition-loop-session) must retain prompts, compressed and recent history, turn records, tool calls, intermediate variables, failures, the active tool surface, approval state, model options, status, and latest answer. Each step must ask LLMAgent for one next action based on the latest state, obtain approval when required, execute the selected tool, and record the outcome before planning again.

The loop must stop when it emits a final answer, needs clarification, is interrupted, reaches `maxStepsPerTurn`, reaches `maxErrors`, or exhausts a retry boundary. History compression may summarize older entries when a threshold is reached, but it must preserve the configured recent window and leave enough context for continuation.

### Plan-First SOP Sessions

[SOPAgenticSession](../wiki.html#definition-sop-session) must retain history, current LightSOPLang plan, execution variables, failures, pending user-input command, command registries, preparation context, model options, status, and latest answer. It must generate a plan, validate every command and dependency topology, and reject an invalid plan before any command executes.

Execution must run commands whose dependencies are ready. A command that needs user input must be stored as `pendingTool` and return control to the caller. Recoverable failures may return to bounded replanning, while `planOnly` or `generatePlanOnly` must stop after generation without pretending that the plan was executed.

### Supervision and Execution Authority

Both regimes may receive a [SecuritySupervisor](../wiki.html#definition-security-supervisor). The supervisor must decide whether a proposed tool or command may execute at the approval boundary; it must not choose the next action, generate the plan, invoke LLMAgent, or perform the action itself.

The active tool or command registry is the session's executable authority. Model output must not create permission to call an operation that is absent from that registry, disabled by MainAgent, rejected by validation, or denied by the supervisor.

### Continuation, Interruption, and Persistence

`newPrompt()` must continue the existing session object and preserve the state appropriate to its regime. A Loop session may update turn options before continuing; a SOP session may resume pending input, treat the message as a new instruction, or continue after interruption according to its state.

Session memory is process-local and must not be represented as durable project memory. An application that needs continuity across process restarts must serialize the information it chooses and use an explicit persistence service such as AKU or MarkdownDataStore.
