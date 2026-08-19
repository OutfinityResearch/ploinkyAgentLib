---
title: DS003-main-behavior
summary: Defines the five product behaviors through which applications run requests, use specialized skills, control sessions, reach models, and manage durable project memory.
---

## Introduction

AchillesAgentLib fulfills its purpose when an application can submit work to a reusable LLM agent, let that agent use the right specialized skills, continue safely across multiple steps, and deliberately connect durable project memory. The following behaviors are the small set of end-to-end outcomes that define that experience.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Reusable request execution | An application submits prompts through MainAgent and receives results from one continuing Loop session whose context survives later turns. |
| Skill discovery and execution routing | MainAgent turns supported workspace descriptors into an enabled tool catalog and routes each invocation to the subsystem that understands its skill type. |
| Bounded adaptive and plan-first sessions | Loop and SOP sessions let an agent perform multi-step work while preserving approval, continuation, interruption, and explicit stopping limits. |
| LLMAgent model mediation | Every component reaches a model through one configurable boundary that preserves model choice, task tags, reasoning effort, cancellation, and response handling. |
| Deterministic local project memory | An application uses AKU to retain selected project knowledge as validated local records and retrieve bounded context without hidden LLM processing. |

### Reusable request execution

An application triggers reusable request execution by calling `MainAgent.executePrompt()`. On the first call, MainAgent must create a LoopAgentSession through LLMAgent and pass it the enabled tool surface, supervisor, model options, and optional initial history. MainAgent must retain that session and forward later prompts through `newPrompt()` so the agent can use earlier conversation and tool results.

The application must receive the latest session result and lifecycle status after each prompt. Initial history may seed a new session, but it must not replace the history of an already running session. The process-local session remains reusable until shutdown or explicit replacement; durable continuity requires a caller-owned persistence service.

### Skill discovery and execution routing

MainAgent must discover supported descriptors below `startDir`, preserve canonical names and aliases, and keep disabled records out of build, direct execution, and session tool exposure. Workspace skills must define the application's working catalog, while package-internal skills must remain disabled by default and may be enabled explicitly.

An application may invoke a named skill directly through `executeSkill()` or allow a session to select it as a tool. MainAgent must resolve the name and delegate the record to the subsystem for that skill family. A workspace skill registered with the same canonical name must replace the package-internal record so application behavior is not silently controlled by a bundled fallback.

### Bounded adaptive and plan-first sessions

A LoopAgentSession must support adaptive work in which each model decision depends on the latest history and tool result. It must select one next action, obtain required approval, execute the permitted tool, record the outcome, and repeat until it produces a final answer, requests clarification, is interrupted, or reaches a configured step, error, or retry limit.

A SOPAgenticSession must support plan-first work by generating and validating [LightSOPLang](../wiki.html#definition-light-sop-lang), executing commands whose dependencies are ready, pausing when a command needs user input, and performing bounded replanning after recoverable failures. Both regimes must reserve explicit final-answer and cannot-complete outcomes, retain continuation state in memory, and propagate cancellation through abort signals.

### LLMAgent model mediation

Every component that needs an LLM must call LLMAgent rather than reaching a provider directly. LLMAgent must accept an explicit model, [model tags](../wiki.html#definition-model-tag), reasoning effort, history, context, cancellation, and manual model mappings, then pass the resolved request to the configured provider strategy.

This boundary must give an application one place to configure model routing and one observable path for provider calls. Provider credentials, provider availability, and the concrete meaning of application-defined tiers remain the integrating application's responsibility.

### Deterministic local project memory

An application may initialize AKU and Knowledge Units, record evidence, register files and folders, maintain links and scopes, ingest session information, search indexed records, and build character-budgeted ContextPacks. AKU must use validated local records, locked atomic persistence, deterministic lexical retrieval, and explicit filtering so the same stored data can be inspected and recovered without hidden model behavior.

Normal retrieval must exclude discarded or obsolete material unless the caller requests it, and physical deletion must require explicit confirmation. AKU must not decide whether knowledge is true, inject itself into prompts, provide vector retrieval, or invoke an LLM; the application remains responsible for choosing what is stored and when retrieved context is used.
