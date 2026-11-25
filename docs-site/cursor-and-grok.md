---
title: Cursor and Grok
nav_order: 2
parent: Agents
---

# Cursor and Grok

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
are mapped to common names (Read, Edit, Write, Bash, Grep, and for Cursor Glob) so a row means
the same thing whichever agent produced it. Sign-in files of either agent are never opened.

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
| **Grok** | `~/.grok/sessions/<directory>/<session>/` (or under `$GROK_HOME`) | prompts, tool calls with their outcome, files and lines changed, times, model, tokens, Grok's own cost figure, and subagents | permission prompts (a call that was not allowed counts as failed) |
| **Cursor** | `~/.cursor/projects/<project>/agent-transcripts/`, plus the hook capture | prompts and the minute each was sent, tool calls with their input, files and lines changed, subagents. For turns the hooks saw: exact times, how long each tool call took and whether it failed, the model, and tokens | anything but prompts, tool calls and files for turns that ran before the hooks were installed; Cursor's own cost figure |

Grok runs a subagent as a session of its own, in a folder of its own, and its hooks capture it
apart. It is read into the session that started it, as Claude Code's subagents are: its tool
calls and files are that session's, marked as the subagent's, and it is not a session in the
ledger. Its cost is Grok's own figure for it. The session's cost already includes it, as Grok
counts every model call a subagent makes in the session that started it. A subagent whose
session's folder is gone stands on its own. A subagent imported on its own by a Sessionly from
before this is taken out of the ledger at the next sync once its parent is in, and taken back
from the server at the next upload, as a Codex subagent's thread is.

What Cursor's transcripts leave out, it tells the hooks: when a prompt was sent and its turn
ended, the model, and the tokens the turn used. A turn the hooks saw is paired with its prompt
in the transcript (same text, same minute) and gets those.

Cursor writes a session's transcript when a turn ends. While the first turn is still running,
or if the editor was closed before it ended, the session is built from the hooks alone: it has
its prompts, tool calls and times, but the lines an edit changed are counted only once the
transcript is there.

## Review runs

A `/code-review` typed in Cursor or Grok (`/review` and `/security-review` too) is a
[review run](session-record.md#review-runs) of the session: when it ran and the pull request
it named, and how many findings it had where the reply says so in its first lines. Neither
agent says what a review cost apart from the rest of the session.

## Reading a Cursor session's figures

- **Cost is an estimate, and only for the turns the hooks saw.** It is those turns' tokens at
  API list prices, which is a measure of the work done, not what Cursor bills. `show` says how
  many prompts it covers (`covers 1 of 13 prompts`). A session the hooks saw none of has no
  cost, and adds nothing to totals; a model without a known price is left out the same way.
- **Active time** counts only those turns too.
- **Tokens are per turn**, not per request, so a model's request count is its number of turns.
- For turns from before the hooks, every tool call counts as succeeded and there is no model.

A Cursor session's repository is worked out from the project folder's name, which Cursor
derives from the path; if that directory no longer exists the session has no repository.
