---
title: DS009-subsystems
summary: Defines how specialized subsystems preserve different skill descriptors, build lifecycles, validators, executors, and remote boundaries behind one MainAgent catalog.
---

## Introduction

AchillesAgentLib supports task-specific skill types because one generic skill structure cannot express every preparation, generation, validation, and execution need. [Skill subsystems](../wiki.html#definition-subsystem) isolate those differences while letting MainAgent present one coherent catalog to applications and agentic sessions.

## Core Content

### Shared Subsystem Lifecycle

A subsystem must implement the phases required by its family: descriptor parsing, lightweight registration-time preparation, optional asynchronous building, and prompt execution. Preparation may validate and enrich a discovered record, but heavy model calls, code generation, or filesystem production must remain in an explicit build phase.

Every execution result must return through the shared MainAgent or session boundary even when the subsystem uses a local module, generated controller, nested agentic session, or remote agent internally.

### Factory and Ownership

`SubsystemFactory` must map each recognized type identifier to one subsystem class, create the instance on demand, cache it for reuse, and pass the shared MainAgent, model configuration, and logger. Unknown types must not be guessed or silently routed to a superficially similar executor.

MainAgent must remain the canonical registry of discovered, enabled, disabled, canonical, and alias records. A subsystem may attach family-specific state to a record, but it must not create a competing top-level catalog or expose a disabled record through another route.

### Specialized Skill Families

Code skills must use `cskill.md` to describe executable ESM kept in the skill folder. Dynamic-code skills must use their own descriptor and may decide at runtime whether a request needs generated code or a text result. Orchestration skills must define coordination work and choose Loop or SOP execution according to their descriptor and plan requirements.

DBTable skills must preserve database-oriented table definitions, generated controllers, operation validation, and timeout boundaries. A Ploinky agent may be exposed as a skill only within an o-skill that declares it through `Allowed Agents`. The Ploinky agent's `agent-card` payload provides its runtime descriptor metadata and tool description; the agent does not participate in filesystem skill discovery and has no static `.md` descriptor file of its own. Ploinky agent skills must preserve this remote discovery and invocation boundary rather than copying agents into the local code-skill contract.

The existence of these families is architectural, not cosmetic. Their descriptors and lifecycles may differ because the work has different safety, validation, generation, and execution requirements.

### Generated Artifacts and Portability

Generated modules must remain derived artifacts. Their source descriptor, local specifications, or table definition must be changed and the module regenerated; the generated file must not become a second source of truth.

Skill-local implementation, examples, and specifications must remain in the skill folder when portability depends on them. A copied skill must not require an undeclared root source tree to retain its behavior.

### Extensibility Boundary

A new skill family may be added when its task category requires a materially different descriptor, lifecycle, validator, executor, or external boundary. It must integrate through SubsystemFactory and MainAgent rather than bypassing discovery, enabled state, supervision, or session tool exposure.
