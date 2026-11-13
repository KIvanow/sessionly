# Sessionly

A searchable ledger of AI coding agent sessions: what was asked, which tools ran, which files
changed, and what it cost. Claude Code first, other agents later.

**Status: early.** Steps 1 to 3 of the MVP work: capturing every Claude Code hook event,
reading tokens, cost, models and timing from session transcripts, and normalizing both into one
session record stored in a local SQLite ledger. Rewrite rate, search and team roll-ups come next.

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
it on one project first. Install only changes Sessionly's own hook entries. Your other hooks and
settings stay as they are, and the previous file is kept as `settings.json.sessionly-bak`.
`sessionly uninstall` removes them again.

## Use

```sh
sessionly watch                  # pretty-print hook events live, in a second terminal
sessionly status                 # hooks installed? how many sessions captured?
sessionly sync                   # normalize captured sessions into the ledger
sessionly show <session>         # one session: cost, prompts, files changed, tools, subagents
sessionly transcript <session>   # tokens and cost per model, straight from a transcript
```

`<session>` is a session id or a unique prefix of one. `show` and `transcript` take `--json`.

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
branch). Records are stored in `~/.sessionly/ledger.db` (SQLite). The ledger is derived data:
delete it and `sessionly sync --force` rebuilds it from the raw capture.

The record is the contract between this binary and any server it later uploads to. Its JSON
Schema is [schema/session.schema.json](schema/session.schema.json), generated from the Rust
types by `sessionly schema`; a test fails if the checked-in file is stale.

The record holds metadata, not content:

- **Prompts:** SHA-256, length and the first 200 characters.
- **Tool calls:** tool, status, duration, file path, SHA-256 of the input, size of the output,
  and a one-line summary (the shell command, search pattern or URL, cut to 200 characters).
- **Files:** path, read and write counts, lines added and removed.
- Full prompts, file contents and command output stay in the raw capture.

Only sessions captured by the hooks are in the ledger. File changes made by shell commands
(`sed`, `git apply`, generators) are not attributed to files; only the agent's file tools are.

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

Claude Code records its own cost total in the transcript, but only for the latest run of a
session, and transcripts miss some background API calls. Sessionly combines the two:

- **Earlier runs** (before the last resume): priced from the token counts in the transcript.
- **Latest run**: Claude Code's recorded total, or our estimate if that is higher.
- **No recorded total** (session still running or crashed): estimate only, labelled as such.

Estimates use Anthropic's published API prices in
[`pricing.rs`](crates/sessionly/src/pricing.rs). A model that isn't in the table is left
unpriced and the estimate is labelled partial. They matched Claude Code's own figure to the
cent wherever the transcript was complete. Spend Claude Code recorded but the transcript doesn't
show is reported separately as background calls. Details in
[docs/hook-data.md](docs/hook-data.md#8-the-transcript-transcript_path-observed).

### Raw capture

Every hook event is appended to `~/.sessionly/raw/claude-code/<session_id>.jsonl` (or under
`$SESSIONLY_HOME`). One line looks like:

```json
{"v":1,"source":"claude-code","received_at":"2026-11-13T16:56:07.041299Z","hook":"InstructionsLoaded",
 "session_id":"c4c90c8f-…","payload":{ …the raw payload Claude Code sent… }}
```

Payloads are stored exactly as received. They include full prompts, file contents and command
output, so the files are created readable only by you (0600). Nothing leaves your machine.

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
2–4 ms per call, measured including process spawn. It never prints and always exits 0, so a
capture failure can't block or change your session. Errors go to `_errors.log` next to the data.

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
4. Rewrite-rate heuristic (how much of what the agent wrote survived)
5. CLI: list, show, search
6. Team aggregation, ingest API and dashboard
7. Polish, docs, example data
