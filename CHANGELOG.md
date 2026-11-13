# Changelog

## Unreleased

### Added
- `sessionly transcript <session|path> [--json]`: tokens, cost, models, timing, git branch and
  subagent breakdown from a Claude Code transcript. Counts each API response once, includes
  subagent transcripts, prices 5-minute and 1-hour cache writes separately, and combines Claude
  Code's recorded total for the latest run with estimates for earlier runs. Accepts a unique
  prefix of a session id.
- Price table for current Claude models (first-party API rates).
- `sessionly capture`: Claude Code hook entry point. Appends each raw hook payload, with a
  receive timestamp, to `~/.sessionly/raw/claude-code/<session_id>.jsonl`. Silent, always exits 0,
  appends under a file lock, private file permissions.
- `sessionly install` / `uninstall` / `status`: add, remove or inspect the capture hooks for 20
  observe-only events in `~/.claude/settings.json` or a project's `.claude/settings.json`,
  preserving all other settings and hooks.
- `sessionly watch`: pretty-print events live as they are captured.
- `docs/hook-data.md`: reference of all 33 Claude Code hook events, their payloads and what a
  ledger can get from each, based on real captures.
