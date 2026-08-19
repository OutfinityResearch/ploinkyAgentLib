---
title: DS004-coding-style
summary: Defines the implementation discipline that keeps runtime modules, portable skill code, model access, tests, generated files, and documentation maintainable together.
---

## Introduction

AchillesAgentLib combines a reusable agent runtime with independently portable skill folders. Its coding rules must therefore protect both package-wide consistency and the ability to copy, build, test, and regenerate a skill without depending on an unrelated root implementation tree. This specification is the canonical source for those rules.

## Core Content

### Language and Module Contract

Source, tests, comments, specifications, and documentation must use English. Runtime code must use ESM, repository-relative imports, and explicit errors at public boundaries. Public exports must be declared in the nearest `index.mjs` and repeated at the package root only when they belong to the package-wide API.

Established runtime modules must use four-space indentation. A legacy module that consistently uses two spaces may retain that local convention until a substantive refactor changes the module; unrelated work must not create formatting-only churn.

### Ownership and Portable Skill Layout

Each module must have one reviewable responsibility and remain near the component that owns it. Portable skill descriptors, examples, source, and local specifications must remain inside `skills/<name>/`. Shared code required by a copied skill must travel with that skill; it must not be moved into a root `src/` tree that the copied folder cannot use.

Files ending in `.generated.mjs` are build products. They must be changed through their source Markdown or specification and regenerated, never edited as the authoritative source.

### LLM and Runtime Configuration Boundary

All LLM interactions must use [LLMAgent](../wiki.html#definition-llm-agent). A subsystem, utility, or session must not call a provider directly because doing so would bypass shared model selection, cancellation, counters, response handling, and application overrides.

Runtime configuration must allow explicit caller-supplied model mappings in addition to environment and file defaults. Routing-sensitive work should use semantic task tags for areas such as documentation, specification, orchestration, bootstrap, and testing rather than embedding provider-specific choices in component code.

### Reviewable Size and Text Flow

New or substantially changed runtime files should remain below 500 code lines where practical. Executable code should remain below 120 characters per line unless an identifier, URL, generated artifact, or data literal makes the limit materially less clear. `fileSizesCheck.sh` is the repository check for these limits.

Markdown and HTML prose must remain one logical source line per paragraph, list item, or caption. Documentation layout must let prose use the full width of its own container and wrap in the renderer, so file-size and line-length checks must exclude intentionally unwrapped documentation prose.

### Tests and Documentation Synchronization

Tests must mirror component ownership under `tests/`. Deterministic component tests must run with `node --test <test-file>`. Provider-dependent integration tests belong in `npm test` and must make their credential, external-service, or generated-descriptor prerequisites explicit.

A behavior change must test its public result, relevant boundary failure, and state transition. When behavior, interfaces, architecture, workflows, or constraints change, the affected HTML documentation and DS contract must change in the same work so source and documentation do not define different products.
