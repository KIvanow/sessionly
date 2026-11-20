---
title: Pull requests
nav_order: 9
---

# Pull requests

How much of a pull request did coding agents write, with which models, and how did those lines
fare in review? The [GitHub Action](https://github.com/KIvanow/sessionly/tree/main/action) reports each pull request to the server when it is
opened, pushed to, reviewed and closed; the server matches the lines it adds against the lines
agents added in uploaded sessions. No source code leaves GitHub or anyone's machine: both sides
send hashes.

## Set it up

```yaml
# .github/workflows/sessionly.yml
name: Sessionly
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, closed]
  pull_request_review:
    types: [submitted]
jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # to comment; "read" is enough with comment: false
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}   # a token with the ci role
```

It needs three things:

1. That workflow.
2. A token with the role **CI**, made on the dashboard's Team page and saved as the repository
   (or organization) secret `SESSIONLY_TOKEN`. A CI token can report pull requests and do
   nothing else (see [People, tokens and sign-in](people-and-tokens.md)).
3. `sessionly settings --line-hashes on` on the machines whose sessions should count (see
   [What an upload contains](upload-contents.md)), and `SESSIONLY_LINE_HASHES=on` in the cloud
   environments (see [Cloud sessions](cloud-sessions.md)).

What to know about the workflow:

- `@main` follows this repository's main branch. To decide yourself when the Action changes,
  name a commit instead (`KIvanow/sessionly/action@<commit sha>`), as this repository's own
  [workflow](https://github.com/KIvanow/sessionly/blob/main/.github/workflows/sessionly.yml) does.
  The list, and a pull request's page, say when the repository's most recent report from the
  Action, or that named no reporter, is from an older one, and no report from the last 30 days
  came from the current Action or a newer one. The page names that most recent report's
  version. If the workflow pins the Action to a commit or tag, move that pin to a newer one.
  A re-run of that pin keeps the old version: push a commit on an open pull request, or
  [start the workflow by hand](#pull-requests-from-before-the-action) with its number if it
  has been merged. With `@main`, re-run the job: it fetches the Action again. A pull request
  that was itself last reported by an older one says so, without asking for a change that a
  later report already shows was made. GitHub offers a run you start by hand only when
  `workflow_dispatch` is in the workflow on the default branch, and the changed file has to
  be there before you start it.
- The job needs Node 20 or later on the runner, which GitHub's own runners have. It does not
  check the repository out.
- A problem (server down, token refused) is a warning on the run, not a failed check, unless
  you set `fail-on-error`.
- Pull requests from forks get no secrets from GitHub, so the Action cannot report them; the
  run shows a warning that the token is missing.
- On GitHub Enterprise Server the Action uses the server's own address and API, as the runner
  gives them.

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required) | Address of your Sessionly server. |
| `token` | (required) | A Sessionly token with the `ci` role. |
| `github-token` | the workflow's token | Used to read the pull request, and to comment if that is on. |
| `comment` | `true` | Post the figures as one comment on the pull request and keep it up to date. Needs `pull-requests: write`; without it the run warns and the figures are on its summary page only. `false` for no comment. |
| `summary` | `true` | Write the figures to the run's summary page. |
| `ignore` | see below | Files to leave out, separated by commas or new lines. |
| `other-names` | | Names clones of the repository may still have as their origin, as `owner/name` separated by commas or new lines (20 at most): for example from before it was renamed or moved to another owner. |
| `backfill` | `false` | For a pull request from before the Action was added: first report it as it was when opened, worked out from its commits, so what review changed can still be measured. See [below](#pull-requests-from-before-the-action). |
| `pr-number` | | The pull request to report, when the workflow was not started by one. Or several: `all` for the latest ones, `20-60` for a range. See [below](#pull-requests-from-before-the-action). |
| `since` | 90 days ago | With `pr-number: all`, how far back to go: a date such as `2026-01-31`. |
| `fail-on-error` | `false` | Fail the job if the report cannot be made or sent. |

An input that is on or off takes `true`, `yes`, `on` or `1` for on, in any case; anything else
is off.

Outputs: `lines` (tracked lines the pull request adds) and `agent-lines` (how many a coding
agent wrote). A run that reports several (`all` or a range) sets neither: its figures, one
row for each pull request, are on the run's summary page.

**`ignore`.** By default: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
`Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `composer.lock`, `Gemfile.lock`, `*.min.js`,
`*.min.css`, `*.snap` and `*.map`. An entry is a file name, a path, or a pattern with `*`
(which also matches `/`). One without a `/` matches a file of that name in any folder; one with
a `/` is a path from the repository's root. **A list of your own replaces the default one**, so
to add generated files, repeat the defaults you want to keep.

## The comment

The Action writes the figures to the run's summary page and posts them as one comment on the
pull request, which it keeps up to date and never repeats: it finds its own comment by a
hidden marker and changes it only when the figures did. A figure on every pull request changes
how people feel about being measured, so it is yours to switch off: `comment: false`.

The comment has: the share of added lines an agent wrote; lines added and lines by an agent;
the lines per tool and model; for a pull request reported since it was opened, how many of the
agent's lines from then are still there; and a note when a cloud agent worked on it and no
session was captured.

Two things about it to know before you switch it on in a public repository:

- **Its heading is a link to your server's Pull requests page**, so the address given as `url`
  is shown on the pull request.
- **It shows Sessionly's mark**, an image from `www.sessionly.dev`, which GitHub fetches
  through its own image proxy.

## The Pull requests page

The **Pull requests** page (admins) then shows, for the period, repository and state chosen:

- per pull request: lines added, how many an agent wrote and with which tool and model, how
  many of the agent's lines survived review, review rounds, and review comments by people and
  by bots (CodeRabbit and the like);
- on a pull request's own page (its name in the list leads there): the sessions that wrote its
  lines, each a link to the session; its files, with how much of each an agent wrote; and its
  reviews and comments, counted apart for people, bots and the author, each with who, when,
  which line, and a link to it on GitHub. What reviews and comments say is not sent to the
  server and not stored;
- **by model**: the same summed, so you can see whose lines get through review as written and
  whose take several rounds.

**The list starts on merged pull requests.** Open and closed ones are there once you change the
state filter. The period goes by when a pull request was merged or closed, or for an open one
when it was opened.

**Figures that are behind.** A pull request's lines are matched to sessions when the Action
reports it, and again when a session that added some of them is uploaded later (the session was
still going when it was opened, the machine was offline): the server then matches the pull
requests of its repository that are open or were closed in the last two weeks (and not before
the session started), that its person committed to, five at most: those with most of its lines, now or from an
earlier upload. An upload that changes none of its lines, nor whose it is or where and when it
ran, matches nothing again. The page and the history say
so: one row for matching again until the next report, however many uploads it took. The comment on GitHub catches up at the next report. A session
uploaded to a server of version 0.6.3 or older, or for a pull request closed longer ago, is not
in the figures until it is matched again: **Match again** on
a pull request's page, or **Match these to sessions again** above the list, matches the lines as
last reported against the sessions the server holds now, without asking GitHub; the page says
when that was last done. What only GitHub knows (reviews, comments, the title, new commits)
comes with a report: run the workflow by hand for those. A pull request last reported to
a server of version 0.5.0 or older has to be reported once more before it can be matched again.

**History.** Under the figures, each time they moved, and when a newer Action reported them
as they were: when, what prompted the report, the
figures then, and why (new commits, fewer commits, a session uploaded since, a session no
longer matched, a newer Action and which version replaced which, a session whose lines
changed, or that it was matched again and nothing new turned up). A session named there
links to it. When the agent lines moved, the figure says what they were until this report.

## How to read it

- **A line is an agent's** when a session added that line to that file, the session is by
  someone who committed to the pull request, and it started at most 90 days before the pull
  request was opened. A session that ran in the cloud counts when it ran on the pull request's
  branch instead: there the commits are the agent's own. Everything else counts as not an
  agent's: people without Sessionly, sessions uploaded without line hashes, what a shell
  command changed on a person's machine where that is not
  [sure to be the agent's](shell-edits.md), generated files. So the agent share is a floor.
- **Who committed** is every author and committer address on the pull request's commits
  (GitHub's own `noreply@github.com` aside). A session is that person's when the email git was
  set up with on their machine is one of them; a session with no git email goes by the
  address of whoever uploaded it. A pull request whose commits carry no address at all is the
  exception: there every session in the repository counts.
- **A line that several sessions added** goes to the one that started last, and one line of a
  session accounts for one line of the pull request.
- **A common line**, one that three sessions or more added to the same file (an import,
  `display: flex;`), goes only to a session that also wrote a line of the pull request that is
  not common, or that added every line of a file of the pull request that has nothing but
  common lines. Otherwise it would go to an older session that once added it too, while the one
  that wrote it is not uploaded yet.
- **The file has to be the same one.** A session that worked in a worktree (a folder under
  `worktrees/` or `.worktrees/`, or a checkout elsewhere whose path ends with the file's path
  in the repository) is matched to the repository's file.
- **The repository** is known to a session by its clone's origin. The pull request's own
  repository, the fork its branch is in, and the names given as `other-names` are all tried.
- **Survived review** compares the pull request as it was opened with how it ended: of the
  agent's lines it had at the start, how many are still in it. It is only known for pull
  requests the Action saw being opened (or could reconstruct, see
  [below](#pull-requests-from-before-the-action)). A line that was reformatted counts as
  changed, unless only the whitespace at its ends did.
- **A review round** is review feedback (a review that comments or asks for changes, or a
  comment on the diff, from anyone but the author, bots included) followed by a new commit.
  An approval is not feedback, and neither is a comment in the conversation.
- **A bot** is an account GitHub itself calls one, or one whose name ends in `[bot]`.
- **A cloud agent's pull request** is recognised by who made its commits
  (`noreply@anthropic.com` for Claude Code, `cursoragent@cursor.com` for Cursor) and what its
  branch is called (`claude/…`, `ccr-<8 hex digits>-…`, `cursor/…`), or by a cloud session
  uploaded for its branch. If no session was captured for it, the page says so next to it: its
  lines then count as not an agent's, which is wrong in a way worth knowing about.
  [`sessionly install --repo`](cloud-sessions.md) in the repository fixes it for later ones.
- **Agent cost** is what the sessions matched to a pull request cost, each counted for its
  share: the session's cost times its lines in the pull request, divided by all the lines the
  session uploaded hashes of. A session that wrote into three pull requests is split between
  them and counted once, and what it spent on work that reached no pull request is in none.
  A line that is in several pull requests (one stacked on another, a release of what was
  merged before) is shared out between them, so it is still counted once; a pull request
  closed without merging takes nothing from the others, and its own cost is left out of the
  figures above the list unless only closed ones are shown; the tile says how many were. Which lines those are is kept from
  a report or a **Match again** made with this version on: until then, a pull request from
  before counts all its lines as its own, its cost is marked as an estimate where a session
  of it has lines in other pull requests, and what the lines it was opened with cost is not
  known. For a while after the upgrade the server is still counting the line hashes of the
  sessions it held, and a pull request of one not counted yet says so in place of a cost.
  Divided by what the lines of the sessions that have a cost figure count as, it gives the
  cost of an agent line: a line that is in two pull requests is half a line in each, at a
  whole line's price. Sessions with no cost figure are left out of it, so it reads "at least"
  only when a session's cost leaves out requests. The cost of a line that got through
  review, where that is known, is what the agent's lines the pull request was opened with
  cost, divided by those that survived. A line it was opened with together with another
  pull request costs half in each and counts as half a line in each, and it counts as
  surviving while either of them keeps it: between them it is one line, paid for once,
  wherever it ended up. So lines that moved from one pull request to another, or a stack
  of them that each kept only some, come out as they did for the session that wrote them.
  The summary of several pull requests divides what their opening lines cost by the lines
  that survived, each counted once; where that is not how many survived (a line in two of
  them is in each one's count), the "Agent lines that survived review" tile says what it
  is beside them, and why. A pull request none of whose agent lines survived has no figure
  of its own, but what they cost is in the summary's. For a pull request matched before
  this was kept, which lines of each session survived is not known: those are taken to be
  shared with other pull requests as the lines it was opened with were on the whole, until
  it is matched again. This one reads "at least" when a session of those lines has no cost figure, or
  not all of it. Both are marked `~` when the cost they come from is an estimate. A
  session's own share is marked `~` too when it may be counted in another pull request. A
  session that is deleted takes its lines with it: the pull request keeps how many
  it had, not which. Three things to read with it. It is **the cost of the matched
  sessions, not of making the pull request**: lines that are not an agent's carry none. It
  is **a floor** when a session has no cost figure, has one that leaves out requests to
  models without a known price, or was deleted since, and then reads "at least"; the total
  above the list is one too when a pull request with agent lines was last reported before
  its sessions were kept. And it is **an estimate**, marked `~`, when any of
  those sessions' costs is. The figure is worked out when the page is read, from what the
  sessions cost now. The Action's comment does not show it.
- **By model is a description, not a ranking.** Harder work goes to stronger models, a pull
  request with two models counts under both, and a handful of pull requests says little.
- The model is known per line for Claude Code, and for Cursor turns the hooks saw; otherwise
  the session's main model stands in, or it is shown as not known.

## Pull requests from before the Action

GitHub offers a run you start yourself only when the workflow on the default branch has
`workflow_dispatch`. That is how a merged pull request is reported again after the Action's
version changes: give its number, and leave `backfill` off, because the server already has its
first report. The same run, with `backfill`, reports a pull request from before the Action was
added, as it was when opened:

```yaml
on:
  workflow_dispatch:
    inputs:
      number:
        required: true
jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      contents: read   # backfill compares commits
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}
          pr-number: ${{ inputs.number }}
          backfill: true
          comment: false
```

With `backfill`, the Action first reports the pull request as it was when it was opened: its
commits up to a minute after that time, and the files they changed. The server keeps the first
report it gets of a pull request, so this changes nothing for one it already knows. Where it
does not work:

- **After a rebase or a squash of the branch**, the commits all carry a later date and no
  longer say what was there at the start.
- **When nothing was pushed after the pull request was opened**, no report "as opened" is
  made, and the pull request's survived-review figure is shown as not known, although it is
  as it was opened.

**Several in one run.** `pr-number` also takes `all`, for the pull requests created since
`since` (90 days ago unless given), the latest first, or a range such as `20-60`. One run
reports at most 100; when there are more, its warning names the range to give next, which
holds the rest of them and none from before `since`. A range you write yourself takes no notice
of `since`. When GitHub allows the run no more requests, it stops and names the range to give
later.
Such a run posts no comments, and a number in a range that is an issue is passed over.

## What is sent

To the Sessionly server, for the pull request: repository, number, title, link, who opened it,
state and dates, the email addresses on its commits (used to pick whose sessions count; the
server keeps a hash of each, not the address), counts of commits, reviews and review comments, and per changed file its path and a
hash of each added line that has a letter or digit (the first 8 bytes of the SHA-256 of the
line without the whitespace at its ends, as the `sessionly` binary makes them).

For each review and comment: who made it (their GitHub login, and whether that is a bot), when,
the file and line it is on, a review's outcome, and its link on GitHub, which is what the
pull request's page in the dashboard leads to. What a review or comment says is never sent.

Limits: a report has at most 5000 files and 500 commit addresses. Of reviews and comments the
latest 2000 are kept, and the pull request's page says when there were more. A changed file
that GitHub gives no diff for (it is too large) is not counted; the comment and the page say
how many there were.

The endpoints behind all of this are in the [API reference](api.md#pull-requests).
