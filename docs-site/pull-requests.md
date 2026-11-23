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

## After merge

What review left is not the end of it: code is reworked after it is merged too. So a merged
pull request's agent lines are counted again on the branch it was merged into, **7 days and
30 days after the merge**. The server holds only hashes and cannot see that branch, so the
Action does the looking, on a schedule:

```yaml
on:
  schedule:
    - cron: "17 5 * * *"   # once a day
jobs:
  after-merge:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: read   # to read the files as they are on the branch
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}
```

Put it in the same workflow file as the report, with `if: github.event_name != 'schedule'` on
the report's job, or in a file of its own. A run started by a schedule, with no `pr-number`, does this and reports
no pull request; `after-merge: true` does the same in a run started any other way.

A scheduled run was chosen over a run on every push to the default branch because it is one
run a day whatever the repository's traffic, and it still happens in a week when nothing is
pushed. A push would start a run for every merge, most of which have nothing due.

Each run asks the server which merged pull requests are due, and for each the files its agent
lines are in. It reads those files as they are on the branch now, all at the one commit the
branch is at, and sends their lines as hashes; the server counts how many of the pull request's agent lines are in the same files.
No source leaves GitHub, and the server sends no hashes out.

- **The first count at or after each age is kept, and never changed.** If no run happened on
  day 7, the next one stands for it and records how old the merge really was.
- **Nothing is made up for the past.** An age a pull request reached before the server began
  counting (when it was updated to a version that does, or when its organisation was created) is not counted. One merged 20
  days before that gets its 30 days and not its 7.
- **Only lines whose sessions are kept.** The lines of a session deleted since cannot be told
  from anyone's, and are left out of both numbers.
- **By file, as the rewrite rate.** A line counts when it is in the same file, anywhere in it.
  A file that was renamed or deleted has none of its lines left.
- If the branch it was merged into is gone (others were stacked on it, and it was merged and
  deleted itself), the repository's default branch is read instead.
- Files are read fifty at a time, so a pull request of thousands of files takes tens of
  requests to GitHub. A run reads at most 20,000 files; the pull requests left over are still
  due at the next run.
- **Known limit: a very large pull request is not counted.** The files' lines go to the server in
  one request, which takes 32 MB at most: about 1.7 million tracked lines in the files the
  agents changed. Above that the server refuses it, nothing is kept, and each scheduled run
  reads the files again and warns that the pull request could not be counted. There is no way
  around it yet.

