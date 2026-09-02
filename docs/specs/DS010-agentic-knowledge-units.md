---
title: DS010-agentic-knowledge-units
summary: Defines AKU as deterministic, agent-managed project memory with validated Knowledge Units, safe persistence, repairable indexes, lexical retrieval, graph scope, and bounded ContextPacks.
---

## Introduction

[Agentic Knowledge Units](../wiki.html#definition-agentic-knowledge-units) provide durable project memory for applications that need an LLM agent to retain selected evidence, results, files, relationships, and session information beyond one process-local conversation. AKU uses deterministic local records so memory can be inspected, validated, repaired, and retrieved without requiring another model call.

## Core Content

### Knowledge Unit Model

An AKU persistence root must contain independently addressable Knowledge Units and aggregate indexes. The configured project root remains separate and bounds ordinary project-file and folder registration. A Knowledge Unit must group related project knowledge with its manifest, status, documents, registered files and folders, links, events, runs, results, validations, and ingested session information.

The API must support root and Knowledge Unit initialization, loading, state updates, evidence records, file and folder registration, links, session ingestion, forks, discard, and explicitly confirmed physical deletion. Status changes must affect normal retrieval without silently erasing the underlying record.

### Persistence and Recovery

Every record must be normalized and validated through local schemas before persistence. Mutations must use root-aware path checks, locking, retry behavior where defined, and atomic writes so concurrent or interrupted work does not leave partially written authoritative files.

Aggregate indexes must support both incremental updates and complete rebuilding from authoritative Knowledge Unit records. `doctor()` and optional automatic repair must detect supported inconsistencies and repair derived state without inventing missing documents, relationships, results, or meaning.

The configured AKU persistence root is a hard storage boundary for records, indexes, locks, pending transactions, and metadata. Paths must remain within that root, and the root must be revalidated before reads, recovery, writes, and destructive operations. A caller-supplied root that is itself a symbolic link, including an explicit alias at the legacy `.aku` location, must be rejected. The owned `pending`, `kus`, root-lock, and per-KU lock paths must reject symbolic links before scanning, reading, writing, or removal. Sensitive locations must be rejected according to the path policy, and AKU must not persist into unrelated project locations. The optional `persistenceRoot` constructor setting must not change the project root used to validate registered project files and folders. Omitting it retains the project-local `.aku` default for unrelated consumers.

The persistence root's canonical location must be captured at construction and shared by storage, atomic writes, and locks. Revalidation must reject replacement of any ancestor that redirects that location, including an ancestor above the shared project/persistence parent when the project is itself inside private storage. Pre-existing canonical aliases above the workspace, such as macOS `/var`, remain supported. Cached instances and transaction callbacks must not bypass the same boundary checks on later I/O.

### Deterministic Search

Search must use deterministic lexical ranking, exact-match boosts, documented filters, and bounded per-Knowledge-Unit diversity. A caller may request explanations of why records ranked, but the explanation must derive from the scoring process rather than a generated model narrative.

Normal retrieval must exclude discarded and obsolete material unless the caller explicitly includes it. Search results must remain reproducible for the same stored records, query, filters, and configuration; AKU does not provide vector embeddings or semantic-model retrieval.

### Scoped ContextPack Construction

ContextPack construction must select and render stored material within a character budget. Scoping may include active, explicitly named, referenced, folder-related, and linked Knowledge Units so an application can provide relevant memory without loading the complete project archive into a prompt.

A ContextPack is prepared context, not an automatic prompt mutation. AKU must return it to the caller, and the caller decides whether, where, and for which request the context is supplied to LLMAgent or an agentic session.

### Agent and Application Responsibility

AKU is designed for records managed by an agent through explicit APIs, while remaining inspectable by people. The structured schemas and indexes exist to make agent mutations bounded and recoverable rather than to turn free-form notes into an implicit source of truth.

The caller owns the meaning, validation, retention decision, and prompt use of stored knowledge. AKU must not decide that a claim is true, invoke an LLM, silently ingest every conversation, or delete physical records without the required confirmation.
