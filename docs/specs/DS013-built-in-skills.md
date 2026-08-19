---
title: DS013-built-in-skills
summary: Defines the purpose, portable packaging, execution boundaries, and individual contracts of the eight built-in code skills supplied with AchillesAgentLib.
---

## Introduction

AchillesAgentLib supplies a small built-in toolbox so its foundational agent can inspect and modify a workspace, run commands, fetch external text, and generate skill-local code without requiring every application to recreate those primitives. The `bash`, `edit`, `glob`, `grep`, `mirror-code-generator`, `read`, `webfetch`, and `write` folders are portable built-in [code skills](../wiki.html#definition-code-skill), not privileged shortcuts around the normal skill lifecycle.

## Core Content

### Shared Built-in Skill Contract

Each built-in skill folder must keep its `cskill.md` descriptor, examples where present, executable ESM below its local `src/` directory, and any local generation specifications needed to reproduce the implementation. Copying the folder must preserve the skill's complete runtime contract without depending on an unrelated root `src/` tree.

MainAgent must exclude built-in skills by default and expose them only when package-internal skills are enabled. CodeSkillsSubsystem must parse their descriptors and invoke their actions through the same catalog, enabled-state, supervision, and execution path used for other code skills.

Each skill must operate only within the command, file, directory, pattern, or URL boundary supplied by its caller. Host process permissions, application supervision, sandbox policy, network availability, and remote-system behavior remain external constraints; being built in must not grant a skill additional authority.

A change to an input, output, side effect, error boundary, or portability requirement must update the local descriptor, implementation, tests, corresponding HTML documentation, and the applicable chapter of this specification together.

### bash

The `bash` skill provides the agent with an explicit command-execution primitive for work that existing higher-level skills do not cover. Its descriptor must require a Bash command and may accept a millisecond timeout. The action must run in the current working directory and return captured standard output, standard error, non-zero exit information, and timeout state.

The skill executes with host process permissions and may produce any side effect allowed to that process. The application's supervisor, sandbox, command policy, and working-directory choice remain authoritative; the skill must not claim that a command is safe merely because it was selected by the model.

### edit

The `edit` skill provides a narrow mutation primitive for changing known text without asking a model to regenerate an entire file. Its descriptor must require a file path, old string, and new string and may enable replacement of every occurrence. The action must report the updated path after a successful replacement.

The match must be exact. The skill must not parse programming-language syntax, guess a similar fragment, or broaden the replacement scope when the requested text is absent or ambiguous.

### glob

The `glob` skill lets the agent locate candidate files before choosing what to read or modify. Its descriptor must accept one glob pattern as its complete prompt input. The action must return a JSON array of absolute matching paths sorted by descending modification time.

The skill discovers paths only. It must not read matching file content, infer which result is semantically relevant, or expand its search beyond the supplied pattern.

### grep

The `grep` skill lets the agent search workspace content without loading every candidate file into model context. Its descriptor must support a bounded path, file glob, output mode, case behavior, line numbers, context, multiline matching, and result limits. The action must return paths, matching content, or counts according to the selected mode.

The caller-selected path is a hard search boundary. Result limits and output modes must remain effective even when many files match so the tool does not silently produce unbounded context.

### mirror-code-generator

The `mirror-code-generator` skill turns a target skill's local Markdown specifications into matching ESM source while keeping the generated implementation beside its contract. Its descriptor must accept a skill directory, discover only Markdown files in the optional local specifications folder, and map generated files below that skill's `src/` directory.

Generation must use LLMAgent, syntax-check each output, and attempt repair only within a bounded retry policy. When repeated repair fails, the action must restore the prior file rather than leave invalid generated source. After successful generation, it must preserve the specification backup required by the workflow.

### read

The `read` skill gives the agent bounded access to the contents of one selected file. Its descriptor must require a file path and may accept a one-based text offset and line limit. Text results must contain numbered lines, while binary results must use base64 content.

The skill reports file content only. It must not interpret the file's application meaning, follow unrelated references, or select a different file when the requested target is missing.

### webfetch

The `webfetch` skill lets the agent obtain textual information from a caller-selected URL. Its descriptor must require the URL and an extraction or summary prompt. The action must return plain text and convert HTML responses into text suitable for model context.

Network availability, redirects, authentication, remote content, response size, and server behavior remain external dependencies. The skill must not treat fetched content as trusted instructions or guarantee the correctness of information returned by the remote source.

### write

The `write` skill provides an explicit whole-file creation and replacement primitive. Its descriptor must require a file path and complete content, and the action must create missing parent directories, write exactly the supplied content, and report the written character count.

The caller-selected file is the complete mutation boundary. The skill must not merge with existing content, infer an alternate location, or preserve unspecified old sections; callers that need targeted replacement must use `edit` or another structured store.
