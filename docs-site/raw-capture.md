---
title: Raw capture
nav_order: 2
parent: Data and privacy
---

# Raw capture

Every hook event is appended to `~/.sessionly/raw/<tool>/<session_id>.jsonl` (or under
`$SESSIONLY_HOME`), where `<tool>` is the agent that sent it. One line looks like:

```json
{"v":1,"source":"claude-code","received_at":"2026-11-13T16:56:07.041299Z","hook":"InstructionsLoaded",
 "session_id":"c4c90c8f-…","payload":{ …the raw payload Claude Code sent… }}
```

`<tool>` is `claude-code`, `cursor`, `grok`, `codex` or `opencode`, told from what the payload
carries. An event that names no session goes to `_unknown.jsonl` in the same folder. OpenCode's
line is written by its plugin, not by `sessionly capture`: it names the session and nothing
that was typed. The database is the record.

The payload is stored as the agent sent it, re-serialized onto one line. A payload that isn't
valid JSON is kept as text. Beside it a line can have what Sessionly itself noted when the
event arrived: `runtime` in a [cloud session](cloud-sessions.md), and `changes` (or
`changes_skipped`, with the reason) for what a [shell command changed](shell-edits.md). Payloads include full prompts, file contents and command output, so
files and directories are created readable only by you (0600 / 0700). Nothing leaves your
machine. There is no retention limit yet: the raw capture grows until you delete it.

Everything else Sessionly keeps is listed under [Files and settings](files.md).
