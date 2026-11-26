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
- **The end of a turn.** A reply OpenCode wrote an `error` on (the provider failed, the key
  was refused) ends its turn as an API error, with the error's name and status, not its
  message. A turn the person stopped (`MessageAbortedError`) has no end, as one interrupted
  in Claude Code. A turn goes on, as OpenCode's own loop does, while its last reply is still
  being written (no `time.completed`), stopped to call tools (`finish: tool-calls`), or has a
  tool call left to answer (some providers say `stop` with tool calls in the reply): a sync
  can run while a turn does. A later prompt ends the turn before it. A turn includes the
  messages OpenCode writes itself after it, such as the one that sums up a subtask command,
  so `/review` ends when that reply does.
- **Titles.** OpenCode's placeholder (`New session - <time>`, `Child session - <time>`), which
  it keeps until its title agent names the session, is not taken for a title.
- **Files and lines.** OpenCode records a turn's diff on the user message, with paths from the
  root of the checkout the session ran in, which is not the session's directory when OpenCode
  was started below it. One project is every checkout of a repository: the root is the deepest
  of the project's `worktree`, its `sandboxes` and its `project_directory` rows (a git
  worktree, such as one under `.claude/worktrees/`) that the session's directory is in. A diff
  matched to its tool by the end of its path is put on the file the tool named. Those lines are put on the file tool that wrote them, or on
  the shell command when that is what changed the file, or on a Write or Edit of their own
  when neither is there. On Windows the paths are written with `\`, as OpenCode's tools write
  theirs.
  - The diff is a snapshot of the repository before and after the turn. A turn that started a
    child session leaves out what the child changed, which the child's own diff counts.
    The children one turn started run at the same time, beside that turn's own tools, and
    each has the others' changes in its snapshot. A child keeps the files its tools, or its
    children's, wrote and nothing beside it did. A file something beside it wrote too is
    counted from each one's tool patch. A file no tool wrote goes to the first child of the
    turn that ran a shell command, unless the turn's own tools wrote it.
  - The snapshot has only what git sees in the session's folder: not a file git ignores
    (`.env`), and not one outside the folder. For those, the lines are what the tools
    returned: `edit` and `apply_patch` their patch, and `write` a new file's content. A file
    `write` wrote over has no lines. OpenCode records no diff at all outside a git repository,
    or with `snapshot` off, and there every file is read that way.
- **A row that is not JSON** is left out, and the rest of its session is read.
- **A child session** (`parent_id` set, including one a `task` tool started) is folded into the
  session that started it, with its tool calls and tokens. A child whose parent is gone, or
  whose parent is one of OpenCode's own agents (`title`, `summary`, `compaction`), stands
  alone. Those three are not sessions.
- **A fork** copies the messages up to a point into a new session that does not say where it
  came from. The copies keep the time they were first written, which is before the fork was
  made, and are left out: the original session counts them.
- **Going back** (`session.revert`) drops what it undid, as OpenCode does at the next prompt:
  the message named and every later one, or, when a part is named, that part and what came
  after it. OpenCode does not write that turn's diff again, so the files only the undone part
  wrote are left out of it. A session it emptied is imported with nothing in it; the ledger keeps what it
  had until a full rebuild (`sessionly sync --force`), as a sync never removes a session. A
  session stored only in `session_message`, with nothing in `message`, is not read: import
  fails that session rather than reporting it empty.
- **Models** are kept as their maker names them (`claude-sonnet-4-5`), as the other agents
  record them, and who served each one (`anthropic`, `openrouter`, `ollama`) as its
  `provider` in the session's usage. OpenRouter's ids name the maker too
  (`anthropic/claude-sonnet-4.5`); the model is the part after it. Anthropic's models are
  written with dashes, as Anthropic writes them, where OpenRouter and Copilot write a dot:
  `claude-sonnet-4.5` is `claude-sonnet-4-5`.
- **What going back undid costs nothing.** OpenCode deletes it at the next prompt and takes
  its tokens and cost off the session's own totals, so they cannot be read afterwards.
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
`opencode.json`. A `plugins/sessionly.js` that Sessionly did not write is left alone: install
says so and installs nothing, and uninstall does not remove it.

The file only notes that a session was created or went idle, as one line under
`~/.sessionly/raw/opencode/`. That line names the session and nothing the person typed. When
a session goes idle, the plugin also runs `sessionly capture` (the binary `install` ran from;
a moved binary needs `install` again), which starts the [automatic sync](cli.md#automatic-sync)
as the end of any agent's turn does. `sessionly uninstall` removes the file and
nothing else. A session the plugin has seen is brought in from the database at the next sync
without running `import`. The database is the
record; the plugin says the session happened. `sessionly import --tool opencode` is the
backfill for sessions from before the plugin was installed.

A child session's note is enough: the parent is imported with it.
