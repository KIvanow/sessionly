---
title: Command reference
nav_order: 6
parent: Command line
---

# Command reference

Every command of the `sessionly` binary. `sessionly help <command>` prints the same from the
binary itself, and `sessionly --version` the version.

## Setting up

| Command | |
|---|---|
| `sessionly install` | Add the capture hooks to `~/.claude/settings.json`, and to Codex's `hooks.json` where `~/.codex` exists. See [Install](install.md). |
| `sessionly install --project DIR` | Add them to `DIR/.claude/settings.json` instead. |
| `sessionly install --repo [DIR]` | Write the script and hook entries a repository carries for [cloud sessions](cloud-sessions.md), in `DIR` or here. `--checksums FILE` reads the release's `SHA256SUMS` from a file. |
| `sessionly uninstall` | Remove the hooks again. Takes `--project DIR` and `--repo [DIR]` like `install`. |
| `sessionly status` | Whether the hooks are installed, how much is captured, and what is set. When a newer release has been seen, it says so. Takes `--project DIR` and `--repo [DIR]`. |
| `sessionly update` | Move to the newest release. `--check` only says whether there is one; `--version VERSION` names one. See [Install](install.md#updating). |

## Looking at sessions

| Command | |
|---|---|
| `sessionly list` | Sessions, newest first. Filters, and `--limit N` (`-n`, default 30); `--json`. See [List, search and summary](sessions.md). |
| `sessionly summary` | Totals. The same filters, and `--by user` (default), `repo`, `model`, `tool` or `day`; `--json`. |
| `sessionly show <session>` | One session; `--json`. |
| `sessionly transcript <session>` | Tokens and cost per model, read from Claude Code's transcript. Takes a session or a path to a transcript file; `--json`. See [Cost and transcripts](cost.md). |
| `sessionly watch` | Print hook events as they arrive. |
| `sessionly sync` | Bring the ledger up to date. `--force` rebuilds every session, not only those that changed. See [The session record](session-record.md). |
| `sessionly import [SESSION…]` | Bring in sessions the agents still have files for: all of them, or those whose id starts with what is given. `--tool TOOL` (`claude-code`, `cursor`, `grok` or `codex`; may be given more than once) keeps to an agent. See [Past sessions](past-sessions.md). |

The filters of `list` and `summary`: `--repo`, `--user`, `--model`, `--tool`, `--file`,
`--search` (`-s`), `--since`, `--until` and `--min-cost`.

## A server

| Command | |
|---|---|
| `sessionly connect <URL>` | Save a server's address and a token for it. `--token TOKEN` gives the token (or `SESSIONLY_TOKEN`; otherwise it is asked for), `--content metadata\|previews` sets what is sent, `--no-check` saves without asking the server. See [Uploading](uploading.md). |
| `sessionly disconnect` | Stop uploading and forget the token. |
| `sessionly upload` | Send new and changed sessions now. `--dry-run` only counts them. |
| `sessionly exclude [REPO]` | Stop submitting a repository and delete what you already sent from it. With nothing after it, list the repositories you stopped. |
| `sessionly include <REPO>` | Submit a repository again. |
| `sessionly export <session>` | Print what would be uploaded for a session. `--content metadata\|previews` shows that level. See [What an upload contains](upload-contents.md). |
| `sessionly schema [session\|upload]` | Print the JSON Schema of the session record (the default) or of an upload. |
| `sessionly license status`, `sessionly license install <FILE>` | The license of the connected server. See [Editions and license](editions.md). |

## Settings

`sessionly settings` shows what is set. With an option it changes one, in
`~/.sessionly/config.json`:

| Option | Default | |
|---|---|---|
| `--auto-sync on\|off` | `on` | Whether the hooks bring the ledger up to date and upload by themselves. See [Automatic sync](cli.md#automatic-sync). |
| `--content metadata\|previews` | `metadata` | What an upload contains. See [What an upload contains](upload-contents.md). |
| `--line-hashes on\|off` | `off` | Whether an upload has a hash of each line the agent added, which [pull request](pull-requests.md) figures need. |
| `--shell-edits sure\|all\|off` | `sure` | How much of what shell commands change is counted as the agent's. See [Shell edits](shell-edits.md). |
| `--update-check on\|off` | `on` | Whether a background upload asks once a day if a newer release is out. `status` says when one is, and so do `list` and `summary` in a terminal. See [Install](install.md#updating). |

## What the hooks run

These are run by the agents, not by you:

| Command | |
|---|---|
| `sessionly capture` | What every hook runs: it reads one event and stores it. It never prints and always exits 0, whatever follows it. See [Raw capture](raw-capture.md). |
| `sessionly auto` | The [automatic sync](cli.md#automatic-sync), which `capture` starts in the background. |
| `sessionly turn start`, `sessionly turn end` | What `.sessionly/hook.sh codex start` and `end` run in a [Codex cloud task](codex-cloud-tasks.md). Anywhere else they do nothing. |

## Environment variables

| Variable | |
|---|---|
| `SESSIONLY_HOME` | Where Sessionly keeps its files, in place of `~/.sessionly`. See [Files and settings](files.md). |
| `SESSIONLY_TOKEN` | The token for `connect`. With `SESSIONLY_URL`, a server to upload to where none is saved. |
| `SESSIONLY_URL` | With `SESSIONLY_TOKEN`, the server to upload to where none is saved. Not written to the settings. |
| `SESSIONLY_CONTENT` | `metadata` or `previews`: what uploads contain, in place of the saved setting. |
| `SESSIONLY_LINE_HASHES` | `on` or `off`: whether uploads have line hashes, in place of the saved setting. |
| `SESSIONLY_NO_AUTO` | Set to anything, the hooks start no automatic sync. |
| `SESSIONLY_RELEASE_BASE` | Where `update` and `install --repo` download releases from, in place of this project's GitHub releases. |
| `SESSIONLY_RELEASE_LATEST` | Where `update`, and the daily check, ask for the newest version. |
| `SSL_CERT_FILE` | A file of root certificates (PEM) to trust for the server, in place of the built-in ones. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's transcripts are looked for (`projects/` under it), in place of `~/.claude`. The hooks are written to `~/.claude/settings.json` all the same. |
| `CODEX_HOME` | Codex's folder, in place of `~/.codex`: its sessions and its `hooks.json`. |
| `GROK_HOME` | Grok's folder, in place of `~/.grok`. |

The four that name a server and what is sent to it are meant for a
[cloud environment](cloud-sessions.md), and are followed by `upload`, `exclude`, `include` and
the automatic sync. `export`, `status` and `settings` show the saved settings.
