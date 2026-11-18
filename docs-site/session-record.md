---
title: The session record
nav_order: 1
parent: Data and privacy
---

# The session record

`sessionly sync` builds one record per session from two sources: the captured hook events
(prompts, tool calls, files, subagents, errors) and the transcript (tokens, cost, models, git
branch). Records are stored in `~/.sessionly/ledger.db` (SQLite).

Claude Code deletes old transcripts, so after each read Sessionly saves what it needs from one
(cost, usage, models, branch) under `~/.sessionly/transcript-facts/`. The ledger itself is
derived data: delete it and `sessionly sync --force` rebuilds it from the raw capture and those
saved facts. A normal sync never removes a session; `--force` also drops sessions whose raw
capture has been deleted. (The one exception: the thread of a Codex subagent that was first
taken for a session of its own goes once it is part of the session that started it.) An agent
that was opened and closed again, with nothing asked, no tool run and no cost, is not a
session and is left out. A session is rebuilt when its capture, its transcript or a subagent
transcript grows, or when Sessionly or its price table changes.

The record is the contract between this binary and any server it later uploads to. Its JSON
Schema is [schema/session.schema.json](https://github.com/KIvanow/sessionly/blob/main/schema/session.schema.json), generated from the Rust
types by `sessionly schema`; a test fails if the checked-in file is stale.

## What the record holds

The record holds metadata and short previews, not full content:

- **Prompts:** SHA-256, length and the first 200 characters.
- **Tool calls:** tool, status, duration, file path, SHA-256 of the input, size of the output,
  and a one-line summary (the shell command, search pattern or URL, cut to 200 characters).
  A failed call also keeps the first 200 characters of its error, which for a shell command is
  the start of its output (for a command of Codex's, the end of it).
- **Files:** absolute path, read and write counts, lines added and removed.
- Full prompts, file contents and successful command output stay in the raw capture.

The previews and paths are still sensitive: a command can contain a token, a path contains a
user name. The local record keeps them; what may leave the machine is decided separately (see
[What an upload contains](upload-contents.md)).

## Limits to know about

- Sessions from before the hooks were installed are not in the ledger until you run
  `sessionly import` (see [Past sessions](past-sessions.md)).
- If the hooks were installed partway through a session and it hasn't been imported, its record
  says so (`captured_from_start: false`): prompts, tools and files cover the captured part, cost
  covers the whole session.
- Files count as changed through the agent's file tools when the call succeeded. A session's
  count of failed tool calls has those that failed, not those that were interrupted, denied
  or declined.
- File changes made by shell commands (`sed`, `git apply`, generators) are attributed as far
  as they are sure to be the agent's; a long command's are mostly not (see
  [Shell edits](shell-edits.md)). In a [session in the cloud](cloud-sessions.md) all of what
  each shell command changed is counted.
- User name and email come from git config at sync time. They are a label, not verified identity.
