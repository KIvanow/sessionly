---
title: Codex
nav_order: 3
parent: Agents
---

# Codex

Sessions of OpenAI's Codex (the terminal agent, `codex exec`, and the editor extension, which
all keep the same files) are read from the rollout files under `~/.codex/sessions/` and
`~/.codex/archived_sessions/`, or under `$CODEX_HOME`. `sessionly import --tool codex` brings in
the ones already there.

Written from Codex's source at 0.169.0 and checked against sessions of that version, one run
with `codex exec` and one in the terminal agent with the hooks approved: prompts, commands with
their durations, files and lines changed, model, tokens and the thread's name came out as Codex
reported them, and the second arrived and was uploaded with no command run. Not yet checked:
the editor extension, subagents, MCP tools, and reverted and forked threads.

## What is read

Codex writes two layouts, and both are read. The newer one (`paginated`, what 0.169.0 writes)
keeps a record of each command that ran and each patch that was applied; those records are
what is imported. The older one has only the model's tool calls, so there a command's outcome
is read from its output and a patch's files from the patch text.

| Read from | Has | Does not have |
|---|---|---|
| `~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<thread>.jsonl` | prompts, tool calls with their outcome and how long they took, files and lines changed, subagents, times, the model of each turn, tokens per model, the Codex version and where it was started from (`cli`, `exec`, `vscode`), the git branch, and the thread's name if it was given one | cost; in the older layout, the lines of a file a patch deleted |

- **Tools** are mapped to the common names: a command is Bash, `view_image` is Read,
  `spawn_agent` is Agent, `update_plan` is TodoWrite, and a web search is WebSearch. One patch
  can change several files, so it becomes one Write (a new file) or Edit per file. An MCP tool
  is `mcp__<server>__<tool>`. Other tools keep Codex's name.
- **Tools reached through a script.** Codex can have the model call its tools from a piece of
  JavaScript (a call to `exec`). In the newer layout that makes no difference, since what ran
  is recorded either way. In the older layout only patches are recorded besides the script, so
  such a session has its edits but not its commands.
- **A subagent** is a thread with a rollout file of its own. It is folded into the session
  that started it, with its tool calls and tokens, as Claude Code's subagents are. A thread
  is a subagent when Codex itself says so in the file's first record, not because it carries
  another thread's session id, which a fork can too. A subagent whose session was not known
  yet may have been uploaded as a session of its own; once it is part of its session, the
  next upload asks the server to drop that copy.
- **Going back to an earlier turn** (a revert) makes Codex start a new file for the thread
  that points at the part of the old one that still stands. The session is that part and
  what came after: the turns taken back are not in it. A fork is a thread of its own, so a
  session of its own, with what was done after the fork; what came before is in the session
  it was forked from and is not counted twice.
- **A new name** for a thread is picked up at the next import or sync.
- **There is no cost.** Codex records tokens and nothing about money, and the price table here
  has Anthropic's models only. A Codex session shows its tokens per model, has no cost figure
  and adds nothing to cost totals.
- **Tokens are per model response.** Rollouts from versions that kept no record per response
  are counted from the running total instead, each time it grew.
- A rollout Codex has compressed (`.jsonl.zst`, a feature that is off by default) is not read.

## Hooks

Codex has hooks of its own, in `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), with payloads shaped like Claude Code's.
When `~/.codex` exists, `sessionly install` adds the capture command there too, for 11 events
(SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
SubagentStart, SubagentStop, PreCompact and PostCompact), marked `async` (all but SessionEnd,
which Codex runs in step regardless) so Codex neither waits for it nor shows it running. `sessionly uninstall` removes them and `sessionly status` counts
them. A session the hooks have seen is brought in from its rollout at the next sync without
running `import`; as with Cursor and Grok, the agent's own file is the record and the hooks say
that the session happened. Two things are taken from the hooks, which the rollout does not
keep. A session the hooks did not see has neither.

- **How often Codex asked for permission.**
- **What its shell commands changed**, where [shell edits](shell-edits.md) are counted. The
  rollout has each command and the lines of each patch (`apply_patch`), but nothing of what
  a `sed -i` or a heredoc did to a file. The hooks compare the files before and after the
  command, and what they find is put with the same command in the rollout. Because the hooks
  are `async`, Codex does not wait for the look before a command: a command that changes a
  file before that look is done has that change missed, never counted twice. A file a patch
  changes while a command runs is the patch's, not the command's.

**Codex does not run a new or changed hook until you have approved it.** After `sessionly
install`, start `codex` and accept the hooks in the review it shows (or run `/hooks`). Moving
the `sessionly` binary changes the command, so Codex will ask again. `sessionly install
--project` and `--repo` do not write Codex hooks. Codex's cloud runs none: what is recorded of
a task there is under [Codex cloud tasks](codex-cloud-tasks.md).
