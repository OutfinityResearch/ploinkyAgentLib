---
title: DS002-architecture
summary: Defines the architecture that separates application integration, agentic sessions, model access, specialized skill families, and agent-managed persistence.
---

## Introduction

AchillesAgentLib uses a layered architecture because a reusable LLM agent must coordinate requests without owning every execution rule, provider detail, or persistence format. The architecture separates application integration, conversation execution, model access, specialized skill contracts, and file-backed services so each part can evolve without turning the library into one fixed agent application.

## Core Content

### Architectural Direction

The library must keep orchestration separate from execution specialization. [MainAgent](../wiki.html#definition-main-agent) coordinates the skill catalog and begins work, an [agentic session](../wiki.html#definition-agentic-session) owns the evolving state of one conversation, [LLMAgent](../wiki.html#definition-llm-agent) owns model interaction, and each [skill subsystem](../wiki.html#definition-subsystem) owns the rules of one skill family. File-backed utilities remain caller-controlled services rather than implicit parts of every request.

This separation must remain visible in public behavior. A component may delegate work across a boundary, but it must not silently take ownership of another component's state, policy, or persistence contract.

### Request Execution Path

An application must begin general agent work through MainAgent. MainAgent must use LLMAgent to create or continue the appropriate session, and the session must call LLMAgent when it needs a model decision. The principal flow is application → MainAgent → agentic session → LLMAgent, with tool execution leaving the session only through the enabled skill surface and its owning subsystem.

MainAgent must own skill discovery, canonical and alias registries, enabled state, subsystem lookup, the reusable general-prompt session, and direct-skill routing. A session must own per-conversation history, intermediate execution state, continuation, configured limits, approval requests, and interruption. LLMAgent must own provider invocation, model-selection inputs, response coercion, usage metadata, and session construction.

The application supplies external policy and infrastructure. A supervisor supplied by the application must travel through MainAgent into the session so approval is decided at the tool boundary. Provider credentials, reachable services, and product-specific lifecycle choices remain outside the library.

### Specialized Skill Boundary

Each skill family may require a different descriptor, folder layout, preparation stage, generated artifact, validator, or executor. The owning subsystem must preserve those differences rather than reducing every skill to one generic `SKILL.md` contract. `SubsystemFactory` must map recognized type identifiers to subsystem classes and pass the shared MainAgent, model configuration, and logger.

MainAgent must remain the canonical catalog across these families. A subsystem may enrich or build a skill record, but it must not establish a competing global registry. Enabled skills must become a coherent tool surface for the session even when their internal contracts differ.

### Memory and Utility Boundary

[Agentic Knowledge Units](../wiki.html#definition-agentic-knowledge-units), [MarkdownDataStore](../wiki.html#definition-markdown-data-store), and [BacklogManager](../wiki.html#definition-backlog-manager) must remain explicit, caller-operated services. They are designed to hold agent-managed information, but MainAgent and the sessions must not insert, mutate, or persist their data unless the application deliberately connects those services to a request.

Session memory and durable memory must remain distinct. Sessions retain process-local conversation and execution state; persistent services retain selected knowledge or work files across sessions and process restarts.

### Extension Invariants

The public package surface must remain reachable through `index.mjs` and declared package exports. New modules may specialize one architectural responsibility, but no module may bypass LLMAgent for LLM calls, make a persistence service an undeclared session dependency, or collapse all skill families into one execution contract.
