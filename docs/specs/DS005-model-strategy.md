---
title: DS005-model-strategy
summary: Defines how applications choose models by explicit override or semantic task intent while keeping provider policy outside sessions and skill subsystems.
---

## Introduction

Different agent tasks need different balances of latency, cost, reasoning depth, and provider capability. AchillesAgentLib must carry that intent through one model strategy without letting each session or skill subsystem hard-code a provider. The integrating application remains the authority that maps task intent to concrete models.

## Core Content

### Central Model Selection Boundary

All LLM work must pass through [LLMAgent](../wiki.html#definition-llm-agent). An explicit model supplied for a call must take priority over semantic tag selection. When a caller supplies `modelConfig`, LLMAgent must treat that mapping as the application-controlled override; otherwise it may construct defaults from runtime configuration.

No subsystem may reinterpret the resolved choice as its own provider policy. MainAgent, agentic sessions, and skill executors must preserve the selected model, tags, mappings, and reasoning effort until LLMAgent performs the provider invocation.

### Configuration Sources and Precedence

Runtime model and provider configuration may come from `LLMConfig.json`, the location named by `LLM_MODELS_CONFIG_PATH`, supported environment variables, or caller-supplied configuration. Environment-backed provider and model values may override file values according to the configuration loader, while an explicit call-level model remains the highest-priority routing instruction.

Credentials must never be embedded in source, descriptors, or documentation examples. The configuration system may identify providers and model names, but secret acquisition and rotation remain outside the library.

### Semantic Tags and Tiers

[Model tags](../wiki.html#definition-model-tag) must express the work being performed, not a vendor name. Applications should define mappings for recurring categories such as documentation, specification, orchestration, bootstrap, and testing, and may map those categories to fast, balanced, or deep model tiers.

A tag communicates intent but does not guarantee a concrete model when no caller mapping or provider-catalog match exists. The model strategy must preserve this limitation explicitly rather than silently promising a tier that the application has not configured.

### Reasoning Effort and Provider Limits

Reasoning effort may be configured when LLMAgent is constructed and overridden for a call or session turn. The resolved value must reach the selected provider adapter together with the model request. If the provider does not support the requested option, behavior remains bounded by that adapter's contract.

Provider availability, pricing, rate limits, context limits, and model-specific capabilities are external constraints. AchillesAgentLib coordinates selection and propagation; it does not guarantee that an external provider will accept or complete a request.
