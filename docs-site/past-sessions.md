---
title: Past sessions
nav_order: 4
parent: Command line
---

# Past sessions

```sh
sessionly import                 # every session Claude Code, Cursor, Grok and Codex still have files for
sessionly import 2b02c8f5        # only sessions whose id starts with this
sessionly import --tool cursor   # only one agent's; give --tool again for another
```

`import` rebuilds a session's activity from Claude Code's transcript: prompts, tool calls with
their outcome, files changed with line counts, subagents, and the lines needed for the rewrite
rate. Cost and tokens come from the transcript as usual. On one machine it turned 2.5 GB of
transcripts (100 sessions) into 99 MB in about a minute.

- Each agent's files are read from where it keeps them: `~/.claude/projects` (or
  `$CLAUDE_CONFIG_DIR/projects`), `~/.cursor/projects`, `~/.grok` (or `$GROK_HOME`) and
  `~/.codex` (or `$CODEX_HOME`). What is read of Cursor, Grok and Codex is under
  [Cursor and Grok](cursor-and-grok.md) and [Codex](codex.md).
- The result is saved under `~/.sessionly/imported/`, so an imported session survives its
  transcript being deleted. Tool output is not copied, only its size.
- An imported session is marked `captured_by: transcript`. If a session also has a hook capture
  that saw it from the start, the hook capture is used; a capture that began partway gives way
  to the import.
- A session that was imported is re-imported automatically when its transcript grows, and once
  after an upgrade that reads more from the same files. Nothing is imported for the first time
  unless you run the command.
- A transcript doesn't record permission prompts that were approved (so `permission requests`
  is 0), or when the session ended. It does record prompts the user declined, which a hook
  capture can't see: those tool calls show as `rejected`.
- Run on the same sessions, an import and a hook capture agreed on prompts, tool calls, failures,
  subagents, files and lines changed, and cost.
