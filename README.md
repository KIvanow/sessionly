# Sessionly

A searchable ledger of AI coding agent sessions: what was asked, which tools ran, which files
changed, and what it cost. Claude Code first, other agents later.

**Status: early.** The local half of the MVP works: capturing every Claude Code hook event,
reading tokens and cost from transcripts, normalizing both into one session record in a local
SQLite ledger, measuring how much of each session's changes survive, and listing, searching and
summarizing sessions from the command line. The server and team dashboard come next.

## How it fits together

```
Claude Code ──hooks──▶ sessionly (local Rust binary) ──▶ ~/.sessionly/   (raw + normalized sessions)
                                     │
                                     └──upload (later)──▶ Sessionly cloud or self-hosted server (TypeScript)
                                                           └─ team dashboard
```

- **Local binary (Rust, `crates/sessionly`).** Captures hook events, parses transcripts,
  normalizes sessions, keeps the local ledger and, later, uploads to a server. All parsing and
  redaction happens on the developer's machine.
- **Server and dashboard (TypeScript, planned).** Receives normalized sessions, aggregates them
  per team, and serves the manager view. The same code runs as the hosted service or self-hosted.

## Install

Requires Rust 1.89 or later.

```sh
cargo install --path crates/sessionly   # or: cargo build --release
sessionly install                        # adds hooks to ~/.claude/settings.json
sessionly status
```

`sessionly install --project DIR` writes to `DIR/.claude/settings.json` instead, so you can try
it on one project first. The hook command contains the absolute path of the binary, so don't
commit a settings file that has it.

What install does to the settings file:

- It adds or removes only hook entries whose command is exactly `<path>/sessionly capture`.
  Other hooks and settings, key order, file permissions and a symlinked location are kept.
- The file is rewritten as JSON with two-space indentation. Comments are not supported; a file
  that isn't valid JSON is left untouched and install stops with an error.
- The file as it was before Sessionly's first change is saved next to it as
  `settings.json.sessionly-bak` and never overwritten.
- `sessionly uninstall` removes the entries again. Running either command twice changes nothing.

## Use

```sh
sessionly watch                  # pretty-print hook events live, in a second terminal
sessionly status                 # hooks installed? how many sessions captured?
sessionly list                   # sessions, newest first, with filters and text search
sessionly summary                # totals per user, repo, model or day
sessionly show <session>         # one session: cost, prompts, files changed, tools, subagents
sessionly transcript <session>   # tokens and cost per model, straight from a transcript
sessionly sync                   # bring the ledger up to date (list, summary and show do this too)
```

`<session>` is a session id or a unique prefix of one. Every command above takes `--json`.

### List and search

```
$ sessionly list
ID        STARTED (UTC)      ACTIVE      COST  FILES         LINES  REWRITTEN  REPO      PROMPT
2b02c8f5  2026-11-13 18:29      14s     $0.17      2        +24 -0        1/2  e2e2      Do these steps in order, one tool call each: 1. Write a new …
8b1e867c  2026-11-13 18:29       7s     $0.15      0         +0 -0          -  e2e2      Do these steps in order, one tool call each: 1. Write a new …
6c6a61b0  2026-11-13 18:10      15s     $0.29      1         +1 -0        0/1  e2e2      Do these steps in order, one tool call each, and keep going …
```

A cost shown with `~` is an estimate, or includes one. Filters combine, and text filters match
substrings ignoring case:

| Option | Keeps sessions |
|---|---|
| `--repo TEXT` | in a repository whose remote or path contains TEXT |
| `--user TEXT` | by a user whose git name or email contains TEXT |
| `--model TEXT` | that used a model containing TEXT, e.g. `opus` |
| `--file TEXT` | that read or changed a file whose path contains TEXT |
| `--search TEXT`, `-s` | with TEXT in a prompt, title, shell command, search pattern or file path |
| `--since WHEN`, `--until WHEN` | started in that range: a date (`2026-11-01`), an RFC 3339 time, or an age (`7d`, `12h`, `2w`) |
| `--min-cost USD` | that cost at least that much |
| `--limit N`, `-n` | only the newest N (default 30) |

