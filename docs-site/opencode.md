---
title: OpenCode
nav_order: 4
parent: Agents
---

# OpenCode

Sessions of OpenCode are read from its database, `opencode.db` in OpenCode's data folder
(`$XDG_DATA_HOME/opencode`, otherwise `~/.local/share/opencode`). `$OPENCODE_DB` takes its
place when it is set: an absolute path as it is, any other path under the data folder, as
OpenCode reads it. `sessionly import --tool opencode` brings in the ones already there.

Released builds of OpenCode use `opencode.db`. A build of another channel, such as one built
from source, uses `opencode-<channel>.db` unless `OPENCODE_DISABLE_CHANNEL_DB` is set; point
`$OPENCODE_DB` at that file for Sessionly to read it. A database in memory (`:memory:`) cannot
be read.

The shapes below are taken from OpenCode 1.19.6. The database is opened read-only. Sessionly
does not run the `opencode` command to find it: that command can migrate the database.

## What is read

| Read from | Has | Does not have |
|---|---|---|
| `message` and `part` in `opencode.db` | prompts, tool calls with their outcome and how long they took, files and lines changed, child sessions, times, the model of each turn, tokens, OpenCode's cost when it recorded one, the OpenCode version, and the directory the session was in | permission prompts; the git branch; a session stored only in `session_message` |

- **Tools** are mapped to the common names: `read` is Read, `edit` is Edit, `write` is Write,
  `bash` and `shell` are Bash, `task` and `subagent` are Agent, `grep` is Grep, `glob` is Glob,
  `webfetch` is WebFetch, `websearch` is WebSearch, `todowrite` is TodoWrite, and `skill` is
  Skill. `apply_patch` becomes one Write (a new file) or Edit per file it lists. Other tools
  keep OpenCode's name.
- **Prompts** are what the person typed. Text OpenCode added itself is left out: the file an
  `@` mention read, and the message that carries on after a compaction or a command. A
  command OpenCode runs as a subtask, such as `/review`, is kept as its name (`/review`), not
  its template, so a review is counted; the arguments typed after it are not kept. Another
  command is kept as the template it expanded to.
- **Files and lines.** OpenCode records a turn's diff on the user message, with paths from the
  root of the repository (the project's worktree), which is not the session's directory when
  OpenCode was started below it. Those lines are put on the file tool that wrote them, or on
  the shell command when that is what changed the file, or on a Write or Edit of their own
  when neither is there.
- **A child session** (`parent_id` set, including one a `task` tool started) is folded into the
  session that started it, with its tool calls and tokens. A child whose parent is gone, or
  whose parent is one of OpenCode's own agents (`title`, `summary`, `compaction`), stands
  alone. Those three are not sessions.
- **Going back** (`session.revert`) drops what it undid, as OpenCode does at the next prompt:
  the message named and every later one, or, when a part is named, that part and what came
  after it. A session stored only in `session_message`, with nothing in `message`, is not
  read: import fails that session rather than reporting it empty.
- **Times** come from the messages. The session's own update time is not its end: going back
  and other changes that are not work move it.
- **Cost.** A non-zero cost on an assistant message is OpenCode's figure. A message that
  recorded no cost, and did record tokens, is estimated at API list prices (cached input at its
  own price, reasoning as output, a cache write at the short-lived write price). A model with
  no listed price adds its tokens and no dollars. A session only on such models has no cost
  figure. A mix of OpenCode's dollars and an estimate is an estimate; a mix that also leaves
  some requests unpriced says so.
- **Tokens** are taken from each step of an assistant message (its `step-finish` parts), not
  from the session row's totals: a step is one request, and the message's own figure is its
  last step's only. Output includes reasoning. A long prompt's price is picked by all of its
  input, cached or not. A child session's tokens are added to the parent; they are not already
  in the parent's messages.
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
