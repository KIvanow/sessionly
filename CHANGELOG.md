# Changelog

## Unreleased

### Added
- `sessionly capture`: Claude Code hook entry point. Appends each raw hook payload, with a
  receive timestamp, to `~/.sessionly/raw/claude-code/<session_id>.jsonl`. Silent, always exits 0,
  appends under a file lock, private file permissions.
- `sessionly install` / `uninstall` / `status`: add, remove or inspect the capture hooks for 20
  observe-only events in `~/.claude/settings.json` or a project's `.claude/settings.json`,
  preserving all other settings and hooks.
- `sessionly watch`: pretty-print events live as they are captured.
- `docs/hook-data.md`: reference of all 33 Claude Code hook events, their payloads and what a
  ledger can get from each, based on real captures.
