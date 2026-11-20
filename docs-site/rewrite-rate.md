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
  end, and a checkpoint taken before that is dropped: it was of a session that had not ended.
- If the session's directory is gone on the day, no checkpoint is taken then.

A checkpoint is counts and times: how many tracked lines the agent had added, how many were
there, when that was measured and how old the session was. It is uploaded with the session
and holds no paths and no text. A server keeps the ones it has: an upload that brings
none, from a machine whose ledger was rebuilt, takes none away.

On the dashboard, **By tool** and **By model** have **Kept @7d** and **Kept @30d** beside
**Lines kept**. Each counts only the sessions measured at that age and says how many that is,
as `12 of 40 sessions`: 12 were measured at 7 days, of the 40 with measured lines. A dash means
none has been yet. The overview's own figure is the one at 7 days once any session has one. A
session's page has the row `1d / 7d / 30d / now`.

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
  nothing to do with how it was written.
- Changes made through the agent's file tools are tracked, and of those made by shell
  commands the ones that are sure to be the agent's (see [Shell edits](shell-edits.md)). In a
  [session in the cloud](cloud-sessions.md) all of them are.
- If the session's directory no longer exists, the last measurement is kept.
