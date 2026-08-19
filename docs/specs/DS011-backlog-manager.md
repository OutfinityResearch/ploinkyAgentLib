---
title: DS011-backlog-manager
summary: Defines BacklogManager as an agent-oriented task record with explicit alternatives, approval, completion history, serialized mutations, and no hidden execution policy.
---

## Introduction

[BacklogManager](../wiki.html#definition-backlog-manager) gives an application or LLM agent a small, deterministic way to record unresolved work, propose alternatives, approve a resolution, and preserve completed history. It separates deciding what should happen from executing the work so an agent can manage task state without treating a free-form document as an implicit queue.

## Core Content

### File and Task Model

A caller-supplied base path must resolve to paired `.backlog` and `.history` files. The backlog holds active tasks, while history holds tasks that have been explicitly completed. This separation must remain stable so an agent can inspect pending work without repeatedly filtering completed entries.

Each active task must contain a description, an ordered set of options, and a resolution field. Public task arguments must use one-based indexing because task and option numbers are intended to be referenced directly in agent prompts and structured responses.

### Task Lifecycle

The API must support creating and loading a backlog, adding one task or parsing numbered tasks from text, adding numbered options, approving a resolution, applying constrained updates, and selecting new or approved tasks. Parsing helpers must preserve explicit numbering and must not infer approval from descriptive text alone.

Approving a task must record the selected resolution but must not execute it. `markDone()` must move the chosen task from the active backlog into history and use the stored resolution as the completion result. When no resolution exists, completion must use the explicit fallback `Executed.` rather than inventing a narrative outcome.

### Agent-Managed Workflow

The file shape must remain simple enough for an agent to read task numbers, alternatives, and decisions deterministically. People may inspect the files, but callers should mutate them through BacklogManager so indexing, validation, and history movement stay consistent.

BacklogManager must not prioritize tasks, choose an option, infer that an action succeeded, schedule work, or invoke a skill. An application or agent owns those decisions and records them through the API.

### Persistence and Concurrency

Persistence must use the per-file I/O queue and atomic save behavior provided by `backlogIO.mjs`. Multiple mutations targeting the same backlog must be serialized so a later write does not silently discard an earlier task change.

The explicit `flush()` or force-save boundary must let callers wait for queued persistence. BacklogManager must operate only on the paths derived from the supplied base path and must not create an application-wide backlog registry.
