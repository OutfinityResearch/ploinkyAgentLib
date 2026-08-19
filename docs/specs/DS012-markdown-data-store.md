---
title: DS012-markdown-data-store
summary: Defines MarkdownDataStore as an agent-oriented, root-bounded Markdown record service with numbered sections, targeted mutations, and predictable structured-text conventions.
---

## Introduction

[MarkdownDataStore](../wiki.html#definition-markdown-data-store) gives an application or LLM agent a predictable way to manage file-backed records without rewriting an entire unstructured Markdown document. It uses named, numbered sections and constrained mutation operations so an agent can retrieve or change only the part of a record relevant to its current task.

## Core Content

### Rooted Record Model

Construction must require a data directory that becomes the storage root. Type and file names must be normalized, and every resolved Markdown path must remain below that root. A caller must not escape the root by using absolute paths, parent segments, or crafted names.

Each record must render as an ordered sequence of numbered level-three sections. Section names provide stable semantic handles, while one-based section numbers give an agent a compact selection mechanism. Empty content must normalize to `*None*` so absence has one explicit persisted representation.

### Selection and Targeted Mutation

The API must list records, read a complete record or selected sections, expose a section map and file statistics, and replace a complete file when the caller explicitly chooses that operation. Section selectors may use names or one-based indexes and must preserve record order in returned and rewritten content.

Callers must be able to append lines, append only lines that are not already present, update an existing section, create a missing section, delete selected sections, or delete a complete record. A targeted operation must not rewrite unrelated section meaning or silently renumber a caller's selection before the mutation is applied.

### Structured Text Conventions

List, dialogue, and key-value parsers and renderers must preserve their documented Markdown shapes. These conventions exist so an agent can exchange predictable structured text while the persisted file remains readable Markdown.

The utility must parse only the structures it documents. It must not infer domain semantics, invent missing keys, treat arbitrary prose as a structured record, or use an LLM to repair malformed content.

### Agent-Managed File Boundary

MarkdownDataStore is designed for records maintained through explicit agent operations. People may inspect or version the Markdown files, but direct manual edits can violate numbering or structured-text expectations and must not be assumed to preserve API invariants.

The utility does not provide transactions across several files, semantic conflict resolution, authorization policy, or automatic prompt injection. The application remains responsible for deciding which records the agent may access and when retrieved sections become model context.
