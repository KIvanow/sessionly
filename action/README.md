# Sessionly pull request report

A GitHub Action that tells your [Sessionly](../README.md) server about a pull request each time
something happens to it. The server works out how much of it coding agents wrote, with which
tools and models, and how many of those lines made it through review.

It sends hashes of the lines the pull request adds, never the lines. See
[Pull requests](../docs-site/pull-requests.md) for how the figures are worked out and how to read
them.

## Use

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
      checks: read           # what CI said of the pull request's commits (see CI below)
      statuses: read
      actions: read          # which runs the push of the merge commit started
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}
```

1. On the server's Team page, create a token with the role **CI** and save it as the
   repository (or organization) secret `SESSIONLY_TOKEN`. A CI token can report pull requests
   and do nothing else.
2. Add the workflow above.
3. On each machine whose sessions should count, run `sessionly settings --line-hashes on`.

The job needs Node 20 or later on the runner, which GitHub's own runners have. It does not
check the repository out (only the scheduled job that reads later commits needs a checkout, see
[After merge](#after-merge)). A problem (server down, token refused) is a warning on the run, not a
failed check, unless you set `fail-on-error`.

Pull requests from forks get no secrets from GitHub, so the Action cannot report them; the run
shows a warning that the token is missing.

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required) | Address of your Sessionly server. |
| `token` | (required) | A Sessionly token with the `ci` role. |
| `github-token` | the workflow's token | Used to read the pull request, and to comment if that is on. |
| `summary` | `true` | Write the figures to the run's summary page. |
| `comment` | `true` | Post the figures as one comment on the pull request and keep it up to date, as other bots do. Needs `pull-requests: write`; without it the run warns and nothing else changes. `false` for no comment. |
| `ignore` | lock files, `*.min.js`, `*.min.css`, `*.snap`, `*.map` | Files to leave out, separated by commas or new lines: a file name, a path, or a pattern with `*`. A list of your own replaces the default one, so to add generated files, repeat the defaults you want to keep (they are in `action.yml`). |
| `other-names` | | Names clones of the repository may still have as their origin, as `owner/name`: for example from before it was renamed or moved to another owner. |
| `backfill` | `false` | For a pull request from before the Action was added: first report it as it was when opened, worked out from its commits, so what review changed can still be measured. Not possible after a rebase or squash of the branch. |
| `pr-number` | | The pull request to report, when the workflow was not started by one. Also `all` for the repository's latest, or `20-60` for those numbered from one to the other (see below). |
| `since` | 90 days ago | With `pr-number: all`, the date from which pull requests are reported, by when they were created. |
| `after-merge` | `false` | Count merged pull requests' agent lines again on the branch they were merged into, 7 and 30 days after. A run started by a schedule, with no `pr-number`, does this without it (see below). |
| `outcomes` | `true` | On a scheduled run, or one with `after-merge` and no `pr-number` (started by hand, say), also read the later commits on the branches merged pull requests went into, for 30 days after each merge. Needs a checkout with the whole history; `false` to count only after merge (see below). |
| `outcomes-since` | | With `outcomes`: also read those of pull requests merged on or after this date, though more than 30 days before the server began to. |
| `fix-words` | | Words that make a later commit a fix, separated by commas, in place of the default list. |
| `bug-labels` | | Words that make a linked issue's label a bug label, separated by commas, in place of the default list. |
| `ci` | `true` | Read what CI made of the pull request's commits: when it is reported, on `workflow_run`, and on the scheduled run. Needs `checks: read` and `statuses: read`, and `actions: read` for merge commits (see below). |
| `sessionly-workflows` | | Other workflow files that run the Sessionly Action, as paths from the repository's root (`.github/workflows/sessionly-nightly.yml`), separated by commas or new lines: their check runs are left out of the CI it reads too. This run's own file needs no naming. |
| `ci-ignore` | | Checks and statuses to leave out, by name, separated by commas or new lines; `*` stands for any text. Sessionly's own workflow runs are left out without being named. |
| `ci-only` | | Count only the checks and statuses named here (as `ci-ignore` names them). |
| `ci-check-names` | `false` | Also send the names of the checks that failed on a red commit (at most 20, each cut to 100 characters). Off by default: names can carry the names of clients, environments or systems. |
| `check-run-id` | the job's own | The id of this job's check run, which is left out of the CI it reads. The workflow run fills it in; leave it. |
| `fail-on-error` | `false` | Fail the job if the report cannot be made or sent. |

Outputs: `lines` (tracked lines the pull request adds) and `agent-lines` (how many a coding
agent wrote). A run that reports several (`all` or a range) sets neither: its figures, one
row for each pull request, are on the run's summary page.

## Pull requests from before the Action

A manually started workflow can report existing pull requests: one by its number, the latest
with `all`, or those numbered from one to another with `20-60`.

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
```