On the pull request's page the counts are rows of **History** ("30 days after merge: 498 of
520 agent lines still there"), and the tile **Kept @30d after merge** has the share.

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
| `after-merge` | `false` | Count merged pull requests' agent lines again, 7 and 30 days after merging. A run started by a schedule, with no `pr-number`, does this without it. See [After merge](#after-merge). |
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
The counts [after merge](#after-merge) are rows here too, and stay however many reports follow.

## Review runs

A pull request's page has, beside its reviews on GitHub, the review commands run in its
sessions before and during review (`/code-review` and the like; see
[Review runs](session-record.md#review-runs)): how many, at which effort, how many in the
cloud, the findings they reported, and what their subagents cost. They are of:

1. the sessions matched to it, and
2. sessions of its repository (or its fork, or an old name of it) with a run that names its
   number, a review-only session with no line in it too, and
3. sessions of its repository on its branch, for runs that name no pull request: a review
   there is work on this pull request. Codex's `/review` never names one. A run made after
   the pull request was merged or closed is left out, since a branch's name can be used
   again, and so is a branch that is the one the pull request merges into.

The page lists each run in the order they ran, as the pull request's iterations: run 2 of
5, how long after the one before it, its effort, cost and findings, and the session it ran
in.

A run that names another pull request is that one's, and each run counts once. A matched
session with a run that names none, matched to other pull requests too, gives that run to
each of them, and the page says so. The two sides are not added up: a run in a session and a
bot's comments are different things. The cost of the runs is part of their sessions' cost,
not on top of it, and is a floor: their subagents only. It is not a part of the pull
request's cost that the two can be set against: that one is each matched session's share
by its lines, and a session that only reviewed is not in it at all. A review in the cloud
is billed apart and has none. The list has a Local column, and **by model** the runs per
pull request. A matched session that was deleted since, or that came from a Sessionly that
did not count review runs, is said to be not known.

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
- **Agent cost** is what was spent getting the pull request to where it is, not what the lines
  it still has cost. Every session that gave it lines at any time, when it was opened or in a
  later push, is charged to it, and stays charged when review takes those lines out again: a
  $10 session charged to this pull request alone, all of whose lines went in review, still
  cost the pull request $10. So the cost
  does not shrink during review, rewrites on the way to a few lines are in it, and so is a
  session that only pushed review fixes.
  - **Two figures.** The headline is everything spent, review rounds included. Under it,
    where they differ, is what the **first version** cost: what the sessions with lines among
    those the pull request was opened with are charged. A session that only pushed fixes
    afterwards is in the first figure and not in the second. A session that both opened it and
    fixed it up is in the second whole: the two are told apart by session, not by push.
  - **A session in several pull requests** is split between them by the lines it gave each,
    and counted once: six lines in one and four in another is $6 and $4 of a $10 session. A
    line that is in several (one stacked on another, a release of what was merged before)
    counts in the one that **had it first**, and a later one is charged only for the lines
    that are new in it: a release pull request of work that earlier ones brought is charged
    nothing for it, and takes nothing from them. The one that had it first is taken to be
    the one merged first, and of those still open the one opened first: a line gets from
    one pull request into another by the first being merged into the other's branch. A
    pull request **closed without merging** comes after all of those: when it is done
    again as another, the new one is charged for the lines, and the closed one keeps only
    what was spent on lines that no merged or open pull request has. The split does not move when
    review removes lines or when a file is renamed.
    It moves when the session gives a pull request more lines, is uploaded with another
    cost or is deleted, when a pull request's head or base branch changes, when a line
    still in a pull request turns out to be another session's, uploaded later, and when the
    order of two pull requests that share lines changes: one of two open ones is merged or
    closed without merging, or one that was merged earlier is reported after the others
    (a backfill).
  - **Having lines in the pull request is what makes a session pay for it**, whatever branch
    it began on. Codex, Grok and a Cursor cloud agent name one branch for a whole session (a
    local Cursor session names none), and that is often the branch the session started on
    and not the one its work ended up on: so the **whole session** is charged to the pull
    requests it gave lines to. **This is a known limit**: other work done in the same
    session is charged to them too.
  - **For Claude Code, other branches' work is left out.** It says which branch was checked
    out at every turn, so a pull request is charged what was spent on its own branch, and
    what was spent on the branch it is based on: the planning on `main` that led to it is
    part of what it cost. The record says how much was spent on a branch and not when, so
    this is **all** the session spent on the base branch, whether before the pull request's
    own branch was made or after: unrelated work done on `main` in the same session is
    charged too, shared between the session's pull requests that are based on it. A branch
    can be one pull request's own and the base of others. Where its own pull request was
    opened first (the others are stacked on it), what was spent there is that one's. Where
    the others were opened first (a release from `develop` of what they brought), it was
    spent on them, and is shared by lines between all of them: the release is charged for
    the lines that are new in it, and nothing moves off the others when it appears. What
    the session spent on any other branch is that branch's pull request's, or no one's.
    What it spent while no branch was named is shared between all its pull requests by
    lines: a missing name says nothing of where the work went. When a session has lines
    in a pull request and spent nothing on that pull request's own branch (the branch was
    renamed before it was pushed, say, a detached checkout, or the lines were picked onto
    another), the branch names are what is off there, not the work: that pull request is
    charged as the other agents' sessions are, its share of the whole session by lines, or
    what was spent on its base where that is more, while the session's other pull requests
    are still charged what their branches say. (Where that comes to more than the session
    cost, all are brought down alike.) A report from an Action too old to say what
    the pull request is based on is taken to be based on `main` or `master`. A Claude Code
    session uploaded before turns were kept by branch is charged whole, as the other
    agents' are, until its machine uploads it again.
  - **The cost of a line.** Divided by the agent lines the pull request has now (of the
    sessions that have a cost figure, a line that is in two pull requests counting in the
    one that had it first), the cost gives the cost of an agent line. The **cost of a line that got through
    review** is what the first version cost, divided by the lines of it that survived. Review
    removing lines lowers no cost: it leaves fewer lines to divide by, so this figure goes up.
    That is the sign of money that bought less. When no line of the first version is left
    there is no figure, and the tile says what those lines cost. A line that was opened in
    two pull requests is paid for in the one that had it first, and counts as surviving there
    while either keeps it: between them it is one line, paid for once, wherever it ended up. The summary of several pull requests divides what their first
    versions cost by the lines of them that survived, each counted once, which is the same
    sum each page does; where that is not how many survived (a line in two of them is in
    each one's count), the "Agent lines that survived review" tile says what it is beside
    them, and why.
  - **What a session gave a pull request** is kept on the server as the hashes of those
    lines, and review taking lines out does not make it less. There is no history of pushes: a line that went from the files
    stays with the session it was last put down to there, and which lines those are is kept
    beside the session's others. A line that is still in the files, or in the first report,
    follows the matching, so one put down to an older session before the session that wrote
    it was uploaded moves to that one when it arrives, and its charge with it. A session's
    own line that moved to another file, or whose file was renamed, is the same line and is
    not counted again. Pull requests from before this was kept are charged once after the upgrade, from the
    lines they have now and the lines they were opened with: lines that came and went
    between those were never kept, so a session that gave only such lines is not in them.
    Their costs are not frozen at what they were: they are worked out again under this rule,
    and for a while a pull request not charged yet says so in place of a cost.
  - **Known limits: the same line written by several sessions.** A line is known by its
    file and its text, so two copies of one line in one file cannot be told apart, and the
    server sees reports and uploads one at a time, not what happened between them. Where
    several sessions wrote the same line in the same file (a closing brace, an import), which
    of them keeps a copy that review took out can depend on what arrived first, the push or
    a session's upload, and on whether the copies went in one push or in several. None of
    this changes what a session cost. A line is counted for one session more or one fewer
    than wrote it, and with it a share of that session's cost moves between the pull
    requests the session is in; a session that gave only such a line may be left out of
    the pull request:
    - A session's line that review took out, and that another session then writes again in
      the same file: where the push arrives before that session is uploaded, the line is
      put down to the first session for a moment, and it no longer keeps the one that went.
    - A second copy of a line the pull request was opened with, taken out one push after
      the other: both stay the session's, and when a session uploaded later turns out to
      have written the opening line, that line is counted for both.
    - A line the pull request was opened with that the matching gives to one session, while
      the same line in the files is another's (the second began after it was opened): both
      count it while it is there, and the second does not keep it when it goes. The same
      holds where the opening line is no session's. Where the first session keeps an
      earlier copy of the line that went, the second does keep its own; if a third
      session then turns out to have written the opening line, the line is counted for
      all three, though the file never had it more than twice.
    - A session that moved a line it was opened with to another file, after which another
      session writes the same line where it was and that goes too: that copy is not kept.
    - A copy that review takes out in the very report that first puts a session's lines down
      to it (the session was uploaded after the push that brought them, and before the
      pull request was matched again) was never kept as that session's.
  - **Where the figures above the list stop.** A pull request closed without merging keeps
    its cost on its own page and is left out of the figures above the list, unless only
    closed ones are shown; the tile says how many were. The [Overview](dashboard.md) puts
    the same money in three places: pull requests that are merged or open, ones closed
    without merging, and no pull request at all.
  - **Three things to read with it.** It is **the cost of the matched sessions, not of
    making the pull request**: lines that are not an agent's carry none. It is **a floor**
    when a session has no cost figure, has one that leaves out requests to models without a
    known price, or was deleted since, and then reads "at least"; the total above the list
    is one too when a pull request with agent lines was last reported before its sessions
    were kept. And it is **an estimate**, marked `~`, when any of those sessions' costs is,
    or when a session is split with a pull request that did not keep which lines are whose
    (**Match again** there settles it). A session that is deleted takes its lines and its
    charge with it, from every pull request it was in: the pull request keeps how many lines
    it had, not which. The Action's comment does not show the cost.
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

For a count [after merge](#after-merge): the repository, the pull request's number, and for
each file the server asked about, its path and a hash of each of its lines as it is on the
branch now.

Limits: a report has at most 5000 files and 500 commit addresses. Of reviews and comments the
latest 2000 are kept, and the pull request's page says when there were more. A changed file
that GitHub gives no diff for (it is too large) is not counted; the comment and the page say
how many there were.

The endpoints behind all of this are in the [API reference](api.md#pull-requests).
