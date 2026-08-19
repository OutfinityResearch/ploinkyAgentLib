---
title: DS001-vision
summary: Defines AchillesAgentLib's vision as a composable low-level LLM agent with agentic loops, specialized skill types, agent-managed memory, and file-backed support services.
---

## Introduction

AchillesAgentLib exists to give Node.js applications a deliberately low-level LLM agent that can reason and act through an agentic loop without imposing a complete application, workflow, or product around it. The library treats [skills](../wiki.html#definition-skill) and memory as core agent capabilities and provides specialized services that an application can compose around the agent.

## Core Content

### A Foundational LLM Agent

The library must provide a reusable LLM agent whose essential behavior is an [agentic session](../wiki.html#definition-agentic-session): the agent receives a request, selects or plans actions, executes permitted tools, observes their results, and continues until it can return an outcome or reaches an explicit boundary. The agent must remain suitable as a foundation that applications can configure and extend rather than becoming a standalone assistant with one fixed workflow.

Memory and skills must remain first-class parts of this foundation. An application must be able to give the agent reusable operations, retain the state needed for multi-step work, and choose which persistent information is supplied to later requests.

### Specialized Skill Types Beyond SKILL.md

The product vision assumes that one general-purpose Anthropic `SKILL.md` structure is not sufficient for every category of agent task. AchillesAgentLib must support custom skill types whose descriptors, folder structures, preparation stages, validation rules, generated artifacts, and execution contracts can differ when the task requires a stronger domain-specific structure.

The type of work must determine the skill contract. Orchestration skills may define multi-step coordination, code skills may package executable source, and DBTable skills may define database-oriented tables, controllers, and operations. The library must make it possible to add further skill families without forcing their requirements into a single generic descriptor or execution path.

This specialization must preserve a common agent-facing result: enabled skills become operations that the agent can understand and invoke, while the corresponding subsystem enforces the structure and lifecycle required by that skill family.

### Agent-Managed Memory and Work Files

The library must provide companion services that are designed to work with the foundational agent. [Agentic Knowledge Units](../wiki.html#definition-agentic-knowledge-units), [MarkdownDataStore](../wiki.html#definition-markdown-data-store), and [BacklogManager](../wiki.html#definition-backlog-manager) must give applications structured, file-backed ways to retain knowledge, records, tasks, decisions, and execution history.

These files and their section conventions must be optimized for deterministic management by an LLM agent. They may remain inspectable by people, but their primary author and maintainer is expected to be an agent that can select, append, replace, validate, and retrieve well-defined sections without rewriting an entire unstructured document.

### Composable Library Boundary

Applications must remain free to combine the agent, skill families, memory, and support services according to their own product needs. Persistent services must not become hidden dependencies of every session, and specialized skill types must not make the base agent dependent on one task domain. Provider credentials, external services, and application-specific security policy remain responsibilities of the integrating application.
