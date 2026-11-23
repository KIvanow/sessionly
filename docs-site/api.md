---
title: API reference
nav_order: 4
parent: Server
---

# API reference

Everything the dashboard, the `sessionly` binary and the GitHub Action do goes through these
endpoints, under `/api/v1`. They take and answer JSON.

## Calling it

```sh
curl -H "Authorization: Bearer $SESSIONLY_TOKEN" https://sessionly.example.com/api/v1/ping
```

- A request without a token the server knows is answered `401`.
- What a token may call depends on its role (see
  [People, tokens and sign-in](people-and-tokens.md)): below, **person** means an `admin` or
  `member` token. A member's answers hold their own sessions only; an admin's, everyone's in
  the organisation.
- An error is `{"error": "…"}`, some with a `code` to tell them apart.
- A request body can be 32 MB at most (`413` past that).
- Where `SESSIONLY_RATE_PER_MINUTE` is set, a token that passes it gets `429` with the code
  `rate_limited`.

## Sessions

| | Who | |
|---|---|---|
| `GET /ping` | any token | Whether the token is accepted, with its organisation, address, name and role. |
| `PUT /sessions/{machine_id}/{source}/{session_id}` | person, `env` | Stores or replaces one session. The body is the payload described under [What an upload contains](upload-contents.md). Answers `{"stored": true}`; `{"stored": false, "excluded": true}` for a repository its person stopped. `403` with code `person_removed` when the address it is filed under belongs to someone who was removed: that session is refused, and a shared token goes on to the next. `422` for a body that does not fit the schema (with the first five things wrong with it) or whose address is not the session's, `409` for a session that is someone else's. |
| `DELETE /sessions/{machine_id}/{source}/{session_id}` | person, `env` | Takes one back. Only the person a session is filed under can; the answer is `{"removed": true}`, or `false` if there was none of theirs. |
| `GET /sessions/{machine_id}/{source}/{session_id}` | person | One session: `owner_email`, `updated_at` and the `upload` as it was stored. `404` if it is not there or not theirs to see. |
| `GET /sessions` | person | A page of sessions, newest first: `{"sessions": […], "total": n}`. Takes the filters below and `limit` (50, at most 500) and `offset`. Each has `review_runs`, null where they are not known: a session from a collector that did not count them, or a Codex session whose rollout was not read. |
| `GET /sessions/held?machine={machine_id}` | person | The sessions of theirs the server has from one machine. |
| `GET /summary?by=…` | person | Totals, grouped by `user` (the default), `repo`, `model`, `tool`, `day` or `runtime`: `{"groups": […], "total": {…}}`. Takes the filters below. Each has `cost_usd` and where it went: `in_pr_usd` (charged to pull requests that are merged or open), `closed_unmerged_usd` (to ones closed without merging) and `not_in_pr_usd` (to none). The three add up to `cost_usd`. `review_runs` sums the sessions' review runs, and `sessions_reviews_unknown` counts those whose review runs are not known: from a collector that did not count them, or a Codex session whose rollout was not read. |
| `GET /files` | person | The files agents changed, with the filters below and `limit` (200, at most 2000). |
| `GET /filters` | person | What there is to choose from: users, repositories, models, tools, and where sessions ran. |

**Filters**, for `/sessions`, `/summary` and `/files`:

| Filter | Keeps sessions |
|---|---|
| `user`, `repo`, `model` | whose person, repository or models contain the text, in any case |
| `user_is` | filed under exactly that address |
| `repo_is`, `model_is` | of exactly that repository, or with exactly that main model; `(unknown)` for those with none |
| `tool` | from one agent: `claude-code`, `cursor`, `grok` or `codex` |
| `runtime` | `cloud`, or `local` for those on people's machines |
| `q` | with the text in the title, repository, branch, session id, a prompt or a file's path |
| `since`, `until` | that started at or after `since`, and before `until`: a date or a time |

## Repositories a person stopped

| | Who | |
|---|---|---|
| `GET /repos/excluded` | person | The repositories the token's person stopped. |
| `PUT /repos/excluded` | person | Stops one: the body is `{"repo": "…"}`. Deletes the sessions that person already submitted from it, and says how many. A person who was removed is `403` (`person_removed`). |
| `DELETE /repos/excluded?repo=…` | person | Allows one again. A person who was removed is `403` (`person_removed`). |