Search covers the 200-character previews in the session record, not full prompts or output.

### Summary

`sessionly summary` takes the same filters and groups with `--by user` (default), `repo`,
`model` or `day`:

```
$ sessionly summary --since 7d
USER                SESSIONS       COST    ACTIVE  PROMPTS  TOOLS (FAILED)  FILES   LINES      REWRITTEN  LINES KEPT
k.ivanow@gmail.com         3      $0.60       37s        3          11 (1)      3  +25 -0      1/3 (33%)         24%
---------------------------------------------------------------------------------------------------------------------
total                      3      $0.60       37s        3          11 (1)      3  +25 -0      1/3 (33%)         24%
```

A session counts under its most used model. With one machine this is one user's view; the same
grouping is what the team dashboard will show once sessions are uploaded.

### Rewrite rate

How much of what the agent wrote is still there later. For each file a session changed,
Sessionly keeps the lines the agent added (as hashes) and, on every sync, counts how many are
still in the file on disk.

- **REWRITTEN `1/2`:** one of the two changed files has kept less than half of the agent's lines.
  A deleted file counts as rewritten.
- **LINES KEPT:** the share of the agent's added lines that still exist.

`sessionly show` gives it per file:

```
Rewrite    1 of 2 changed files rewritten since; 19% of 16 added lines still there (measured 2026-11-13 18:30 on master)

Files changed
     +23     -0  kept 13%   calc.py  (new)
      +1     -0  kept 100%  README.md
```

What it does and doesn't mean:

- A line matches by content anywhere in the file, ignoring leading and trailing whitespace, so
  moved or re-indented code counts as kept.
- Blank lines and lines with no letter or digit (`}`, `);`) are not tracked. That is why the
  count of added lines here is lower than under LINES.
- Lines the agent removed again in the same session are not counted against it.
- The comparison is with whatever is checked out when the measurement runs. `show` says which
  branch that was, and warns if it differs from the session's branch.
- A session that just ended scores 100%. The number only becomes meaningful with time, so read
  it together with the session's age.
- It measures survival, not quality or cause: code can be rewritten for reasons that have
  nothing to do with how it was written.
- Only changes made through the agent's file tools are tracked, not edits made by shell commands.
- If the session's directory no longer exists, the last measurement is kept.

```
$ sessionly show 8d89
Session    8d893de5-59ac-4cc7-a3fe-57f4e342b8a9
User       Kristiyan Ivanov, k.ivanow@gmail.com
Repo       /tmp/e2e (master)
Time       2026-11-13 17:39:42Z → 17:40:08Z (25s elapsed, 21s active)
Models     claude-opus-5-5
Cost       $0.31 (recorded)
Activity   1 prompts, 7 tool calls (1 failed), 1 subagents, 2 permission requests
Files      1 changed (+1 -0), 1 read

Prompts
  17:39:45  Do these steps in order, one tool call each, and keep going if a step fails: 1. Write a…

Files changed
      +1     -0  README.md

Tools
      2  Bash  (1 without a successful result)
      2  Write  (2 without a successful result)
      1  Agent
      1  Edit
      1  Read

Subagents
  ad8b2722  general-purpose    1 tool calls     $0.11  Echo hello from subagent
```

A repository with an `origin` remote is shown as `host/owner/repo`.

### The session record

`sessionly sync` builds one record per session from two sources: the captured hook events
(prompts, tool calls, files, subagents, errors) and the transcript (tokens, cost, models, git
branch). Records are stored in `~/.sessionly/ledger.db` (SQLite).

Claude Code deletes old transcripts, so after each read Sessionly saves what it needs from one
(cost, usage, models, branch) under `~/.sessionly/transcript-facts/`. The ledger itself is
derived data: delete it and `sessionly sync --force` rebuilds it from the raw capture and those
saved facts. A normal sync never removes a session; `--force` also drops sessions whose raw
capture has been deleted. A session is rebuilt when its capture, its transcript or a subagent transcript
grows, or when Sessionly or its price table changes.

