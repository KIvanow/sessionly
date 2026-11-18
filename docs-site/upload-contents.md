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
the latest rewrite measurement. Before a record leaves the machine:

- **Paths are made relative:** to the repository for files inside it, otherwise to the home
  directory (`~/…`). No absolute path under your home directory is sent.
- **The content level is applied** and written into the record's `content` field:

| Level | What is sent |
|---|---|
| `metadata` (default) | Counts, sizes, timings, tool names, statuses, relative file paths, models, tokens, cost, rewrite figures, git user and remote. **No text** from prompts, commands, search patterns, URLs, errors or titles, and no content hashes. |
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

The agent (`source`) and a tool's name are plain text: `claude-code`, `cursor`, `grok` or
`codex`, and whatever the tool is called.

A background upload also asks GitHub, at most once a day, for the address of the newest
release. The request sends no account, machine id, or session; GitHub does see the address
the connection comes from. `sessionly settings --update-check off` stops that. The capture
hooks do not ask, and neither does a machine that is not connected to a server.
