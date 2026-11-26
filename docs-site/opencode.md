---
title: OpenCode
nav_order: 4
parent: Agents
---

# OpenCode

Sessions of OpenCode are read from its database, `opencode.db`: `$OPENCODE_DB` if that is set,
otherwise `$XDG_DATA_HOME/opencode/opencode.db`, otherwise
`~/.local/share/opencode/opencode.db`. `sessionly import --tool opencode` brings in the ones
already there.

The shapes below are taken from OpenCode 1.19.6. The database is opened read-only. Sessionly
does not run the `opencode` command to find it: that command can migrate the database.

## What is read

| Read from | Has | Does not have |
|---|---|---|
| `message` and `part` in `opencode.db` | prompts, tool calls with their outcome and how long they took, files and lines changed, child sessions, times, the model of each turn, tokens, OpenCode's cost when it recorded one, the OpenCode version, and the directory the session was in | permission prompts; the git branch; a session stored only in `session_message` |

- **Tools** are mapped to the common names: `read` is Read, `edit` is Edit, `write` is Write,
  `bash` and `shell` are Bash, `task` and `subagent` are Agent, `grep` is Grep, `glob` is Glob,
  `webfetch` is WebFetch, `websearch` is WebSearch, `todowrite` is TodoWrite, and `skill` is
  Skill. `apply_patch` and `patch` become one Write (a new file) or Edit per file. Other tools
  keep OpenCode's name.
- **Files and lines.** OpenCode records a turn's diff on the user message. Those lines are put
  on the file tool that wrote them, or on the shell command when that is what changed the file,
  or on a Write or Edit of their own when neither is there.
- **A child session** (`parent_id` set, including one a `task` tool started) is folded into the
  session that started it, with its tool calls and tokens. A child whose parent is gone, or
  whose parent is one of OpenCode's own agents (`title`, `summary`, `compaction`), stands
  alone. Those three are not sessions.
- **Going back to an earlier message** (`session.revert`) drops the messages that came after
  the one named. A session stored only in `session_message`, with nothing in `message`, is not
  read: import fails that session rather than reporting it empty.
- **Cost.** A non-zero cost on an assistant message is OpenCode's figure. A message that
  recorded no cost, and did record tokens, is estimated at API list prices (cached input at its
  own price, reasoning as output, a cache write at the short-lived write price). A model with
  no listed price adds its tokens and no dollars. A session only on such models has no cost
  figure. A mix of OpenCode's dollars and an estimate is an estimate; a mix that also leaves
  some requests unpriced says so.
- **Tokens** are taken from each assistant message, not from the session row's totals. Output
  includes reasoning. A child session's tokens are added to the parent; they are not already in
  the parent's messages.
- **The branch is not recorded.** The directory is, and a repository is recognized from it
  later, but the branch that was checked out is left unset.

Not read: the desktop app, `opencode github`, and permission prompts. OpenCode does not persist
the asks, so `permission requests` stays 0.

## The plugin

OpenCode loads JavaScript from `plugins/` under its config directory (`~/.config/opencode`, or
`$XDG_CONFIG_HOME/opencode`). When that directory exists and the install is for the whole
machine (not `--project`), `sessionly install` writes `plugins/sessionly.js`. It does not edit
`opencode.json`.

The file only notes that a session was created or went idle, as one line under
`~/.sessionly/raw/opencode/`. That line names the session and nothing the person typed.
`sessionly uninstall` removes the file and nothing else. A session the plugin has seen is
brought in from the database at the next sync without running `import`. The database is the
record; the plugin says the session happened. `sessionly import --tool opencode` is the
backfill for sessions from before the plugin was installed.

A child session's note is enough: the parent is imported with it.
