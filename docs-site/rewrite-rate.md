---
title: Rewrite rate
nav_order: 2
parent: Command line
---

# Rewrite rate

How much of what the agent wrote is still there later. For each file a session changed,
Sessionly keeps the lines the agent added (as hashes) and, on every sync, counts how many are
still in the file on disk.

- **REWRITTEN `1/2`:** one of the two changed files has kept less than half of the agent's lines.
  A deleted file counts as rewritten, and so does one that can no longer be read or has grown
  past 20 MB.
- **LINES KEPT:** the share of the agent's added lines that still exist.

`sessionly show` gives it per file:

```
Rewrite    1 of 2 changed files rewritten since; 19% of 16 added lines still there (measured 2026-11-13 18:30 on master)
           still there after it ended: 1d 88%, 7d 31% (taken on day 9), 30d -

Files changed
     +23     -0  kept 13%   calc.py  (new)
      +1     -0  kept 100%  README.md
```

## At 1, 7 and 30 days

The figure above is of now, and now is a different age for every session: one that ended an
hour ago still has all its lines, one from last month has had a month to lose them. An agent
used mostly this week would look better than one used mostly last month. So Sessionly also
keeps what was there at three fixed ages after a session ended: **1 day, 7 days and 30 days**.
Those compare like with like.

- **A checkpoint is the first measurement at or after that age.** Measuring happens on every
  sync, and a sync runs whenever a session ends, so on a machine in daily use that is the same
  day.
- **Once kept, it is never changed.** Later syncs go on updating the latest figure and leave
  the checkpoints as they are.
- **A missed day is taken late, and says so.** If the machine was off on day 7, the first sync
  after it stands for day 7 and records how old the session really was. `show` then says
  `taken on day 9`, and the session's page says the same.
- **Nothing is made up for the past.** A session that was already older than an age when
  Sessionly began keeping checkpoints on that machine has none for that age:
  nothing was measured then. It still gets the later ages as it reaches them, and the latest
  figure as before.
- **Age counts from the session's end.** A session that is resumed starts again from its new
  end, and the checkpoints counted from the end it had before are dropped: they were of a
  session that had not ended. A session with no end recorded has no checkpoints.
- If the session's directory is gone on the day, no checkpoint is taken then.

A checkpoint is counts and times: how many tracked lines the agent had added, how many were
there, when that was measured, how old the session was, and the end of the session that age
was counted from. It is uploaded with the session
and holds no paths and no text. A server keeps the ones it has, by the same rule
as the machine: an upload that brings none, from a machine whose ledger was rebuilt, takes none
away, and one of a session that has another end now drops them.

On the dashboard, **By tool** and **By model** have **Kept @7d** and **Kept @30d** beside
**Lines kept**. Each counts only the sessions measured at that age and says how many that is,
as `12 of 40 sessions`: 12 were measured at 7 days, of the 40 with measured lines. A dash means
none has been yet. The overview's own figure is the one at 7 days once any session has one. A
session's page has the row `1d / 7d / 30d / now`.

## Later commits: reverts and fixes

The rewrite rate says how much went, not why. So Sessionly also reads the repository's history
(`git log`, on your machine) for the commits after a session ended that changed its agent's
lines, and says what each was:

- **Reverted:** the commit says `This reverts commit …` of a commit that brought the session's
  lines in, or its subject begins with "revert" and it takes out at least half of the session's
  lines still there. A revert reverted in turn (git names that one `Reapply "…"`) is
  **relanded**.
- **Changed by a fix:** its subject line has a fix word (`fix`, `fixes`, `bug`, `hotfix`,
  `regression`, `broken`, `crash`, `typo`, …) or is a conventional `fix:`. Most such fixes are
  of something else and change the agent's lines along the way; this does not say the agent's
  lines were wrong. A fix where at least half of the lines the commit removed were the
  session's is a **likely fix** (`fix*` below). About half of those are fixes of the agent's
  own lines.
- **Rework:** neither.

```
$ sessionly outcomes 7c2e
Session    7c2e91d0-…
Ended      2026-11-13 18:30
Later      1d nothing, 7d changed by 1 fix (1 likely), reworked 1x, 30d -

COMMIT     DATE              KIND      LINES  SIGNALS                     SUBJECT
a41f0c9e2  2026-11-16 09:12  fix*          4  fix_message,fix_conventi…   fix: totals skip the last row
e09b3d771  2026-11-18 14:40  rework        2                              Name the columns
```

`show` has the same as a line, `Later`, and `summary` has **FIX@7D** (sessions changed by a fix
within 7 days, of those 7 days old) and **REVERTED@30D**, once a session has those ages.

- **A commit touches a session when it removes or changes at least two of its lines.** One line
  is too often a generic one (`if (`, an import) that matched by chance. A line the commit adds
  back, in that file or another, was moved, not changed. A line three sessions or more wrote
  in the same file does not count on its own.
- **A session's own commits don't count:** those after it began that add its lines.
- **The counts are kept at 1, 7 and 30 days, as the rewrite checkpoints are**, and age counts
  from the session's end the same way. Unlike those, an age reached before Sessionly looked can
  be counted later from the history; it then says it was late.
- **History is read only when an age needs it**, so most syncs read none.
- **Read:** the branch checked out and the remote's default branch (`origin/HEAD`), so a fix on
  `main` is found while you are on a feature branch. Nothing else: not other branches, not merge
  commits (a reverted merge counts when the revert takes out most of the lines).
- **Not counted:** a fix that only adds lines next to the agent's (a missing check), and a fix
  whose subject has none of the words. A repository whose subjects describe what changed ("Stop
  the sweep from deleting history") has fixes that count as rework. `sessionly settings
  --fix-words` sets the words.
- **Uploaded:** only the counts at each age (`outcomes`), never a commit's SHA, subject or files.
  `sessionly settings --outcomes off` stops reading history and sending them.

On the dashboard, **By tool** and **By model** have **Changed by a fix @7d** and
**Reverted @30d**, each of the sessions counted at that age, once any is. A session's page has
**Later commits** with `1d / 7d / 30d`.

## What it does and doesn't mean

- A line matches by content anywhere in the file, ignoring leading and trailing whitespace, so
  moved or re-indented code counts as kept. A line the agent added twice has to be there twice.
- Blank lines and lines with no letter or digit (`}`, `);`) are not tracked. That is why the
  count of added lines here is lower than under LINES.
- Lines the agent removed again in the same session are not counted against it.
- The comparison is with whatever is checked out when the measurement runs. `show` says which
  branch that was, and warns if it differs from the session's branch.
- A session that just ended scores 100%. The latest figure only becomes meaningful with time,
  so read it together with the session's age, or read the figure at a fixed age instead.
- It measures survival, not quality or cause: code can be rewritten for reasons that have
  nothing to do with how it was written. So do the later commits: a fix that touches an agent's
  lines is linked to them, not caused by them.
- Changes made through the agent's file tools are tracked, and of those made by shell
  commands the ones that are sure to be the agent's (see [Shell edits](shell-edits.md)). In a
  [session in the cloud](cloud-sessions.md) all of them are.
- If the session's directory no longer exists, the last measurement is kept.
