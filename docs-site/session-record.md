---
title: The session record
nav_order: 1
parent: Data and privacy
---

# The session record

`sessionly sync` builds one record per session from two sources: the captured hook events
(prompts, tool calls, files, subagents, errors) and the transcript (tokens, cost, models, git
branch). Records are stored in `~/.sessionly/ledger.db` (SQLite).

Claude Code deletes old transcripts, so after each read Sessionly saves what it needs from one
(cost, usage, models, branch) under `~/.sessionly/transcript-facts/`. The ledger itself is
derived data: delete it and `sessionly sync --force` rebuilds it from the raw capture and those
saved facts. A normal sync never removes a session; `--force` also drops sessions whose raw
capture has been deleted. (The one exception: the thread of a Codex subagent that was first
taken for a session of its own goes once it is part of the session that started it.) An agent
that was opened and closed again, with nothing asked, no tool run and no cost, is not a
session and is left out. A session is rebuilt when its capture, its transcript or a subagent
transcript grows, or when Sessionly or its price table changes.

The record is the contract between this binary and any server it later uploads to. Its JSON
Schema is [schema/session.schema.json](https://github.com/KIvanow/sessionly/blob/main/schema/session.schema.json), generated from the Rust
types by `sessionly schema`; a test fails if the checked-in file is stale.

## What the record holds

The record holds metadata and short previews, not full content:

- **Prompts:** SHA-256, length and the first 200 characters.
- **Tool calls:** tool, status, duration, file path, SHA-256 of the input, size of the output,
  and a one-line summary (the shell command, search pattern or URL, cut to 200 characters).
  A failed call also keeps the first 200 characters of its error, which for a shell command is
  the start of its output (for a command of Codex's, the end of it).
- **Files:** absolute path, read and write counts, lines added and removed.
- **Skills:** a `Skill` call keeps the skill's name (`code-review`, `plugin:name`), not its
  arguments. The agent writes that field: what is in it is kept only when it has the shape
  of a name (letters, digits, `_ - : .`, at most 100 characters).
- **Review runs** (`reviews`): see [below](#review-runs).
- Full prompts, file contents and successful command output stay in the raw capture.

The previews and paths are still sensitive: a command can contain a token, a path contains a
user name. The local record keeps them; what may leave the machine is decided separately (see
[What an upload contains](upload-contents.md)).

## Review runs

`reviews` lists each time a review command ran in a session, and `counts.reviews` how many.
A record without `counts.reviews` is from a Sessionly that did not count them, or is a Codex
session whose rollout was not there to read: not known, which is not none.

In Claude Code the commands are `/code-review`, `/review`, `/security-review` and
`/ultrareview` (a plugin's `anything:code-review` too; where it is typed, a plugin's name
with a dot in it is not taken for one, since a file's name ends that way). A run starts in one of three ways:

- the agent calls the `Skill` tool with one of them (`via: skill`),
- you type it (`via: slash_command`), or
- Claude Code runs its own command, `/ultrareview`.

In Cursor and Grok a run is the command typed as a prompt (`/code-review #41`, `via:
slash_command`), on a machine or in Cursor's cloud. A prompt that opens with a path which
ends in a command's name (`/home/ann/notes.md:review`) is no command. The review there runs in the session's
own thread: such a run has when it ran and a pull request number, its findings where the
reply says how many (seldom, in practice), and no cost or subagents of its own. The agent choosing to review without the command being typed is not
seen.

In Codex it is `/review` (`via: codex_review`): the rollout says when review mode was entered
and left. Such a run has no effort and no pull request number. It has a `target`, the kind
of change it was pointed at (`base_branch`, `uncommitted_changes`, `commit` or `custom`; the
branch's name is not kept), the exact number of findings the reviewer returned, and as its
cost what the reviewer's thread spent, at API list prices like the rest of a Codex session.

Each run has:

- `command`, as written.
- `effort`: the first argument, when it is `low`, `medium`, `high`, `xhigh`, `max` or `ultra`.
  For a command typed without one, the effort Claude Code says it reused ("Reusing high
  effort, the level you typed last time"), where the transcript is there to say so.
- `pull_number`: a pull request number among the arguments: `#528` or a pull request's URL
  anywhere in them, a bare `621` only as the first or second argument. A number further on
  is a number in a sentence ("the last 3 commits") and is not taken for one, nor is one in
  a path (`/work/pull/42/diff.rs`). A URL of a pull request in a repository of another
  name than the session's gives none: that number is not one of this repository's.
- `ran`: `cloud` for `/ultrareview` and `/code-review ultra`, else `local`.
- `agent_id`, when a subagent ran it.
- `status` and `duration_ms`: from the start to the end of the last of its subagents. A
  typed command went as its turn did: `failed` where the turn failed, and in Cursor and
  Grok `no_result` where it has no end (still running, or interrupted). In Claude Code a
  typed command forks and its own turn does not end, so only a failure is told. A Codex
  review that was never left has no duration, nor has a review whose fork has no end on
  record. A typed command and a `Skill` call it led to are one run where the call is the
  first thing done in the turn; a call made after other work is the agent reviewing again.
- `subagents` and `estimated_cost_usd`: the subagents that did the review. That is the one a
  review skill forks to run in, or, where none is known, those started from the same thread
  before your next prompt, with the subagents they started in turn. A review that ran
  inside another review's subagent has its own subagents, cost and findings, which are not
  the outer one's too.
- `findings`: how many it reported, where that can be told: from a list it reports
  (`ReportFindings` calls that went through, or Codex's own), or else from the reply that ends the review, when that
  reply is a JSON list of findings or its first lines say how many it found, kept or has
  ("15 findings, most severe first", "I reviewed PR #50 and found 4 issues", "no
  findings"). The reply is read on your machine and only the number is kept. It is the reply
  of the subagent a Claude Code review ran in. For one typed there that forked none, it is
  what the command printed when it ended, or else the last thing said in its turn. In
  Cursor and Grok it is the last thing said in the turn. A reply that words its result
  another way, names two different numbers, or says there are none of one kind only ("no
  blocking bugs", "no bugs that crash anything"), has none (`null`), which is not zero.

Nothing else of the arguments is kept: no free text, no path. A run is the same record in
every content mode.

Known limits:

- A review started with a prompt in words ("review this branch with medium effort") runs as
  plain subagents and leaves no command: it is not counted.
- Whether you typed the command or the agent chose the skill is told only where the transcript
  or the hooks show a typed command. Both are a review that ran.
- The cost of a run is its subagents' only, without the main thread's own tokens: a floor. It
  is already part of the session's cost.
- A review in the cloud is billed apart: its cost is not known (`null`).
- A team's own review skill under another name is not counted.
- A typed command's fork is known from the transcript, which is read for a session captured
  by the hooks too. Where the transcript is gone before it was read, the hooks alone do not
  say which subagent the command forked, and it is found by time.
- A transcript copied into a resumed session (`--fork-session`) may count the earlier runs in
  both sessions.
- A record built by a Sessionly that did not count review runs has none (`counts.reviews` is
  missing, which a server shows as "not known"). After an update, the next `sessionly sync`
  imports again the sessions that were imported before; `sessionly import` brings in the rest
  from their transcripts.

## Limits to know about

- Sessions from before the hooks were installed are not in the ledger until you run
  `sessionly import` (see [Past sessions](past-sessions.md)).
- If the hooks were installed partway through a session and it hasn't been imported, its record
  says so (`captured_from_start: false`): prompts, tools and files cover the captured part, cost
  covers the whole session.
- Files count as changed through the agent's file tools when the call succeeded. A session's
  count of failed tool calls has those that failed, not those that were interrupted, denied
  or declined.
- File changes made by shell commands (`sed`, `git apply`, generators) are attributed as far
  as they are sure to be the agent's; a long command's are mostly not (see
  [Shell edits](shell-edits.md)). In a [session in the cloud](cloud-sessions.md) all of what
  each shell command changed is counted.
- User name and email come from git config at sync time. They are a label, not verified identity.
