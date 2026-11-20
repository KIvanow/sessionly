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
check the repository out. A problem (server down, token refused) is a warning on the run, not a
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
    steps:
      - uses: KIvanow/sessionly/action@main
        with:
          url: https://sessionly.example.com
          token: ${{ secrets.SESSIONLY_TOKEN }}
```

It needs `contents: read` and writes on no pull request. The files are read fifty at a time,
all at the commit the branch is at; a run reads at most 20,000, and what is left is due at the
next. See
[After merge](../docs-site/pull-requests.md#after-merge) for what is counted and how a missed
day is handled.

## What is sent

To the Sessionly server, for the pull request: repository, number, title, link, who opened it,
state and dates, the email addresses on its commits (used to pick whose sessions count; the
server stores a hash of each, not the address, so that the lines can be matched again when
sessions arrive later), counts of commits, reviews and review comments, and per changed file its path and a
hash of each added line that has a letter or digit.

For each review and comment: who made it (their GitHub login, and whether that is a bot), when,
the file and line it is on, a review's outcome, and its link on GitHub, which is what the
pull request's page in the dashboard leads to. What a review or comment says is never sent.

For a count after merge: the repository, the pull request's number, and for each file the
server asked about, its path and a hash of each of its lines as it is on the branch now.

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
