---
title: DS010-agentic-knowledge-units
summary: Defines AKU as deterministic, agent-managed project memory with validated Knowledge Units, safe persistence, repairable indexes, lexical retrieval, graph scope, and bounded ContextPacks.
---

## Introduction

[Agentic Knowledge Units](../wiki.html#definition-agentic-knowledge-units) provide durable project memory for applications that need an LLM agent to retain selected evidence, results, files, relationships, and session information beyond one process-local conversation. AKU uses deterministic local records so memory can be inspected, validated, repaired, and retrieved without requiring another model call.

## Core Content

### Knowledge Unit Model

An AKU root must contain independently addressable Knowledge Units and aggregate indexes. A Knowledge Unit must group related project knowledge with its manifest, status, documents, registered files and folders, links, events, runs, results, validations, and ingested session information.

The API must support root and Knowledge Unit initialization, loading, state updates, evidence records, file and folder registration, links, session ingestion, forks, discard, and explicitly confirmed physical deletion. Status changes must affect normal retrieval without silently erasing the underlying record.

### Persistence and Recovery

Every record must be normalized and validated through local schemas before persistence. Mutations must use root-aware path checks, locking, retry behavior where defined, and atomic writes so concurrent or interrupted work does not leave partially written authoritative files.

Aggregate indexes must support both incremental updates and complete rebuilding from authoritative Knowledge Unit records. `doctor()` and optional automatic repair must detect supported inconsistencies and repair derived state without inventing missing documents, relationships, results, or meaning.

The configured AKU root is a hard storage boundary. Paths must remain within that root, existing symlink paths and sensitive locations must be rejected according to the path policy, and AKU must not persist into unrelated project locations.

### Deterministic Search

Search must use deterministic lexical ranking, exact-match boosts, documented filters, and bounded per-Knowledge-Unit diversity. A caller may request explanations of why records ranked, but the explanation must derive from the scoring process rather than a generated model narrative.

Normal retrieval must exclude discarded and obsolete material unless the caller explicitly includes it. Search results must remain reproducible for the same stored records, query, filters, and configuration; AKU does not provide vector embeddings or semantic-model retrieval.

### Scoped ContextPack Construction

ContextPack construction must select and render stored material within a character budget. Scoping may include active, explicitly named, referenced, folder-related, and linked Knowledge Units so an application can provide relevant memory without loading the complete project archive into a prompt.

A ContextPack is prepared context, not an automatic prompt mutation. AKU must return it to the caller, and the caller decides whether, where, and for which request the context is supplied to LLMAgent or an agentic session.

### Agent and Application Responsibility

AKU is designed for records managed by an agent through explicit APIs, while remaining inspectable by people. The structured schemas and indexes exist to make agent mutations bounded and recoverable rather than to turn free-form notes into an implicit source of truth.

The caller owns the meaning, validation, retention decision, and prompt use of stored knowledge. AKU must not decide that a claim is true, invoke an LLM, silently ingest every conversation, or delete physical records without the required confirmation.