Reporting several is for bringing a repository up to date: after adding the Action, or after
updating it to a version that reports more than the one before. It differs from reporting one:

- **At most 100 in one run.** Each takes six requests to GitHub (eight with `backfill`), and a
  workflow's token is allowed a thousand an hour. `all` takes the latest 100 created since
  `since`; when there are more, the run's warning names the range to start it with next
  (`371-412`, say), which holds the rest of them and none from before `since`. A range you
  write yourself takes no notice of `since`.
- **Nothing is written on the pull requests.** No comment is posted or changed, whatever
  `comment` says. The run's summary page has one row for each.
- **One that cannot be reported does not stop the rest.** It is named in a warning and on the
  summary page, and the run fails at the end only with `fail-on-error`. When GitHub allows the
  run no more requests, it stops there and names the range to start it with later. It also
  stops when the Sessionly server refuses for a reason the next report would meet too (the
  token, too many requests, no answer): reading the rest from GitHub would be for nothing.
- In a range, numbers that belong to issues are passed over. A range with no pull request in
  it at all is said as a failure: in a private repository, a `github-token` without access to
  it is answered as if every number were an issue's.

Sessions that were uploaded after a pull request's last report need none of this: the server
matches the pull request again as one arrives that added some of its lines, and the Pull
requests page of the dashboard does it for any other without asking GitHub ("Match again"). The one
exception is a pull request last reported to a server of version 0.5.0 or older: it has to be
reported once more, and can be matched again from the dashboard from then on.

## After merge

A run started by a schedule, with no `pr-number`, reports no pull request. It asks the server which merged pull
requests have reached 7 or 30 days since merging, reads the files their agent lines are in as
they are on the branch now, and sends those files' lines as hashes. The server counts how many
of the agent lines are still there and keeps that as a row of the pull request's history.

```yaml
on:
  schedule:
    - cron: "17 5 * * *"
jobs:
  after-merge:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read   # which pull request a later commit came with
      issues: read          # the labels of the issues it closes
      checks: read          # what CI said of heads still pending, and of merge commits
      statuses: read
      actions: read         # which runs the push of a merge commit started
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # later commits are read from the history
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}
```

