# Sessionly

A searchable ledger of AI coding agent sessions: what was asked, which tools ran, which files
changed, and what it cost. For Claude Code, Cursor and Grok, side by side.

**Status: early, but working end to end.** The local binary captures every Claude Code hook
event, reads tokens and cost from transcripts, normalizes both into one session record in a
local SQLite ledger, measures how much of each session's changes survive, and lists, searches
and summarizes sessions from the command line. Sessions from Cursor and Grok are read from the
files those agents keep (see [Cursor and Grok](#cursor-and-grok)). It can upload to a server,
which shows the same figures for a whole team in a web dashboard. Sessions that run in the
cloud (Claude Code's cloud sessions, Cursor's cloud agents) are captured through hooks a
repository carries (see [Cloud sessions](#cloud-sessions)). Not done yet: sign-in other than
tokens.

## How it fits together

```
Claude Code ──hooks────────┐
Cursor, Grok ──their files─┼─▶ sessionly (local Rust binary) ──▶ ~/.sessionly/   (raw + normalized sessions)
cloud agents ──hooks a ────┘             │
               repository carries        │
                                         │
                                         └──upload──▶ Sessionly server, hosted or self-hosted (TypeScript)
                                                               └─ team dashboard
```

- **Local binary (Rust, `crates/sessionly`).** Captures hook events, parses transcripts,
  normalizes sessions, keeps the local ledger and, later, uploads to a server. All parsing and
  redaction happens on the developer's machine, or for a cloud session in its sandbox.
- **Server and dashboard (TypeScript, `apps/server` and `apps/web`).** Receives normalized
  sessions, aggregates them per team, and serves the manager view. The same code runs hosted or
  self-hosted.

## Install

Each [release](https://github.com/KIvanow/sessionly/releases) has a binary for Linux (x86_64
and arm64, statically linked) and macOS (Apple silicon and Intel), as
`sessionly-<target>.tar.gz`, with their SHA-256 checksums in `SHA256SUMS`. Unpack one and put
`sessionly` on your `PATH`. Or build it, which needs Rust 1.89 or later:

```sh
cargo install --path crates/sessionly   # or: cargo build --release
```

Then:

```sh
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
sessionly summary                # totals per user, repo, model, tool or day
sessionly show <session>         # one session: cost, prompts, files changed, tools, subagents
sessionly transcript <session>   # tokens and cost per model, straight from a transcript
sessionly sync                   # bring the ledger up to date (list, summary and show do this too)
```

`<session>` is a session id or a unique prefix of one. Every command above takes `--json`.

### List and search

```
$ sessionly list
ID        TOOL         STARTED (UTC)      ACTIVE      COST  FILES         LINES  REWRITTEN  REPO      PROMPT
2b02c8f5  Claude Code  2026-11-13 18:29      14s     $0.17      2        +24 -0        1/2  e2e2      Do these steps in order, one tool call each: 1. Write a …
8b1e867c  Claude Code  2026-11-13 18:29       7s     $0.15      0         +0 -0          -  e2e2      Do these steps in order, one tool call each: 1. Write a …
6c6a61b0  Claude Code  2026-11-13 18:10      15s     $0.29      1         +1 -0        0/1  e2e2      Do these steps in order, one tool call each, and keep go…
```

A cost shown with `~` is an estimate, or includes one. Filters combine, and text filters match
substrings ignoring case:

| Option | Keeps sessions |
|---|---|
| `--repo TEXT` | in a repository whose remote or path contains TEXT |
| `--user TEXT` | by a user whose git name or email contains TEXT |
| `--model TEXT` | that used a model containing TEXT, e.g. `opus` |
| `--tool TOOL` | from one agent: `claude-code`, `cursor` or `grok` |
| `--file TEXT` | that read or changed a file whose path contains TEXT |
| `--search TEXT`, `-s` | with TEXT in a prompt, title, shell command, search pattern or file path |
| `--since WHEN`, `--until WHEN` | started in that range: a date (`2026-11-01`), an RFC 3339 time, or an age (`7d`, `12h`, `2w`) |
| `--min-cost USD` | that cost at least that much |
| `--limit N`, `-n` | only the newest N (default 30) |

Search covers the 200-character previews in the session record, not full prompts or output.

### Summary

`sessionly summary` takes the same filters and groups with `--by user` (default), `repo`,
`model`, `tool` or `day`:

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
- Only changes made through the agent's file tools are tracked, not edits made by shell
  commands. A [session in the cloud](#cloud-sessions) is the exception.
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
capture has been deleted. An agent that was opened and closed again, with nothing asked and no
tool run, is not a session and is left out. A session is rebuilt when its capture, its transcript or a subagent transcript
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

- Sessions from before the hooks were installed are not in the ledger until you run
  `sessionly import` (see [Past sessions](#past-sessions)).
- If the hooks were installed partway through a session and it hasn't been imported, its record
  says so (`captured_from_start: false`): prompts, tools and files cover the captured part, cost
  covers the whole session.
- File changes made by shell commands (`sed`, `git apply`, generators) are not attributed to
  files; only the agent's file tools are. A [session in the cloud](#cloud-sessions) is the
  exception: there what each shell command changed is counted too.
- User name and email come from git config at sync time. They are a label, not verified identity.

### Cloud sessions

A Claude Code cloud session or a Cursor cloud agent runs in a sandbox the platform starts, with
a fresh clone of the repository. Nothing from your home directory is there, so the hooks that
`sessionly install` writes are not there either. Both platforms do run the hooks a repository
carries, so that is where capture for them goes:

```sh
sessionly install --repo          # in the repository's root; --repo DIR for another one
git add .sessionly .claude/settings.json .cursor/hooks.json
git commit -m "Capture cloud agent sessions"
```

That writes three files, and only adds to the two that may already exist:

- **`.sessionly/hook.sh`**, a script. On a person's own machine it does nothing: sessions there
  are captured by that person's own `sessionly install`, if they have one. In a sandbox it
  fetches the sessionly binary of the version that wrote the script, once per sandbox, checks
  it against the SHA-256 checksum written into the script, and hands it the event. It prints
  nothing and always exits 0.
- **Entries in `.claude/settings.json`** (for Claude Code) **and `.cursor/hooks.json`** (for
  Cursor) that run the script.

Where a sandbox sends its sessions is not in the repository. It is given to the cloud
environment, as secrets:

| Variable | Meaning |
|---|---|
| `SESSIONLY_URL`, `SESSIONLY_TOKEN` | The server and a token for it. Use a token with the `env` role (see [Server](#server)). Without these the session is captured inside the sandbox and sent nowhere. |
| `SESSIONLY_LINE_HASHES=on` | Optional. Send line hashes, which [pull request](#pull-requests) figures need. |
| `SESSIONLY_CONTENT=previews` | Optional. Send previews instead of metadata only. |

Claude Code's cloud sessions reach only the hosts on the environment's allowed list, so add
the server's host there. Cursor's cloud agents can reach it as they are.

What is different about a session from the cloud:

- **Who.** Git in a sandbox is set up as the agent (`Claude <noreply@anthropic.com>`,
  `Cursor Agent <cursoragent@cursor.com>`), so the person is the one the platform names:
  Claude Code in the sandbox's environment, Cursor through a socket it serves there.
  `sessionly show` says `Ran in  the cloud`, with the platform's own id for the session and
  what started it.
- **One machine.** A sandbox is new each time, so every sandbox uploads as the machine `cloud`,
  and a session that moves to another sandbox stays one session.
- **Every turn is sent.** The ledger is brought up to date and uploaded each time a turn ends,
  not at most every five minutes: a sandbox may be gone soon after.
- **The branch** is the one checked out in the sandbox, which is the one the agent pushes.
- **Shell commands count.** In a sandbox an agent often edits with the shell (`sed -i`, a
  heredoc) instead of its file tools, and a shell command tells hooks nothing of what it
  changed. So the working tree is compared just before and just after each shell command,
  and what differs is the command's: the files it changed, created or deleted, and the lines.
  They count toward the session's files and lines, the rewrite rate and pull requests like
  any other edit. The comparison uses git with an index and objects kept in `~/.sessionly`;
  the repository's own index, objects and HEAD are not written. Files git ignores are not
  looked at, and new files over 1 MB are left out. Agents run tools side by side: a file a
  file tool changes while a command runs is that tool's, and is not counted a second time
  as the command's. A command that moves to commits it did
  not make (`git pull`, `git checkout main`, a rebase) is not counted, since what that
  brings in is other people's work. A command that carries on in the background is counted
  up to when the call returned. This is not done on a person's machine: whatever the person
  saved while a command ran would be put down to the agent.
- **Cursor's first prompt may be missing.** A Cursor cloud agent does not always run hooks
  for the prompt it was started with (of two runs on 2026-11-14, one did and one did not).
  Its tool calls are still captured: the turn is recorded with its prompt unknown, and the
  session says it was not captured from its start. Later prompts in the same agent arrive.
- **Cursor has no cost.** A Cursor cloud agent keeps no transcript and does not tell hooks how
  many tokens a turn used, so its session has prompts, tool calls with their outcome and
  duration, files and lines changed, and the model, but no tokens and no cost.

What to know:

- The first hook in a fresh sandbox waits for the download (a few seconds, once). If the
  download fails or does not match its checksum, nothing is captured, the reason is in
  `~/.sessionly/bootstrap.log` in the sandbox, and it is tried again ten minutes later.
- The rewrite rate is measured while the sandbox exists. After that, what survived shows
  only through [pull requests](#pull-requests).
- If a session outlives its sandbox, the next one captures only what happens from then on.
  For Claude Code the rest is read from the transcript when the platform brings it along.
  For Cursor it is not there, and the server keeps the fuller copy it already has.
- Claude Code does not load a repository's hooks in sessions over several repositories, or
  in ones started from Slack (its documentation, not tried here).
- `sessionly status --repo` shows what is installed, `sessionly uninstall --repo` removes it,
  and running `install --repo` with a newer sessionly updates the script.
- The script downloads from this project's GitHub releases. To use a copy of your own, set
  `SESSIONLY_RELEASE_BASE` when running `install --repo`; `--checksums FILE` reads the
  release's `SHA256SUMS` from a file instead of downloading it.

The platforms' side of this was checked with one real session on each (2026-11-14): which
hooks fire and from which files, what they carry, where the person and the session id are
to be found, and what a sandbox can reach.

### Past sessions

```sh
sessionly import                 # every session Claude Code, Cursor and Grok still have files for
sessionly import 2b02c8f5        # only sessions whose id starts with this
sessionly import --tool cursor   # only one agent's
```

`import` rebuilds a session's activity from Claude Code's transcript: prompts, tool calls with
their outcome, files changed with line counts, subagents, and the lines needed for the rewrite
rate. Cost and tokens come from the transcript as usual. On one machine it turned 2.5 GB of
transcripts (100 sessions) into 99 MB in about a minute.

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

### Cursor and Grok

Sessions from Cursor and from Grok's terminal agent sit in the same ledger, under the same
record, so `list`, `summary`, `show`, the rewrite rate, uploads and the dashboard treat them
like any other session. `sessionly list --tool grok` and `sessionly summary --by tool` tell
them apart:

```
$ sessionly summary --by tool
TOOL         SESSIONS       COST    ACTIVE  PROMPTS  TOOLS (FAILED)  FILES           LINES      REWRITTEN  LINES KEPT
Claude Code       100   $5099.96  169h 48m     1830     40635 (774)    910    +77733 -5448  378/903 (42%)         60%
Grok                3      $6.51    2h 32m       15         572 (9)     26     +6324 -1066     9/26 (35%)         48%
Cursor             30      $0.89       26s      371        5324 (0)    183     +7498 -1431   28/178 (16%)         91%
```

Both are read from the files the agent itself keeps, by `sessionly import`. The agents' tools
are mapped to common names (Read, Edit, Write, Bash, Grep, Glob) so a row means the same thing
whichever agent produced it. Sign-in files of either agent are never opened.

Both agents also run the hooks in `~/.claude/settings.json`, so after `sessionly install` their
sessions are noticed as they happen and brought in at the next sync without running `import`.
Claude Code does not have to be installed for that: `sessionly install` writes the file either
way, and both agents read it. Checked with Grok 1.0.77 and the Cursor editor 3.27, each run from
an empty home directory with `claude` off the `PATH`.

Cursor here means the editor. Its command-line agent (`cursor-agent`) keeps its chats in a
different format and did not run the hooks when tried (build 2025.11.06), so its sessions are
not in the ledger.

| | Read from | Has | Does not have |
|---|---|---|---|
| **Grok** | `~/.grok/sessions/<directory>/<session>/` | prompts, tool calls with their outcome, files and lines changed, times, model, tokens, and Grok's own cost figure | subagents; permission prompts (a call that was not allowed counts as failed) |
| **Cursor** | `~/.cursor/projects/<project>/agent-transcripts/`, plus the hook capture | prompts and the minute each was sent, tool calls with their input, files and lines changed, subagents. For turns the hooks saw: exact times, how long each tool call took and whether it failed, the model, and tokens | anything but prompts, tool calls and files for turns that ran before the hooks were installed; Cursor's own cost figure |

What Cursor's transcripts leave out, it tells the hooks: when a prompt was sent and its turn
ended, the model, and the tokens the turn used. A turn the hooks saw is paired with its prompt
in the transcript (same text, same minute) and gets those.

Cursor writes a session's transcript when a turn ends. While the first turn is still running,
or if the editor was closed before it ended, the session is built from the hooks alone: it has
its prompts, tool calls and times, but the lines an edit changed are counted only once the
transcript is there.

So for a Cursor session:

- **Cost is an estimate, and only for the turns the hooks saw.** It is those turns' tokens at
  API list prices, which is a measure of the work done, not what Cursor bills. `show` says how
  many prompts it covers (`covers 1 of 13 prompts`). A session the hooks saw none of has no
  cost, and adds nothing to totals; a model without a known price is left out the same way.
- **Active time** counts only those turns too.
- **Tokens are per turn**, not per request, so a model's request count is its number of turns.
- For turns from before the hooks, every tool call counts as succeeded and there is no model.

A Cursor session's repository is worked out from the project folder's name, which Cursor
derives from the path; if that directory no longer exists the session has no repository.

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

**Line hashes are a separate switch, off by default.** `sessionly settings --line-hashes on`
adds, per changed file and model, a hash of every line the agent added (the first 8 bytes of
the SHA-256 of the line without the whitespace at its ends; blank lines and lines without a
letter or digit are left out). A server needs them to tell which lines of a pull request an
agent wrote (see [Pull requests](#pull-requests)). A hash does not give the line back, but a
short or common line can be guessed and checked against it, so treat them as you would the
names of the files.

Each installation has a random `machine_id` (in `~/.sessionly/config.json`, created on first
use). A session is identified by machine id, agent and session id, so uploading it again
replaces the earlier copy. The git name and email in a record are a label taken from git
config, not a verified identity. A session that ran in the cloud has the machine id `cloud`,
a `runtime` block, and as its user the person the platform named.

Fields with a fixed set of values (`status`, `outcome`, `cost.source`, `content`,
`captured_by`) are enums in the schema. A reader maps a value it doesn't know to `unknown`, and
ignores fields it doesn't know.

### Uploading

The binary uploads to a Sessionly server (see [Server](#server)). It uses two endpoints, both
with `Authorization: Bearer <token>`:

- `GET /api/v1/ping` answers 2xx if the token is accepted.
- `PUT /api/v1/sessions/{machine_id}/{source}/{session_id}` stores or replaces one session. The
  body is the payload described under [What an upload contains](#what-an-upload-contains).

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

When a turn ends (at most every five minutes; in a cloud sandbox, every time) and when a
session ends, the capture hook starts a background `sessionly` process and returns immediately. That process brings the ledger up to
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
total is therefore a lower bound.

### Raw capture

Every hook event is appended to `~/.sessionly/raw/<tool>/<session_id>.jsonl` (or under
`$SESSIONLY_HOME`), where `<tool>` is the agent that sent it. One line looks like:

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
PreModelSwitch) are left out on purpose.

### Hook overhead

The capture hook runs on every event, and tool calls fire two or three events each, so it has to
be fast. `sessionly capture` is a native binary that appends one line under a file lock: about
2–4 ms per call, measured including process spawn (about 20 ms for a 2 MB payload). It never
prints and always exits 0, whatever its input or arguments, so a capture failure can't block or
change your session. If another capture holds the file for more than 1.5 seconds it writes
anyway instead of waiting. Errors go to `_errors.log` next to the data.

## Server

The server receives uploads and serves the dashboard. Both are TypeScript: `apps/server` (Hono,
Postgres) and `apps/web` (React).

```sh
pnpm install
pnpm build      # builds the dashboard; the server then serves it
SESSIONLY_ADMIN_TOKEN=choose-a-long-secret SESSIONLY_ADMIN_EMAIL=you@example.com pnpm server
```

Settings can also be kept in a file named `.env` at the top of the repository, one
`NAME=value` a line; `pnpm server` reads it, and git ignores it.

That starts it on `http://127.0.0.1:8080` with an embedded database in `apps/server/data`, which
is enough to try it or for a small team. Open that address and sign in with the token. Set `DATABASE_URL=postgres://…` to use a Postgres
server. Then, on a developer's machine:

```sh
sessionly connect http://127.0.0.1:8080   # paste the token, or pass it with --token
sessionly upload
```

With Docker, the server and Postgres together:

```sh
SESSIONLY_ADMIN_TOKEN=choose-a-long-secret docker compose up -d
```

Put it behind HTTPS before anyone outside the machine uses it: the binary refuses plain `http://`
for anything but localhost.

| Setting | Meaning |
|---|---|
| `PORT`, `HOST` | Where to listen. Default `127.0.0.1:8080`; use `HOST=0.0.0.0` in a container. |
| `DATABASE_URL` | `postgres://…` (Postgres 16 or later), or unset for the embedded database (in `apps/server/data`; in the Docker image, `/data`). |
| `SESSIONLY_DB_POOL` | Postgres only: connections kept at most. Default 10. |
| `SESSIONLY_DB_QUERY_SECONDS` | Postgres only: how long a statement may take. Default 30, and a day (86400) at most. |
| `SESSIONLY_ADMIN_TOKEN` | An admin token that always works, for first use. |
| `SESSIONLY_ADMIN_EMAIL` | Who uploads made with that token belong to. |
| `SESSIONLY_PUBLIC_URL` | Where people reach the dashboard, e.g. `https://sessionly.example.com`. Needed for signing in with Google or GitHub, which send people back there; open the dashboard at exactly this address. (A server on your own machine sends a browser at `127.0.0.1` on to `localhost`, or the other way; behind a proxy it sends nobody anywhere, whatever `Host` the proxy passes on.) Google takes a plain `http://` address only for `localhost`, `127.0.0.1` and `[::1]`. |
| `SESSIONLY_GOOGLE_CLIENT_ID`, `SESSIONLY_GOOGLE_CLIENT_SECRET` | Optional, both together: people then sign in with Google (see below). From an OAuth client of type "Web application" in Google Cloud, whose redirect URI is the public address followed by `/api/v1/auth/google/callback`. |
| `SESSIONLY_GITHUB_CLIENT_ID`, `SESSIONLY_GITHUB_CLIENT_SECRET` | Optional, both together: people then sign in with GitHub. From an OAuth app on GitHub, whose callback URL is the public address followed by `/api/v1/auth/github/callback`. |
| `SESSIONLY_HOSTED` | `true` for a service many organisations sign up to. See [`infra/`](infra/README.md). |

**The database's user.** On Postgres, requests run as a second role that cannot log in, which
the server makes at its first start; its name comes from the database's name. If the
database's user may not create roles (the one a managed database's panel makes usually may
not), the server stops and prints one statement for the database's admin to run. It asks
again if the database is later renamed, or restored under another name, because the role
goes with the name. Running the statement twice is harmless.

Upgrading a server from before organisations: it now needs Postgres 16 or later, and a
database user who may not create roles needs that statement run once, or the server does not
start (it says which). When restoring a dump into another database, use `pg_restore
--no-acl`: the grants in the dump are to the role of the old name, and the server makes its
own at the next start. A role of an old name that is left in the cluster holds nothing in
this database any more and can be dropped.

**A database that goes quiet.** After a failover the old connections can stay open and
answer nothing. A statement that passes the limit is ended by the database, and a
connection that has not answered a fifth of the limit later is thrown away and replaced,
so the server finds the new database by itself, within the limit and that fifth. Bringing
the database up to date at a start is not limited. The two settings are whole numbers in
plain digits; anything else is said at the start and left out. There is no way to have no
limit: a number above a day is taken as a day, and said.

**People and tokens.** Each token belongs to one person and is `member`, `admin`, `ci` or
`env`. Uploads are filed under the token's owner, whatever name the record carries. A member
sees their own sessions; an admin sees everyone's. A `ci` token is for the GitHub Action: it can
report pull requests and nothing else. An `env` token is for a cloud agent's environment (see
[Cloud sessions](#cloud-sessions)): it can upload sessions and nothing else, and a cloud session
it uploads is filed under the person the platform says started it, since several people start
sessions in one environment. Whoever holds it can therefore upload a session in anyone's name,
so give it only to those environments. An admin creates and revokes tokens through
`POST /api/v1/tokens`, `GET /api/v1/tokens` and `DELETE /api/v1/tokens/{id}`, or from the command
line with `pnpm token create --email ann@example.com` (with the embedded database, stop the
server first). Only a hash of each token is stored.

**Signing in with Google or GitHub.** With the settings above for either (with Docker
Compose, put them in a `.env` file beside `docker-compose.yml`, which passes them on), an
admin adds
people by their email address on the Team page (`POST /api/v1/users`), and each signs in with
an account that has that address: a Google account's address, or any address GitHub has
verified for a GitHub account. Nothing is sent to anyone, and no password is kept: what is
asked of Google or GitHub is which account this is and which addresses are its. Signing in
lasts a week. The first time someone signs in to an organisation, they are shown which one
it is and who added them, and asked; the account they sign in with then is from that time on
the only one that gets in as them there, whoever else comes to have the address. If that
account is gone, another admin lets them in with a new one from the Team page (for the
owner, an admin who has signed in, not one with a token); for an owner with no other admin,
`pnpm person forget-account --email owner@example.com` does (with the embedded database,
stop the server first). People then make the tokens for their own machines on the Connect page
(`POST /api/v1/me/tokens`), and removing a person ends their sign-in and every token of
theirs. Without those settings there are only tokens, as above.

**Organisations.** Every token, session and pull request belongs to an organisation, and a
request sees only its own organisation's: each query names it, and in Postgres row-level
security enforces it underneath. A server you host for your team has one, `default`, and you
never see the word. A hosted service has one per sign-up: [`infra/`](infra/README.md) is how
to run one.

### Dashboard

Sign in with a token, or with Google or GitHub where the server is set up for them. An admin
sees the whole team; a member sees their own sessions.

- **Overview:** total cost, sessions, active time, prompts, tool calls and failure rate, files
  changed, the share of files rewritten since and of agent lines still there; cost per day (per
  week for long ranges, with a table view); and the same totals by tool, person, repository and
  model. A repository's row names the agents and models that worked in it, and opens to compare
  those agents within it and to list the files they changed: which agents touched each file,
  sessions, lines added and removed, how many of the agents' lines are still there, and when it
  was last changed.
- **Sessions:** a searchable, paged list. Period, person, repository, tool and model filters
  apply to both pages; a session counts under its most used model. Once a session from the
  cloud has been uploaded, a further filter separates those from sessions on people's machines.
- **One session:** cost and tokens per model, prompts with how long each took and how it ended,
  files changed with how much of each survives, tools, and subagents.
- **Team** (admins): add and remove people where they sign in with Google or GitHub, and create and
  revoke tokens for what cannot sign in: a cloud environment, CI, or a machine set up for
  someone.
- **Connect:** a token of your own for each of your machines, with the commands to run.

What it shows depends on what was uploaded. With the default `metadata` level there is no text:
sessions are listed by id and prompts show only their length. Sessions uploaded with `previews`
show titles and the first 200 characters of each prompt.

While working on the dashboard, `pnpm dev` runs it with live reload and passes API calls to a
server on port 8080.

### Pull requests

How much of a pull request did coding agents write, with which models, and how did those lines
fare in review? The [GitHub Action](action/) reports each pull request to the server when it is
opened, pushed to, reviewed and closed; the server matches the lines it adds against the lines
agents added in uploaded sessions. No source code leaves GitHub or anyone's machine: both sides
send hashes.

```yaml
# .github/workflows/sessionly.yml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, closed]
  pull_request_review:
    types: [submitted]
jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}   # a token with the ci role
```

It needs three things: that workflow, a `ci` token (Team page) saved as a secret, and
`sessionly settings --line-hashes on` on the machines whose sessions should count.

The **Pull requests** page (admins) then shows, for the period and repository chosen:

- per pull request: lines added, how many an agent wrote and with which tool and model, how
  many of the agent's lines survived review, review rounds, and review comments by people and
  by bots (CodeRabbit and the like);
- **by model**: the same summed, so you can see whose lines get through review as written and
  whose take several rounds.

How to read it:

- **A line is an agent's** when a session added that line to that file, the session is by
  someone who committed to the pull request (the email git is set up with is the one commits
  carry), and it started at most 90 days before the pull request was opened. A session that
  ran in the cloud counts when it ran on the pull request's branch instead: there the commits
  are the agent's own. Everything else
  counts as not an agent's: people without Sessionly, sessions uploaded without line hashes,
  changes made by shell commands on a person's machine, generated files. So the agent share
  is a floor.
- **Survived review** compares the pull request as it was opened with how it ended: of the
  agent's lines it had at the start, how many are still in it. It is only known for pull
  requests the Action saw being opened (or could reconstruct, see `backfill` below). A line
  that was reformatted counts as changed.
- **A review round** is review feedback (a review that comments or asks for changes, or a
  comment on the diff, from anyone but the author) followed by a new commit.
- **A cloud agent's pull request** is recognised by who made its commits and what its branch
  is called. If no session was captured for it, the page says so next to it: its lines then
  count as not an agent's, which is wrong in a way worth knowing about.
  [`sessionly install --repo`](#cloud-sessions) in the repository fixes it for later ones.
- **By model is a description, not a ranking.** Harder work goes to stronger models, a pull
  request with two models counts under both, and a handful of pull requests says little.
- The model is known per line for Claude Code, and for Cursor turns the hooks saw; otherwise
  the session's main model stands in, or it is shown as not known.

The Action writes the figures to the run's summary page. It comments on the pull request only
if you set `comment: true` (and give it `pull-requests: write`); a badge on every pull request
changes how people feel about being measured, so that is yours to switch on. Other inputs:
`ignore` (files to leave out; lock files by default), `other-names` (names the repository's
clones may still have as their origin after a rename or transfer), `backfill` (for a pull
request from before the Action was added, first report it as it was when opened, worked out
from its commits) and `pr-number` (to report one from a manually started workflow). See
[action/README.md](action/README.md).

**API behind it:** `PUT /api/v1/prs` (the Action's report; `ci` or `admin`), `GET /api/v1/prs`
and `GET /api/v1/prs/summary` (admins; filters `repo`, `state`, `since`). For sessions:
`GET /api/v1/summary?by=user|repo|model|tool|day|runtime`, `GET /api/v1/sessions`
(filters `user`, `repo`, `model`, `model_is`, `tool`, `runtime` (`local` or `cloud`), `q`,
`since`, `until`, paging `limit`, `offset`),
`GET /api/v1/sessions/{machine_id}/{source}/{session_id}`, `GET /api/v1/files` (files agents
changed, with `repo_is` for one repository) and `GET /api/v1/filters`.

The payload types in `packages/schema` are generated from `schema/upload.schema.json`, which is
generated from the Rust types. `pnpm gen` regenerates them and a test fails if they are stale.

Checked with the real binary and one machine's history, against both the embedded database and
Postgres in Docker: 100 sessions uploaded in under three seconds, a repeat upload sent nothing,
and the server's totals equal the local `sessionly summary` exactly.

## Editions and license

Everything outside `ee/` is Apache-2.0 (`LICENSE`): the `sessionly` binary (capture, ledger,
rewrite rate, command line, upload), the server and the dashboard. It never needs a license key.

`ee/` (`LICENSE-EE`) holds the Business and Enterprise features. So far there is one: a content
policy, where the organisation sets what uploads from its engineers should contain. Run the ee
server in place of the core one (`pnpm --filter @sessionly/ee start`, or the
`docker-compose.ee.yml` overlay) and install a license:

```sh
sessionly license install acme.license   # needs an admin token
sessionly license status
```

Licenses are Ed25519-signed files checked offline (no phone-home). After a license expires its
features keep working for 14 days, then turn read-only. The core never stops. See
[ee/README.md](ee/README.md).

Contributions use DCO sign-off (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md).

## Develop

```sh
cargo test
cargo clippy --all-targets
pnpm typecheck && pnpm test   # the TypeScript side and the GitHub Action
scripts/dummy-session.sh   # runs a short real Claude Code session that exercises most hooks
```

The website ([sessionly.dev](https://sessionly.dev)) is the static pages in [`website/`](website/):
no build step and no JavaScript, and the two typefaces (Space Grotesk and IBM Plex Mono, both
under the SIL Open Font License) are served from `website/fonts/`. `python3 -m http.server -d website` previews it (pages are at
`/privacy.html` and so on locally; the host serves them without the extension, as
`website/vercel.json` says). After changing the DPA, `scripts/website-dpa-pdf.sh` regenerates
`website/dpa.pdf`.

## Roadmap (MVP)

1. ✅ Hook capture → raw JSONL
2. ✅ Transcript parser: tokens, cost, model, timestamps
3. ✅ Normalized session schema and local storage
4. ✅ Rewrite rate (how much of what the agent wrote survived)
5. ✅ CLI: list, show, search
6. ✅ Aggregation on one machine (`summary`), upload, server and team dashboard
7. ✅ Cursor and Grok sessions beside Claude Code's
8. ✅ Pull requests: how much agents wrote, with which models, and how it fared in review
9. ✅ Sessions in the cloud: Claude Code's cloud sessions and Cursor's cloud agents
10. ✅ Organisations, signing in with Google or GitHub, and a hosted mode anyone can sign up to
11. Plans and billing for the hosted service; deleting and exporting an organisation's data
12. Polish, docs, example data
