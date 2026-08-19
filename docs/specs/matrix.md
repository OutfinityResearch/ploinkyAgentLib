# Specification Matrix

| Name | Description |
| --- | --- |
| [DS001-vision](specsLoader.html?spec=DS001-vision.md) | Defines AchillesAgentLib's vision as a composable low-level LLM agent with agentic loops, specialized skill types, agent-managed memory, and file-backed support services. |
| [DS002-architecture](specsLoader.html?spec=DS002-architecture.md) | Defines the architecture that separates application integration, agentic sessions, model access, specialized skill families, and agent-managed persistence. |
| [DS003-main-behavior](specsLoader.html?spec=DS003-main-behavior.md) | Defines the five product behaviors through which applications run requests, use specialized skills, control sessions, reach models, and manage durable project memory. |
| [DS004-coding-style](specsLoader.html?spec=DS004-coding-style.md) | Defines the implementation discipline that keeps runtime modules, portable skill code, model access, tests, generated files, and documentation maintainable together. |
| [DS005-model-strategy](specsLoader.html?spec=DS005-model-strategy.md) | Defines how applications choose models by explicit override or semantic task intent while keeping provider policy outside sessions and skill subsystems. |
| [DS006-main-agent](specsLoader.html?spec=DS006-main-agent.md) | Defines MainAgent as the application-facing coordinator for skill discovery, supervision, reusable prompt sessions, direct skill execution, refresh, and shutdown. |
| [DS007-llm-agent](specsLoader.html?spec=DS007-llm-agent.md) | Defines LLMAgent as the single provider boundary for model calls, contextual prompting, structured interpretation, usage tracking, cancellation, and session creation. |
| [DS008-agentic-sessions](specsLoader.html?spec=DS008-agentic-sessions.md) | Defines the adaptive Loop and plan-first SOP session regimes, their memory, continuation, supervision, tool boundaries, stopping rules, and interruption behavior. |
| [DS009-subsystems](specsLoader.html?spec=DS009-subsystems.md) | Defines how specialized subsystems preserve different skill descriptors, build lifecycles, validators, executors, and remote boundaries behind one MainAgent catalog. |
| [DS010-agentic-knowledge-units](specsLoader.html?spec=DS010-agentic-knowledge-units.md) | Defines AKU as deterministic, agent-managed project memory with validated Knowledge Units, safe persistence, repairable indexes, lexical retrieval, graph scope, and bounded ContextPacks. |
| [DS011-backlog-manager](specsLoader.html?spec=DS011-backlog-manager.md) | Defines BacklogManager as an agent-oriented task record with explicit alternatives, approval, completion history, serialized mutations, and no hidden execution policy. |
| [DS012-markdown-data-store](specsLoader.html?spec=DS012-markdown-data-store.md) | Defines MarkdownDataStore as an agent-oriented, root-bounded Markdown record service with numbered sections, targeted mutations, and predictable structured-text conventions. |
| [DS013-built-in-skills](specsLoader.html?spec=DS013-built-in-skills.md) | Defines the purpose, portable packaging, execution boundaries, and individual contracts of the eight built-in code skills supplied with AchillesAgentLib. |