Counting after merge needs `contents: read`; reading later commits also needs the checkout
and `pull-requests: read` (and `issues: read` for the labels of linked issues; without it,
`bug_issue` is not known). It writes on no pull request. The files are read fifty at a time,
all at the commit the branch is at; a run reads at most 20,000, and what is left is due at the
next. A pull request whose files hold more lines than fit in one request to the server (32 MB,
about 1.7 million tracked lines) cannot be counted yet: the run warns of it each time. See
[After merge](../docs-site/pull-requests.md#after-merge) for what is counted and how a missed
day is handled.

The same run then reads later commits (the `outcomes` input, on by default). The server says
which merged pull requests have days of their first 30 not read yet, on which branch, and which
files. The run reads that branch's history with git, in the runner, and for each commit that
came after the merge and changed those files, sends the lines it removed and added there as
hashes, where it moved lines to, and what it is: its subject's fix words or `revert`, and for
the pull request it came with (one request each to GitHub), the branch name, the title's fix
words, the labels of the issues it closes, and which pull requests it says it reverts. The
server keeps the commits that changed a pull request's own lines, and says of each whether it
was a revert, a fix or rework.

A pull request is read from where the last run left it: the server keeps the commits the
branch was at, and the run reads what has come onto the branch since, whatever the commits'
own dates (a branch merged with a merge commit brings commits made days before; so does a push
of commits made earlier). A commit landed when the branch's own commit that brought it was
made: for a merged branch's commits, the merge commit. After a force-push of the branch, the
run reads by date once, and from where it is from then on.

- Without a checkout (a scheduled job set up before version 0.5.0 has none), the run notes that
  later commits were not read, asks the server for none, and does the rest: add the checkout
  and the permissions above, or set `outcomes: false`. A checkout without the run's commit (one
  an earlier job left on a self-hosted runner) is taken for none. With a checkout of only the
  latest commits, later commits are not read and the run says to add `fetch-depth: 0` or set
  `outcomes: false`: a warning, or a failed run with `fail-on-error`.
- When GitHub allows the run fewer than 100 more requests, or more than 2,000 commits are to
  be read whole, it stops there, and the next run goes on from there.
- Without `pull-requests: read`, the run warns once and reads later commits without what their
  pull requests say (no `fix_branch`, `fix_pr_title`, `revert_pr_title` or `bug_issue`).
- A branch that is not on GitHub any more (one others were stacked on, deleted once merged) is
  told to the server, which stops asking for the pull requests merged into it. One renamed
  since is read by its new name, and is gone when that is not in the checkout. One that is on
  GitHub but not in the checkout is warned of, and the server is told its pull requests were
  not read: it asks for them after the others from then on.
- A branch that cannot be read is warned of and told to the server the same way, the others
  are read, and the run fails at the end only with `fail-on-error`.