How a repository is named, and what a path covers, is under
[Uploading](uploading.md#stopping-a-repository).

## Pull requests

| | Who | |
|---|---|---|
| `PUT /prs` | `ci`, `admin` | The [Action](pull-requests.md)'s report of one pull request. Answers `{"stored": true, "attribution": {…}}`, the figures the Action then shows. |
| `GET /prs` | `admin` | A page of pull requests. Filters `repo` (part of its name), `state` (`open`, `merged` or `closed`) and `since`; `limit` (50, at most 500) and `offset`. Each has `cost`: `usd`, everything spent on it by the sessions that gave it lines, review rounds included, and `opened_usd`, what its first version cost (see [how to read it](pull-requests.md#how-to-read-it)). Neither shrinks when review removes lines. Each has `local_reviews` too (see [Review runs](pull-requests.md#review-runs)). |
| `GET /prs/summary` | `admin` | The same pull requests summed by model, with `local_reviews` over `local_reviews_pulls`, the pull requests whose sessions all counted them. Same three filters. Its `total` has what was spent on them (`cost_usd`, null when none has a cost figure; those closed without merging are left out unless only they are asked for), and `per_surviving_line_usd`: the sum of their `opened_usd` over the lines of their first versions that survived, each counted once. |
| `GET /prs/detail?repo=…&number=…` | `admin` | One pull request, with its files, the sessions that wrote its lines, its reviews and comments, `history`, and `after_merge`: its agent lines as counted on its branch 7 and 30 days after merging, apart from the history of its reports. `repo` is its whole name. |
| `GET /prs/due?repo=…` | `ci`, `admin` | The merged pull requests of a repository whose agent lines are to be counted again on the branch they were merged into, 50 at most, as `{"due": [{number, base_ref, checkpoints, paths}]}`: the ages reached and not yet counted (`7d`, `30d`), and the files to read. See [After merge](pull-requests.md#after-merge). |
| `PUT /prs/after-merge` | `ci`, `admin` | `{repo, number, checkpoints, files}`: the ages the files were read for, as `GET /prs/due` named them (only those are kept), and each of those files as it is on the branch now, as a path and the hashes of its lines (none for a file that is gone). Answers `{"stored": […]}` with the counts kept, which is none when no age was due. `422` when a file asked for is left out, or the pull request is not merged. |
| `POST /prs/match` | `admin` | Match lines again against the sessions held now, without a report. With `repo` (its whole name) and `number`: one pull request, answered with its figures, or `409` with the code `needs_report` when it was last reported before that could be done. Otherwise the filters of `GET /prs`, for up to 100 at a time: send the answer's `started` back, with the same filters, until `remaining` is 0. Each pull request is matched and stored on its own; `failed` counts those of a request that could not be, which stay among the remaining. |

A report may name who sent it: `reporter`, `{ "name": "sessionly-action", "version": "0.2.0" }`.
The name is 1 to 50 characters. The version is three numbers of at most 9 digits each, or
those with a pre-release suffix such as `0.3.0-rc.1` (`0.10.0` counts; `v0.2.0`, `2024.11`
and `1.2.1000000000` do not). A version that does not fit is left out and the name is still
kept. A reporter that is present but does not fit is stored as `unknown`, which is not the
Action and is not treated as an older one. Only a report that leaves `reporter` out, or sends
null, is stored with no name. The report is stored either way. The version is kept only when
the name is `sessionly-action`. The three numbers are compared, and when they are equal a
pre-release is older than the release. A pre-release of a higher version is not an older
Action. A `sessionly-action` version the server cannot read is not one either. Another
client's report is stored under its own name, and is not treated as an older Action.
A report that names no reporter still is: an Action from before this was sent. A row stored
before a report said who sent it is marked with an empty name, which a client cannot send,
and is not judged.
`GET /prs/detail` gives `local_reviews.each` too: each review run of the pull request's
sessions, oldest first, with its time, command, effort, where it ran, how it went, cost, findings and the
session it ran in.

`GET /prs` and `GET /prs/detail` give `reporter_version` (null when none was kept) and
`reporter_older`. `GET /prs/detail` also gives `reporter_current`, the version of the Action
this server knows, and `repo_reporter_older`: the repository's most recent report from the
Action, or that named no reporter, is from an older Action, and none from the last 30 days
came from the current Action or a newer one. A pull request another client reported is
skipped, including one whose reporter did not fit, and a repository with no such report
is not old. `repo_reporter_version` is the version that most recent report named, which
is what the repository notice quotes. A current
report keeps the notice off for 30 days, whichever pull request it was, and a re-run of an
older one in that time does not bring it back.
`GET /prs/summary` gives `older_actions`, the repositories in the filter that report with an
older Action by that rule.

`history` on `GET /prs/detail` is the figures each time they moved, newest first, 50 at most.
A row is kept when the lines, the agent lines, the commits, or the set of sessions and their
line counts differ from the latest one, and when a newer Action reports the same figures.
Each row has `at`, `event` (`opened`, `synchronize`,
`review`, `closed`, `manual`, or `match` when the lines were matched again on the server),
`commits`, `lines`, `agent_lines`, `sessions` (each session's key and its lines, no hashes),
`reporter_version` (the version that produced that row), and `change` against the row before
it: the lines, agent lines and commits
before and after, `sessions_added`, `sessions_gone`, `sessions_changed`, and `reason`. The
reason is, in this order: new commits (`2 new commits`); fewer commits (`2 commits removed`);
sessions uploaded since (`1 session uploaded since: +17 agent lines`); sessions no longer
matched; a newer Action (`Action 0.2.0, was 0.1.0`, or `Action 0.2.0` when the one before
named no version); a session whose line count changed (`1 session's lines changed: +1 agent
lines`); otherwise `matched again, nothing new`. The first row's reason is null. A pull
request stored before
this was kept has one row, from the figures it had then. A report that only brings a newer
Action is a row of its own, and the row before it keeps the version that produced those figures.

## Tokens and people

| | Who | |
|---|---|---|
| `GET /me` | person | Who the token is, and in which organisation. `owner` is true when they signed in as the organisation's owner. A token for a machine is not an owner, even the owner's own. On a server that is not hosted, the admin token from the environment and the dashboard (`POST /auth/open`) are the owner and nobody else is; `opened` is true for the dashboard's. |
| `GET /me/tokens` | person | Their own tokens. |
| `POST /me/tokens` | person | A new `member` token for a machine of theirs: `{"name": "…"}`, optional. The token is in the answer, once. |
| `DELETE /me/tokens/{id}` | person | Revokes one of them. |
| `DELETE /auth/session` | person | Signs out: ends a sign-in made with Google or GitHub, or the session the dashboard of a server of your own opened with. |
| `GET /tokens` | `admin` | Every token of the organisation (never the tokens themselves). |
| `POST /tokens` | `admin` | A new token: `{"email": "…", "role": "member", "name": "…"}`. The role is `admin`, `member` (the default), `ci` or `env`. |
| `DELETE /tokens/{id}` | `admin` | Revokes one. |
| `GET /users` | `admin` | The people who may sign in. |
| `POST /users` | `admin` | Adds one: `{"email": "…", "role": "member"}`, the role `admin` or `member`. `409` where neither Google nor GitHub is set up (always, on a server that is not hosted), or for someone already there; 30 an hour at most. |
| `DELETE /users/{id}` | `admin` | Removes one. Their sessions stay. With `?data=true`, their sessions are deleted too, and so are the repositories they stopped; pull requests stay. A session filed under their address is not stored while they stay removed. |
| `DELETE /org` | owner, hosted | Deletes the organisation. The body is `{"name": "<the organisation's name>"}`. The wrong name is `400`. The right name is `204`: every token of the organisation is then `401`, and it is no longer offered at sign-in. The rows are removed after 7 days. Not offered on a server that is not hosted (`403`). |
| `POST /users/{id}/forget-account` | `admin` | Lets a person in with another Google or GitHub account than the one they have used. |
| `GET /export` | owner | The organisation as JSON lines (`application/x-ndjson`), a download named `sessionly-<org>-<date>.jsonl`. One line each for the organisation (with the time and the server's version), each person (no sign-in account ids), each session (its columns and the payload as uploaded), each pull request (every column), the lines each session has in a pull request, each earlier set of figures for a pull request, each stopped repository, and each token (never the hash). Once every ten minutes per organisation (`429`, code `rate_limited`). An admin or a member is `403`. A token for a machine is not an owner, even the owner's. On a server that is not hosted, the admin token from the environment is. |

## Without a token

| | |
|---|---|
| `GET /healthz` | `{"ok": true}` while the server runs. (Not under `/api/v1`.) |
| `GET /readyz` | The same once the database has answered; `503` if it does not. (Not under `/api/v1`.) |
| `GET /api/v1/auth/options` | How people can sign in here: the providers set up (on a hosted service only), whether this is a hosted service, and `noSignIn`, true where the dashboard opens without signing in. |
| `POST /api/v1/auth/open` | On a server that is not hosted, a session for the dashboard as its admin (`SESSIONLY_ADMIN_EMAIL`), which lasts a week: what the dashboard opens with, as nobody signs in there. Asked by the dashboard only, as JSON. `404` on a hosted service. |
| `GET /api/v1/telemetry` | What the dashboard needs to [count its pages](dashboard.md#page-counts), or `null` where that is off. |
| `/api/v1/auth/…` | The round trip of signing in with Google or GitHub, which the dashboard makes. Not for other callers. |

## The ee server

| | Who | |
|---|---|---|
| `GET /license` | person | The license's state. |
| `POST /license` | `admin` | Installs one: `{"license": "<the file's text>"}`. |
| `GET /policy` | person | The organisation's content policy. Needs a license with that feature. |
| `PUT /policy` | `admin` | Sets it: `{"content": "metadata"}` or `"previews"`. |

See [Editions and license](editions.md).

## The types

The payload types in `packages/schema` are generated from
[`schema/upload.schema.json`](https://github.com/KIvanow/sessionly/blob/main/schema/upload.schema.json), which is
generated from the Rust types. `pnpm gen` regenerates them and a test fails if they are stale.
A value of a field the schema gives a fixed set for (`status`, `outcome` and so on) that the
server does not know is accepted as it is.
