---
title: DS006-main-agent
summary: Defines MainAgent as the application-facing coordinator for skill discovery, supervision, reusable prompt sessions, direct skill execution, refresh, and shutdown.
---

## Introduction

[MainAgent](../wiki.html#definition-main-agent) is the application-facing coordinator of AchillesAgentLib. It exists so an application can configure one agent, discover a heterogeneous workspace skill catalog, apply supervision consistently, and choose between conversational execution and direct invocation without owning subsystem internals.

## Core Content

### Construction and Catalog Ownership

Construction must create or accept LLMAgent, establish the effective SecuritySupervisor, create SubsystemFactory, initialize canonical and alias registries, and discover the configured skill roots. MainAgent must remain the sole owner of the top-level catalog even though subsystems prepare and execute individual records.

Workspace skills must be discovered below `startDir`. Package-internal skills must remain excluded unless `disableInternalSkills` is explicitly false. Canonical names and aliases must resolve to one record, and a workspace record must take precedence over an internal record with the same canonical name.

### Supervisor Propagation

Construction must accept an application-supplied supervisor and create SecuritySupervisor only when the application does not provide one. `executePrompt()` must pass the effective supervisor through LLMAgent into LoopAgentSession, and the session must retain it for tool approval decisions.

When MainAgent delegates a session-selected tool to a skill, it must forward the parent session's supervisor and available approval metadata in the execution options. The supervisor decides whether a proposed tool action may proceed; it must not choose the tool, invoke the model, or perform the skill action itself.

### Reusable Prompt Execution

The first `executePrompt()` call must create one LoopAgentSession using the current enabled tool surface and supplied session options. Later calls must use `newPrompt()` on the same object so history, intermediate results, approvals, and limits continue across turns.

Initial history may be applied only when the session is created. MainAgent must return the current session result and status after each prompt, but it must not treat the process-local session as durable storage across process restarts.

### Direct Skill Execution and Building

`executeSkill()` must resolve canonical names and aliases, reject missing or disabled skills, and delegate a valid record to its owning subsystem. Direct execution and session-selected execution must share the same catalog and enabled-state rules.

`buildSkills()` must start build hooks for enabled skills concurrently and isolate individual failures so one unsuccessful build does not erase the results of unrelated skills. Heavy generation work must occur during the explicit build stage rather than discovery.

### Refresh and Enabled State

`refreshSkills()` must preserve non-workspace records and the user's disabled-state intent, rebuild workspace records and aliases, and report added, updated, and removed names. When a reusable session exists, refresh must replace its tool surface without replacing the session object or discarding conversation state.

`enableSkills()` and `disableSkills()` must validate the entire requested batch before mutating any record. A partially invalid batch must not leave the catalog in a partially changed state.

### Shutdown Boundary

`shutdown()` must cancel current work, close instantiated subsystems, clear the reusable session, and close the logger. It must release process-owned resources without deleting caller data or presenting session memory as persistent project memory.