`outcomes-since` reads those of older pull requests too: later commits are history, so they can
be counted late, unlike the lines still there after merge. See
[Later commits](../docs-site/pull-requests.md#later-commits).

## CI

With `ci` on (the default) the Action reads what the checks and statuses on a commit came to,
and sends a state (`success`, `failure`, `pending` or `none`) and counts: how many failed, how
many there were, how many were cancelled. Never what ran or what it said; the names of the
checks that failed only with `ci-check-names: true`. The server keeps it for each head a pull
request was reported at (a red push), and for the commit it was merged as (the base branch red
after it), and says for each session whether CI was red where its lines arrived. See
[CI](../docs-site/pull-requests.md#ci) for how a commit is read as red, green, still running or
none to go by, and what the figures mean (linked, not caused).

A head is read whole; of a merge commit, GitHub Actions check runs count only for the workflow
runs its push started on the branch (a nightly run, a scan, or a release tag's push at the same
commit says nothing of the merge), other apps' check runs and statuses always. Skipped jobs never
count. A workflow run that never had jobs (waiting for approval, or failed to start) is read by
the workflow run itself. Sessionly's own runs are left out by workflow file: this run's, and
those `sessionly-workflows` names, which the Action tells by asking GitHub which workflow runs a
commit's checks are from (`actions: read`; without it only this job's own check run is left
out, and the run warns once). A Sessionly job in a workflow file with CI jobs has only the check
runs named as it left out of that file, and the run warns once: keep the Sessionly jobs in a
file of their own.

It is read three ways, each needing `checks: read` and `statuses: read`; without them the run
warns once and CI is not known, and nothing else is affected:

- **With a report.** After the report is sent, the head's checks, which are mostly still
  running, and those of the heads the server says are still pending from earlier pushes.
- **When your CI finishes.** A job on `workflow_run` of your CI workflows reads the CI of the
  commit that workflow ran on, and sends it for the pull requests the commit is in (asked of
  GitHub: of this repository, or of the fork for a fork's commit) and, when it is the commit a
  pull request was merged as and its push started the run, as its merge CI. It needs
  `pull-requests: read` for that question; without it, only the pull requests the event names
  are told. A fork's pull request gets this once it has been reported (`pull_request_target`,
  by hand, or `pr-number`). Nothing is reported on `workflow_run`.

  ```yaml
  on:
    workflow_run:
      workflows: [CI]
      types: [completed]
  jobs:
    ci-done:
      if: github.event_name == 'workflow_run'
      runs-on: ubuntu-latest
      permissions:
        checks: read
        statuses: read
        pull-requests: read
        actions: read
      steps:
        - uses: KIvanow/sessionly/action@main
          with:
            url: https://sessionly.example.com
            token: ${{ secrets.SESSIONLY_TOKEN }}
  ```

- **On the scheduled run**, apart from counting and later commits and needing no checkout: the
  heads still pending (reported in the last 7 days) and the merge commits of merged pull
  requests with agent lines not read yet, or read while still running, 50 of each a run.

This job's own check run is known by the `check-run-id` input, which the workflow run fills in
(or, given none, by the run's page). A problem reading or sending CI is a warning, and fails the
run only with `fail-on-error`.

## What is sent

To the Sessionly server, for the pull request: repository, number, title, link, who opened it,
state and dates, the email addresses on its commits (used to pick whose sessions count; the
server stores a hash of each, not the address, so that the lines can be matched again when
sessions arrive later), counts of commits, reviews and review comments, and per changed file its path and a
hash of each added line that has a letter or digit.

For each review and comment: who made it (their GitHub login, and whether that is a bot), when,
the file and line it is on, a review's outcome, and its link on GitHub, which is what the
pull request's page in the dashboard leads to. What a review or comment says is never sent.
For each round of review: the logins of those whose feedback it followed, and whether each is a
bot. They are the logins of reviews and comments as above (of all of them, also where a pull
request has more than the 2,000 that are sent); nothing else is said of a round.

For a count after merge: the repository, the pull request's number, and for each file the
server asked about, its path and a hash of each of its lines as it is on the branch now.

A report also names the pull request's head commit and, once merged, the commit it was merged
as (their SHAs). For later commits: each commit's SHA and the time it landed, the numbers of
the pull requests it belongs to and of those it says it reverts, the SHAs its message says it
reverts, which of the due pull requests it is a later commit of, and for the files the server
asked about (and where their lines moved: those paths too), a hash of each line it removed or
added. For each branch read: the SHA of the commit it was read at, and for each pull request
the SHAs of the commits it was read up to and the paths the server named for it; for a branch
deleted since or that could not be read, the numbers of the pull requests merged into it (the
server named them). What a commit is (a fix, a revert) goes as ids such as `fix_message` or
`bug_issue`: its message, the title, branch and body of its pull request, and the issues'
labels are read in the runner and never sent.

For CI: for each commit read, its SHA, a state, and how many checks and statuses failed, how
many there were, and how many were cancelled; the names of the checks that failed only with
`ci-check-names: true`, at most 20 of 100 characters. What ran, what it said, and the names
otherwise stay on GitHub.

The report also says it came from this Action and which version (`reporter`, the version in
`package.json`). Nothing else, and nothing to anyone else.

## Develop

Plain JavaScript with no dependencies and no build step: `src/main.mjs` is what runs.
`pnpm test` (or `node --test "test/*.test.mjs"`) runs the tests. `test/line-hashes.json` holds
lines and the hash each must get; the sessionly binary is tested against the same file, since
the two have to agree.

`version` in `package.json` is what a report names. Bump it with every change to what a report
contains, and set the same version as `CURRENT_ACTION` in `apps/server/src/pulls.ts`. A server
test fails when the two differ.