The record is the contract between this binary and any server it later uploads to. Its JSON
Schema is [schema/session.schema.json](schema/session.schema.json), generated from the Rust
types by `sessionly schema`; a test fails if the checked-in file is stale.

The record holds metadata and short previews, not full content:

- **Prompts:** SHA-256, length and the first 200 characters.
- **Tool calls:** tool, status, duration, file path, SHA-256 of the input, size of the output,
  and a one-line summary (the shell command, search pattern or URL, cut to 200 characters).
  A failed call also keeps the first 200 characters of its error, which for a shell command is
  the start of its output.
- **Files:** absolute path, read and write counts, lines added and removed.
- Full prompts, file contents and successful command output stay in the raw capture.

The previews and paths are still sensitive: a command can contain a token, a path contains a
user name. The local record keeps them; what may leave the machine is decided separately (see
[What an upload contains](#what-an-upload-contains)).

Limits to know about:

- Only sessions captured by the hooks are in the ledger.
- If the hooks were installed partway through a session, its record says so
  (`captured_from_start: false`): prompts, tools and files cover the captured part, cost covers
  the whole session.
- File changes made by shell commands (`sed`, `git apply`, generators) are not attributed to
  files; only the agent's file tools are.
- User name and email come from git config at sync time. They are a label, not verified identity.

### What an upload contains

Nothing is uploaded unless you connect a server (see [Uploading](#uploading)). You can see
the payload for any session, connected or not:

```sh
sessionly export <session>                     # exactly what would be sent
sessionly export <session> --content previews  # the same, with previews kept
sessionly schema upload                        # its JSON Schema
```

The payload ([schema/upload.schema.json](schema/upload.schema.json)) is the session record plus
the latest rewrite measurement. Before a record leaves the machine:

- **Paths are made relative:** to the repository for files inside it, otherwise to the home
  directory (`~/…`). No absolute path under your home directory is sent.
- **The content level is applied** and written into the record's `content` field:

| Level | What is sent |
|---|---|
| `metadata` (default) | Counts, sizes, timings, tool names, statuses, relative file paths, models, tokens, cost, rewrite figures, git user and remote. **No text** from prompts, commands, search patterns, URLs, errors or titles, and no content hashes. |
| `previews` | The above, plus the 200-character previews and the hashes. A preview can contain anything you typed or ran, including secrets. |

Each installation has a random `machine_id` (in `~/.sessionly/config.json`, created on first
use). A session is identified by machine id, agent and session id, so uploading it again
replaces the earlier copy. The git name and email in a record are a label taken from git
config, not a verified identity.

Fields with a fixed set of values (`status`, `outcome`, `cost.source`, `content`,
`captured_by`) are enums in the schema. A reader maps a value it doesn't know to `unknown`, and
ignores fields it doesn't know.

### Uploading

The server and dashboard in this repository are not built yet. The binary's side is, against
the small API in [docs/api.md](docs/api.md):

```sh
sessionly connect https://sessionly.example.com   # asks for the token, checks it, saves both
sessionly upload                                   # send new and changed sessions now
sessionly upload --dry-run                         # only count what would be sent
sessionly settings --content previews              # opt in to sending previews
sessionly disconnect                               # stop uploading, forget the token
```

- The token can also come from `--token` or the `SESSIONLY_TOKEN` environment variable. It is
  stored in `~/.sessionly/config.json`, readable only by you, and never printed.
- Plain `http://` is accepted only for a server on this machine.
- A session is sent again only when its payload changed. Failed uploads are retried on the next
  run.

### Automatic sync

When a turn ends (at most every five minutes) and when a session ends, the capture hook starts a
background `sessionly` process and returns immediately. That process brings the ledger up to
date, re-measures rewrite rates, and uploads if a server is connected. It prints nothing; each
run adds a line to `~/.sessionly/auto.log`, and `sessionly status` shows when the last one
started.

```sh
sessionly settings --auto-sync off   # only sync when you run a command
```

### Transcripts

`sessionly transcript` reads Claude Code's transcript directly. It also accepts a path to a
transcript file, and works for any past session, including ones from before Sessionly was
installed:

```
Session    5233c02a-28f3-4e87-9fc8-d43379292252
Time       2026-11-13 13:00:05Z → 13:00:28Z (22s)
Context    branch HEAD, Claude Code 2.1.302, via sdk-cli
Cost       $0.20 (recorded by Claude Code)

Main thread
  model                   reqs     input    output  cache read cache write  est. cost
  claude-opus-5-5            6        12       630      130.7K       12.8K      $0.14

Subagent aab436e5 (general-purpose): Echo hello from subagent
  model                   reqs     input    output  cache read cache write  est. cost
  claude-opus-5-5            2         4       106       24.5K       11.3K      $0.06
```

### How cost is calculated

Claude Code records its own cost total in the transcript, but only for one run of a session
(from the last start or resume until the total was last written). Sessionly combines that with
its own estimate from the token counts:

- **Inside the recorded run:** Claude Code's total, or our estimate if that is higher.
- **Before or after it** (earlier runs of a resumed session, or activity since the total was
  written): our estimate.
- **No recorded total** (session still running, or it crashed): estimate only, labelled as such.

Estimates use Anthropic's published API prices in
[`pricing.rs`](crates/sessionly/src/pricing.rs). Each API response is counted once, with its
final token counts. Requests to a model that isn't in the price table are left out and counted
in `unpriced_requests`, so an incomplete total is visible as such.

How close is it? On one machine with 97 transcripts, the estimate for a recorded run equalled
Claude Code's total to the cent in about a third of the sessions and was lower in most of the
rest: 23% of recorded spend ($536 of $2,359) does not appear in any transcript. We report that
share as `untracked_usd` and have not yet identified what it is. An estimate without a recorded
total is therefore a lower bound. Details in
[docs/hook-data.md](docs/hook-data.md#8-the-transcript-transcript_path-observed).

### Raw capture

Every hook event is appended to `~/.sessionly/raw/claude-code/<session_id>.jsonl` (or under
`$SESSIONLY_HOME`). One line looks like:

```json
{"v":1,"source":"claude-code","received_at":"2026-11-13T16:56:07.041299Z","hook":"InstructionsLoaded",
 "session_id":"c4c90c8f-…","payload":{ …the raw payload Claude Code sent… }}
```

The payload is stored as Claude Code sent it, re-serialized onto one line. A payload that isn't
valid JSON is kept as text. Payloads include full prompts, file contents and command output, so
files and directories are created readable only by you (0600 / 0700). Nothing leaves your
machine. There is no retention limit yet: the raw capture grows until you delete it.

### Captured events

`sessionly install` registers 20 observe-only events: SessionStart, SessionEnd,
UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, PermissionDenied, Stop, StopFailure, Notification, SubagentStart,
SubagentStop, PreCompact, PostCompact, PostModelSwitch, TaskCreated, TaskCompleted and
InstructionsLoaded.

Events that change Claude Code's behaviour when hooked (WorktreeCreate, WorktreeRemove,
PreModelSwitch) are left out on purpose. [docs/hook-data.md](docs/hook-data.md) covers every
event, its payload, and why it is or isn't useful.

### Hook overhead

The capture hook runs on every event, and tool calls fire two or three events each, so it has to
be fast. `sessionly capture` is a native binary that appends one line under a file lock: about
2–4 ms per call, measured including process spawn (about 20 ms for a 2 MB payload). It never
prints and always exits 0, whatever its input or arguments, so a capture failure can't block or
change your session. If another capture holds the file for more than 1.5 seconds it writes
anyway instead of waiting. Errors go to `_errors.log` next to the data.

## Develop

```sh
cargo test
cargo clippy --all-targets
scripts/dummy-session.sh   # runs a short real Claude Code session that exercises most hooks
```

## Roadmap (MVP)

1. ✅ Hook capture → raw JSONL
2. ✅ Transcript parser: tokens, cost, model, timestamps
3. ✅ Normalized session schema and local storage
4. ✅ Rewrite rate (how much of what the agent wrote survived)
5. ✅ CLI: list, show, search
6. ✅ Aggregation on one machine (`summary`); next: upload, ingest API and team dashboard
7. Polish, docs, example data
