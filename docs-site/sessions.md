---
title: List, search and summary
nav_order: 1
parent: Command line
---

# List, search and summary

`list`, `summary` and `show` read the local ledger, and bring it up to date first. Each takes
`--json` for the same figures as JSON.

## List and search

```
$ sessionly list
ID        TOOL         STARTED (UTC)      ACTIVE      COST  FILES         LINES  REWRITTEN  REPO      PROMPT
2b02c8f5  Claude Code  2026-11-13 18:29      14s     $0.17      2        +24 -0        1/2  e2e2      Do these steps in order, one tool call each: 1. Write a …
8b1e867c  Claude Code  2026-11-13 18:29       7s     $0.15      0         +0 -0          -  e2e2      Do these steps in order, one tool call each: 1. Write a …
6c6a61b0  Claude Code  2026-11-13 18:10      15s     $0.29      1         +1 -0        0/1  e2e2      Do these steps in order, one tool call each, and keep go…
```

A cost shown with `~` is an estimate, or includes one. Filters combine, and text filters match
substrings ignoring case:

| Option | Keeps sessions |
|---|---|
| `--repo TEXT` | in a repository whose remote or path contains TEXT |
| `--user TEXT` | by a user whose git name or email contains TEXT |
| `--model TEXT` | that used a model containing TEXT, e.g. `opus` |
| `--tool TEXT` | from an agent whose name contains TEXT: `claude-code`, `cursor`, `grok`, `codex` or `opencode` |
| `--file TEXT` | that read or changed a file whose path contains TEXT |
| `--search TEXT`, `-s` | with TEXT in a prompt, title, shell command, search pattern, file path or subagent's description |
| `--since WHEN`, `--until WHEN` | started at or after `--since` and before `--until`: a date (`2026-11-01`, which is midnight UTC), an RFC 3339 time, or an age in hours, days or weeks (`12h`, `7d`, `2w`) |
| `--min-cost USD` | that cost at least that much |
| `--limit N`, `-n` | only the newest N (default 30) |

Search covers the 200-character previews in the session record, not full prompts or output.
A filter that matches nothing is not an error: `--tool claud-code` answers "No sessions match."

## Summary

`sessionly summary` takes the same filters and groups with `--by user` (default), `repo`,
`model`, `tool` or `day`:

```
$ sessionly summary --since 7d
USER                SESSIONS       COST    ACTIVE  PROMPTS  TOOLS (FAILED)  FILES   LINES      REWRITTEN  LINES KEPT
k.ivanow@gmail.com         3      $0.60       37s        3          11 (1)      3  +25 -0      1/3 (33%)         24%
---------------------------------------------------------------------------------------------------------------------
total                      3      $0.60       37s        3          11 (1)      3  +25 -0      1/3 (33%)         24%
```

A session counts under its most used model. With one machine this is one user's view; the same
grouping is what the team dashboard will show once sessions are uploaded.

## One session

`sessionly show <session>` takes a session id or a unique prefix of one:

```
$ sessionly show 8d89
Session    8d893de5-59ac-4cc7-a3fe-57f4e342b8a9
User       Kristiyan Ivanov, k.ivanow@gmail.com
Repo       /tmp/e2e (master)
Time       2026-11-13 17:39:42Z → 17:40:08Z (25s elapsed, 21s active)
Models     claude-opus-5-5
Cost       $0.31 (recorded)
Activity   1 prompts, 7 tool calls (1 failed), 1 subagents, 2 permission requests
Files      1 changed (+1 -0), 1 read

Prompts
  17:39:45  Do these steps in order, one tool call each, and keep going if a step fails: 1. Write a…

Files changed
      +1     -0  README.md

Tools
      2  Bash  (1 without a successful result)
      2  Write  (2 without a successful result)
      1  Agent
      1  Edit
      1  Read

Subagents
  ad8b2722  general-purpose    1 tool calls     $0.11  Echo hello from subagent
```

A repository with an `origin` remote is shown as `host/owner/repo`.
