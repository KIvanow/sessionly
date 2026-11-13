# Sessionly

A searchable ledger of AI coding agent sessions: what was asked, which tools ran, which files
changed, and what it cost. Claude Code first, other agents later.

**Status: early.** Step 1 of the MVP works: capturing every Claude Code hook event into a local
ledger. Transcript parsing (cost, tokens, model), normalized sessions, search and team roll-ups
come next. See [CHANGELOG.md](CHANGELOG.md).

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
sessionly watch      # pretty-print hook events live, in a second terminal
sessionly status     # hooks installed? how many sessions captured?
```

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
2. Transcript parser: tokens, cost, model, timestamps
3. Normalized session schema and local storage
4. Rewrite-rate heuristic (how much of what the agent wrote survived)
5. CLI: list, show, search
6. Team aggregation, ingest API and dashboard
7. Polish, docs, example data
