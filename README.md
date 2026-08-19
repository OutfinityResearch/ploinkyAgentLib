# AchillesAgentLib

AchillesAgentLib is an ESM library that can be integrated into a Node.js application to add portable skill discovery, direct skill execution, reusable LLM-driven conversations, plan-based orchestration, and deterministic local project memory.

## Overview

MainAgent discovers supported skill descriptors below a workspace directory and delegates each enabled skill to its specialized subsystem. General prompts use one reusable LoopAgentSession; orchestration skills may use Loop or SOP sessions. Every model interaction passes through LLMAgent. AgenticKnowledgeUnits is an explicit local-memory API and is never enabled implicitly.

The package distributes eight internal code skills: `bash`, `edit`, `glob`, `grep`, `mirror-code-generator`, `read`, `webfetch`, and `write`. Internal skills are disabled by default.

## Prerequisites

- Node.js with ESM support.
- Provider credentials and model configuration for workflows that call an LLM.
- A generated router descriptor only for integration tests that explicitly depend on it.

## Installation

~~~bash
npm install ploinky-agent-lib
~~~

For repository development:

~~~bash
npm install
~~~

## Model configuration

LLMAgent uses `LLMConfig.json` by default, and `LLM_MODELS_CONFIG_PATH` may select another file. Supported provider environment variables can supply or override provider and model settings. The integrating application may override semantic tag mappings through the MainAgent `modelConfig` constructor option.

`ACHILLES_DEBUG=true` enables diagnostic logging. `ACHILLES_SKILL_TIMEOUT` controls dynamic-code execution timeout, and `ACHILLES_DBTABLE_TIMEOUT` controls DBTable execution timeout.

## Application integration

~~~js
import { MainAgent } from 'ploinky-agent-lib';

const agent = new MainAgent({
    startDir: process.cwd(),
    disableInternalSkills: false,
    modelConfig: { documentation: 'provider/documentation-model' }
});

const promptResult = await agent.executePrompt('Summarize the public API.');
const readResult = await agent.executeSkill('read', 'file_path: ./package.json');
agent.shutdown();
~~~

The application keeps the MainAgent instance for as long as it needs the conversation. `executePrompt()` creates one LoopAgentSession on the first call and reuses it for later prompts. `executeSkill()` resolves one enabled skill and delegates directly to its subsystem.

AgenticKnowledgeUnits can be imported from the package root when the application needs explicit durable project memory.

## Verification

Run a deterministic component test with `node --test tests/mainAgent/executePrompt.test.mjs`. Run `npm test` after configuring provider credentials and any generated-router descriptor required by integration tests.

## Documentation

Technical documentation starts at [`docs/index.html`](docs/index.html). MainAgent request flow is documented in [`docs/main-agent.html`](docs/main-agent.html), terminology is canonical in [`docs/wiki.html`](docs/wiki.html), and authoritative design contracts are available through [`docs/specsLoader.html?spec=matrix.md`](docs/specsLoader.html?spec=matrix.md).

## License

Licensed under the MIT License. Copyright 2025 Axiologic Research; the work was created as part of the Achilles Research Project.
