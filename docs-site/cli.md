---
title: Command line
nav_order: 3
has_children: true
---

# Command line

```sh
sessionly watch                  # pretty-print hook events live, in a second terminal
sessionly status                 # hooks installed? how many sessions captured?
sessionly list                   # sessions, newest first, with filters and text search
sessionly summary                # totals per user, repo, model, tool or day
sessionly show <session>         # one session: cost, prompts, files changed, tools, subagents
sessionly transcript <session>   # tokens and cost per model, straight from a transcript
sessionly sync                   # bring the ledger up to date (list, summary and show do this too)
```

`<session>` is a session id or a unique prefix of one. `list`, `summary`, `show` and
`transcript` take `--json`.

- [List, search and summary](sessions.md): finding sessions and adding them up.
- [Rewrite rate](rewrite-rate.md): how much of what the agent wrote is still there.
- [Shell edits](shell-edits.md): what counts when an agent edits with the shell.
- [Past sessions](past-sessions.md): `sessionly import`, for sessions from before the hooks.
- [Cost and transcripts](cost.md): where a session's cost comes from.
- [Command reference](commands.md): every command, option and environment variable.

## Automatic sync

When a turn ends (at most every five minutes; in a cloud sandbox, every time) and when a
session ends, the capture hook starts a background `sessionly` process and returns immediately. That process brings the ledger up to
date (which includes sessions of Cursor, Grok and Codex that the hooks noticed), re-measures
rewrite rates, and uploads if a server is connected. It prints nothing; each
run adds a line to `~/.sessionly/auto.log`, and `sessionly status` shows when the last one
started.

```sh
sessionly settings --auto-sync off   # only sync when you run a command
```

What to know:

- One run at a time: a run that finds another going waits for it, two minutes at most, and
  then leaves it to the next.
- The run after a session's end starts three seconds later, since Claude Code writes its cost
  total as it exits.
- `auto.log` is kept to about 256 KB: past that it becomes `auto.log.old` and a new one is
  begun.
- With auto sync off, the ledger is still brought up to date by `list`, `summary`, `show` and
  `sync`, and uploads happen when you run `sessionly upload`.
