---
title: Shell edits
nav_order: 3
parent: Command line
---

# Shell edits

Some agents, and some ways of working, edit with the shell instead of the file tools: a
script that rewrites a file, `sed -i`, a heredoc, a formatter. Hooks are told that a command
ran, not what it changed. So the files of the repository are compared just before and just
after each shell command of Claude Code, Cursor or Codex (see [Codex](codex.md) for how sure
that is there), and what differs is looked at: the files and the lines, toward the session's
totals, the rewrite rate and pull requests.

In a [cloud session](cloud-sessions.md) all of what differs is the command's: the agent is
alone there. On your own machine it is not. You may save a file in your editor during a long
test run, and a second agent session may be at work in the same checkout. So here only what
is sure to be the command's is counted:

- **Everything that changed, when the command was over within two seconds** and no other
  session was seen at work in the repository meanwhile (a shell command or a file tool of
  another session, since the look before this command). Nobody saves a file in that time,
  and most commands that edit are that quick. The two seconds run from the start of the look
  before the command to the end of the look after it, so in a repository large enough for a
  look to take a second, few commands are quick.
- **Otherwise the added lines the command's own text spells out**: the lines of a heredoc,
  or of a script given inline. A line counts when it is one of the command's own lines, or is
  long (32 characters) and stands somewhere in it. Lines under 16 characters (`else:`, `}`)
  are in any script and prove nothing; they go with the rest of their file. A file all of
  whose added lines are spelled out counts as it is, with what was removed from it. A file
  where at least half are counts with those lines alone. A file where fewer than half are is
  left out.

## Changing what is counted

What a long command changes without spelling it out (a formatter or a generator that takes a
while, a `sed -i` across a large tree) is therefore not counted. To change what is:

```sh
sessionly settings --shell-edits all   # everything that changed while a command ran
sessionly settings --shell-edits off   # nothing: only the agent's file tools
sessionly settings --shell-edits sure  # as above, the default
```

`sessionly settings` with nothing after it shows what is set.

With `all`, **anything that changes a file in the repository while an agent's command runs
is counted as the agent's**, your own typing included. It fits a checkout only the agent
works in (a git worktree of its own, say).

## What else to know

- A command that begins `cd <somewhere> &&` is looked at where it goes when that is another
  worktree of the session's repository, so an agent working in a worktree somewhere else is
  counted there. A command that goes to some other repository is not looked at there.
- A home directory that is itself a git repository is not looked at on your own machine:
  that would be every file you have.
- It applies to sessions captured by hooks. Sessions already recorded are not changed, and
  imported ones have nothing to compare.
- **For Cursor it holds only while a session is built from the hooks alone**: a cloud
  agent's session, or the editor's before its transcript is written. Once the editor's
  transcript is there the session is rebuilt from it, and what its shell commands changed is
  not carried over.
- Each shell command costs two looks at the working tree with git: about 15 ms each in
  this repository, more in a large one. One that takes more than five seconds is abandoned,
  and that repository is not looked at again in that session.
- The comparison is kept in `~/.sessionly/snapshots/<session>` (an index and the objects
  of changed files; your repository's own index, objects and HEAD are not written) and
  removed when the session ends, or a week after a session that never said it ended was
  last heard of.
- The limits are those of a cloud session: a command that moves to commits it did not make
  is not counted, files git ignores are not looked at, new files over 1 MB are left out, and
  of new files only the first 2000 are looked at. A command whose changes come to more than
  8 MB of difference is not counted at all.
