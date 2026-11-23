---
title: Claude Code
nav_order: 1
parent: Agents
---

# Claude Code

Claude Code is the agent Sessionly knows most about. A session's activity (prompts, tool
calls, files, subagents, errors) comes from the hooks `sessionly install` adds to
`~/.claude/settings.json`, and its tokens, cost, models and branch from the transcript Claude
Code keeps. Together they make [the session record](session-record.md).

- [Install](install.md) is how the hooks get there, and what that does to the settings file.
- [Cost and transcripts](cost.md) is how the cost is worked out.
- [Past sessions](past-sessions.md) brings in sessions from before the hooks, from their
  transcripts.
- [Cloud sessions](cloud-sessions.md) is for Claude Code's sessions in the cloud.

## Captured events

`sessionly install` registers 20 observe-only events: SessionStart, SessionEnd,
UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, PermissionDenied, Stop, StopFailure, Notification, SubagentStart,
SubagentStop, PreCompact, PostCompact, PostModelSwitch, TaskCreated, TaskCompleted and
InstructionsLoaded. Codex has fewer: see [Codex](codex.md).

Tool events are hooked for every tool. Events that change Claude Code's behaviour when hooked
(WorktreeCreate, WorktreeRemove, PreModelSwitch) are left out on purpose, and so is
MessageDisplay, which fires for every piece of a reply as it arrives.

## Review runs

A session's record counts the review commands that ran in it, `/code-review` and the like,
with their effort, the pull request they named, whether they ran in the cloud, and what their
subagents cost (see [Review runs](session-record.md#review-runs)). They come from the `Skill`
tool's calls, from `UserPromptExpansion` and the prompts for a typed command, and in an
imported transcript from the rows Claude Code writes for a command it runs itself
(`/ultrareview`) and for a skill it forks. The transcript, which is read for cost anyway, adds
three things the hooks do not have: the subagent a typed command forked, the effort Claude
Code reused for a command typed without one, and the number of findings the review's last
reply names: its subagent's, or for a review that ran where it was typed, what the command
printed.

## Hook overhead

The capture hook runs on every event, and tool calls fire two or three events each, so it has to
be fast. `sessionly capture` is a native binary that appends one line under a file lock: about
2–4 ms per call, measured including process spawn (about 20 ms for a 2 MB payload). It never
prints and always exits 0, whatever its input or arguments, so a capture failure can't block or
change your session. If another capture holds the file for more than 1.5 seconds it writes
anyway instead of waiting. Errors go to `raw/_errors.log` in Sessionly's folder.

Two events do more than append a line:

- **A shell command's** two events each also look at the working tree with git, for
  [shell edits](shell-edits.md): about 15 ms each in this repository, more in a large one.
  `sessionly settings --shell-edits off` leaves that out.
- **The end of a turn or of a session** starts the [automatic sync](cli.md#automatic-sync) as
  a process of its own, and does not wait for it.
