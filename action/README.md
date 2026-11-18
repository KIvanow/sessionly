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
| `pr-number` | | The pull request to report, when the workflow was not started by one. |
| `fail-on-error` | `false` | Fail the job if the report cannot be made or sent. |

Outputs: `lines` (tracked lines the pull request adds) and `agent-lines` (how many a coding
agent wrote).

## Pull requests from before the Action

A manually started workflow can report existing pull requests one at a time:

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

## What is sent

To the Sessionly server, for the pull request: repository, number, title, link, who opened it,
state and dates, the email addresses on its commits (used to pick whose sessions count, not
stored), counts of commits, reviews and review comments, and per changed file its path and a
hash of each added line that has a letter or digit.

For each review and comment: who made it (their GitHub login, and whether that is a bot), when,
the file and line it is on, a review's outcome, and its link on GitHub, which is what the
pull request's page in the dashboard leads to. What a review or comment says is never sent.

Nothing else, and nothing to anyone else.

## Develop

Plain JavaScript with no dependencies and no build step: `src/main.mjs` is what runs.
`pnpm test` (or `node --test "test/*.test.mjs"`) runs the tests. `test/line-hashes.json` holds
lines and the hash each must get; the sessionly binary is tested against the same file, since
the two have to agree.
