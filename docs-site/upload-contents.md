---
title: What an upload contains
nav_order: 3
parent: Data and privacy
---

# What an upload contains

Nothing is uploaded unless you connect a server (see [Uploading](uploading.md)). You can see
the payload for any session, connected or not:

```sh
sessionly export <session>                     # what would be sent
sessionly export <session> --content previews  # the same, with previews kept
sessionly schema upload                        # its JSON Schema
```

`export` goes by the saved settings. Where `SESSIONLY_CONTENT` or `SESSIONLY_LINE_HASHES` is
set in the environment, as in a [cloud sandbox](cloud-sessions.md), an upload follows those
instead, and `export --content` shows that level.

The payload ([schema/upload.schema.json](https://github.com/KIvanow/sessionly/blob/main/schema/upload.schema.json)) is the session record plus
the latest rewrite measurement, and that measurement as it was 1, 7 and 30 days after the
session ended (`checkpoints`: counts and times, see [Rewrite rate](rewrite-rate.md#at-1-7-and-30-days)).
Before a record leaves the machine:

- **Paths are made relative:** to the repository for files inside it, otherwise to the home
  directory (`~/…`). The working directory and the repository's folder are only shortened to
  `~/…`, so outside the home directory (`/srv/…`, `/workspace`) they are sent as they are. No
  absolute path under your home directory is sent.
- **The content level is applied** and written into the record's `content` field:

| Level | What is sent |
|---|---|
| `metadata` (default) | Counts, sizes, timings, tool names and skill names, statuses, review runs (command, effort, pull request number, where it ran, subagents, cost, findings count), relative file paths, models, tokens, cost (for Claude Code also by branch), rewrite figures, git user, remote and branch, the working directory and repository folder (as `~/…` under the home directory), the agent's version and how it was started, its permission modes, and the paths of the instruction files it loaded (`CLAUDE.md`, rules). **No text** from prompts, commands, search patterns, URLs, errors or titles, and no content hashes. |
| `previews` | The above, plus the 200-character previews and the hashes. A preview can contain anything you typed or ran, including secrets. |

**Line hashes are a separate switch, off by default.** `sessionly settings --line-hashes on`
adds, per changed file and model, a hash of every line the agent added (the first 8 bytes of
the SHA-256 of the line without the whitespace at its ends; blank lines and lines without a
letter or digit are left out). A server needs them to tell which lines of a pull request an
agent wrote (see [Pull requests](pull-requests.md)). A hash does not give the line back, but a
short or common line can be guessed and checked against it, so treat them as you would the
names of the files.

Each installation has a random `machine_id` (in `~/.sessionly/config.json`, created on first
use). A session is identified by machine id, agent and session id, so uploading it again
replaces the earlier copy. The git name and email in a record are a label taken from git
config, not a verified identity. A session that ran in the cloud has the machine id `cloud`,
a `runtime` block, and as its user the person the platform named.

Fields with a fixed set of values are enums in the schema. A reader maps a value it doesn't
know to `unknown`, and ignores fields it doesn't know.

| Field | Values |
|---|---|
| a tool call's `status` | `ok`, `failed`, `interrupted`, `denied`, `rejected`, `no_result`, `unknown` |
| a prompt's `outcome` | `completed`, `api_error`, `unknown` |
| `cost.source` | `recorded`, `recorded_and_estimated`, `estimated`, `partial_estimate`, `unknown` |
| `content` | `metadata`, `previews`; `local` is the record on your machine, which a server refuses |
| `captured_by` | `hooks`, `transcript` |
| `runtime.kind` | `cloud`, `unknown` |
| a review run's `via` | `skill`, `slash_command`, `codex_review`, `unknown` |
| a review run's `ran` | `local`, `cloud`, `unknown` |

The agent (`source`) and a tool's name are plain text: `claude-code`, `cursor`, `grok` or
`codex`, and whatever the tool is called. So is a skill's name (`code-review`, or a plugin's
`plugin:name`), which leaves the machine in every content mode, as an MCP tool's name does: a
team's own skills are named by it. A review run's arguments do not: only the effort and a pull
request number parsed from them are sent, never their text, and never the findings themselves,
nor the reply their number is read from
(see [Review runs](session-record.md#review-runs)).

A background run also asks GitHub, at most once a day, for the address of the newest
release (or asks `SESSIONLY_RELEASE_LATEST`, if that is set). The request carries the binary's
version (as its `User-Agent`) and no account, machine id, or session; GitHub does see the
address the connection comes from. `sessionly settings --update-check off` stops that. The
capture hooks do not ask, and neither does a machine that is not connected to a server or
has automatic sync off.
