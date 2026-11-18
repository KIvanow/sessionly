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

Files changed
     +23     -0  kept 13%   calc.py  (new)
      +1     -0  kept 100%  README.md
```

## What it does and doesn't mean

- A line matches by content anywhere in the file, ignoring leading and trailing whitespace, so
  moved or re-indented code counts as kept. A line the agent added twice has to be there twice.
- Blank lines and lines with no letter or digit (`}`, `);`) are not tracked. That is why the
  count of added lines here is lower than under LINES.
- Lines the agent removed again in the same session are not counted against it.
- The comparison is with whatever is checked out when the measurement runs. `show` says which
  branch that was, and warns if it differs from the session's branch.
- A session that just ended scores 100%. The number only becomes meaningful with time, so read
  it together with the session's age.
- It measures survival, not quality or cause: code can be rewritten for reasons that have
  nothing to do with how it was written.
- Changes made through the agent's file tools are tracked, and of those made by shell
  commands the ones that are sure to be the agent's (see [Shell edits](shell-edits.md)). In a
  [session in the cloud](cloud-sessions.md) all of them are.
- If the session's directory no longer exists, the last measurement is kept.
