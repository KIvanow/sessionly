---
title: Files and settings
nav_order: 4
parent: Data and privacy
---

# Files and settings

Everything the `sessionly` binary keeps is in one folder: `~/.sessionly`, or `$SESSIONLY_HOME`.
Files and folders there are created readable only by you (0600 and 0700).

| Path | What |
|---|---|
| `config.json` | The settings: this machine's id, the server and its token, what uploads contain, and the `sessionly settings` switches. |
| `raw/<tool>/<session_id>.jsonl` | Every hook event as it arrived. See [Raw capture](raw-capture.md). |
| `raw/_errors.log` | What went wrong in a capture, which never shows in the agent. |
| `imported/<tool>/<session>.jsonl` | Sessions rebuilt by `sessionly import`. See [Past sessions](past-sessions.md). |
| `transcript-facts/<tool>/<session>.json` | Cost, usage, models and branch kept from a transcript, which the agent may delete. |
| `ledger.db` | The ledger (SQLite): one record a session. See [The session record](session-record.md). |
| `snapshots/<session>/` | The comparison of the working tree around shell commands, while a session runs. See [Shell edits](shell-edits.md). |
| `auto.log`, `auto.log.old` | A line for each [automatic sync](cli.md#automatic-sync). |
| `auto.stamp`, `auto.lock` | When the last automatic sync started, and that one is running. |
| `update-check.json` | When a newer release was last asked for, and which version it was. See [Install](install.md#updating). |
| `turns/` | In a Codex cloud task: the turn that is open. |
| `bin/`, `bootstrap.log` | In a cloud sandbox: the binary the repository's script downloaded, and what it noted. See [Cloud sessions](cloud-sessions.md). |

## What can be deleted

- **`ledger.db` is derived.** Delete it and `sessionly sync --force` rebuilds it from the raw
  capture, the imported sessions and the saved transcript facts.
- **`raw/`, `imported/` and `transcript-facts/` are the source.** A session whose files there
  are deleted is gone from the ledger at the next `sync --force`. Nothing removes them by
  itself: there is no retention limit yet.
- **`config.json` holds the machine's id and the token.** Without it the machine gets a new
  id, and sessions uploaded again are new sessions to the server, beside the old ones.

## Outside that folder

- `~/.claude/settings.json` and, where there is one, `~/.codex/hooks.json`: the hook entries
  `sessionly install` adds, with the file as it was before kept beside it as
  `settings.json.sessionly-bak` or `hooks.json.sessionly-bak`. See [Install](install.md).
- `~/.config/opencode/plugins/sessionly.js` (or under `$XDG_CONFIG_HOME`), where that config
  directory exists: the OpenCode plugin. Install writes that file and does not edit
  `opencode.json`. Uninstall removes the file.
- In a repository set up for cloud sessions: `.sessionly/hook.sh`, entries in
  `.claude/settings.json` and `.cursor/hooks.json`, and a section of `AGENTS.md`.
- The agents' own files are read and never written: `~/.claude/projects`, `~/.cursor/projects`,
  `~/.grok`, `~/.codex` and OpenCode's `opencode.db`.
