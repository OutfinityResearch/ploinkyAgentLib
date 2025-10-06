# ploinky-agent-lib

Utility library for orchestrating LLM-powered agents, skills, and operator workflows. The package exposes the public API from `AgentLib.mjs` and can be consumed from both ESM (`import`) and CommonJS (`require`) projects.

## Installation

```bash
npm install ploinky-agent-lib
```

For local development against the repository:

```bash
npm install
npm run build
```

This creates the bundled outputs in `dist/` that get published with the package.

## Usage

### ESM / TypeScript

```js
import { Agent, doTask, registerLLMAgent } from 'ploinky-agent-lib';
```

### CommonJS

```js
const { Agent, doTask, registerLLMAgent } = require('ploinky-agent-lib');
```

All exports are forwarded from `AgentLib.mjs`, including helpers such as

- `Agent`
- `registerLLMAgent`
- `registerDefaultLLMAgent`
- `doTask`, `doTaskWithReview`, `doTaskWithHumanReview`
- `brainstorm`
- `registerOperator`, `chooseOperator`, `callOperator`
- `cancelTasks`, `listAgents`

## Model & Provider Configuration

The library expects a models configuration file at `models/providers/models.json`. You can override the path via the `LLM_MODELS_CONFIG_PATH` environment variable. Providers may require API keys; check the following environment variables:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `MISTRAL_API_KEY`
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`
- `HUGGINGFACE_API_KEY`

Set `LLMAgentClient_DEBUG=true` to log configuration warnings during startup.

## Development Scripts

- `npm run build` – builds both ESM and CJS bundles with esbuild.
- `npm run build:esm` / `npm run build:cjs` – run individual bundle targets.

Before publishing, run the full build to ensure `dist/` contains the latest artifacts.

## License

MIT
