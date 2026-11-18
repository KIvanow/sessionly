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
| `PUT /sessions/{machine_id}/{source}/{session_id}` | person, `env` | Stores or replaces one session. The body is the payload described under [What an upload contains](upload-contents.md). Answers `{"stored": true}`; `{"stored": false, "excluded": true}` for a repository its person stopped. `422` for a body that does not fit the schema (with the first five things wrong with it) or whose address is not the session's, `409` for a session that is someone else's. |
| `DELETE /sessions/{machine_id}/{source}/{session_id}` | person, `env` | Takes one back. Only the person a session is filed under can; the answer is `{"removed": true}`, or `false` if there was none of theirs. |
| `GET /sessions/{machine_id}/{source}/{session_id}` | person | One session: `owner_email`, `updated_at` and the `upload` as it was stored. `404` if it is not there or not theirs to see. |
| `GET /sessions` | person | A page of sessions, newest first: `{"sessions": […], "total": n}`. Takes the filters below and `limit` (50, at most 500) and `offset`. |
| `GET /sessions/held?machine={machine_id}` | person | The sessions of theirs the server has from one machine. |
| `GET /summary?by=…` | person | Totals, grouped by `user` (the default), `repo`, `model`, `tool`, `day` or `runtime`: `{"groups": […], "total": {…}}`. Takes the filters below. |
| `GET /files` | person | The files agents changed, with the filters below and `limit` (200, at most 2000). |
| `GET /filters` | person | What there is to choose from: users, repositories, models, tools, and where sessions ran. |

**Filters**, for `/sessions`, `/summary` and `/files`:

| Filter | Keeps sessions |
|---|---|
| `user`, `repo`, `model` | whose person, repository or models contain the text, in any case |
| `repo_is`, `model_is` | of exactly that repository, or with exactly that main model; `(unknown)` for those with none |
| `tool` | from one agent: `claude-code`, `cursor`, `grok` or `codex` |
| `runtime` | `cloud`, or `local` for those on people's machines |
| `q` | with the text in the title, repository, branch, session id, a prompt or a file's path |
| `since`, `until` | that started at or after `since`, and before `until`: a date or a time |

## Repositories a person stopped

| | Who | |
|---|---|---|
| `GET /repos/excluded` | person | The repositories the token's person stopped. |
| `PUT /repos/excluded` | person | Stops one: the body is `{"repo": "…"}`. Deletes the sessions that person already submitted from it, and says how many. |
| `DELETE /repos/excluded?repo=…` | person | Allows one again. |

How a repository is named, and what a path covers, is under
[Uploading](uploading.md#stopping-a-repository).

## Pull requests

| | Who | |
|---|---|---|
| `PUT /prs` | `ci`, `admin` | The [Action](pull-requests.md)'s report of one pull request. Answers `{"stored": true, "attribution": {…}}`, the figures the Action then shows. |
| `GET /prs` | `admin` | A page of pull requests. Filters `repo` (part of its name), `state` (`open`, `merged` or `closed`) and `since`; `limit` (50, at most 500) and `offset`. |
| `GET /prs/summary` | `admin` | The same pull requests summed by model. Same three filters. |
| `GET /prs/detail?repo=…&number=…` | `admin` | One pull request, with its files, the sessions that wrote its lines, and its reviews and comments. `repo` is its whole name. |
| `POST /prs/match` | `admin` | Match lines again against the sessions held now, without a report. With `repo` (its whole name) and `number`: one pull request, answered with its figures, or `409` with the code `needs_report` when it was last reported before that could be done. Otherwise the filters of `GET /prs`, for up to 100 at a time: send the answer's `started` back, with the same filters, until `remaining` is 0. Each pull request is matched and stored on its own; `failed` counts those of a request that could not be, which stay among the remaining. |

A report may name who sent it: `reporter`, `{ "name": "sessionly-action", "version": "0.2.0" }`.
The name is 1 to 50 characters. The version is three numbers of at most 9 digits each, or
those with a pre-release suffix such as `0.3.0-rc.1` (`0.10.0` counts; `v0.2.0`, `2024.11`
and `1.2.1000000000` do not). A version that does not fit is left out and the name is still
kept; a name that does not fit is left out altogether. The report is stored either way. The
version is kept only when the name is `sessionly-action`. The three numbers are compared, and
when they are equal a pre-release is older than the release. A pre-release of a higher version
is not an older Action. A `sessionly-action` version the server cannot read is not one either.
Another client's report is stored under its own name, and is not treated as an older Action.
A report that names no reporter still is: an Action from before this was sent.
`GET /prs` and `GET /prs/detail` give `reporter_version` (null when none was kept) and
`reporter_older`. `GET /prs/detail` also gives `reporter_current`, the version of the Action
this server knows, and `repo_reporter_older`: the newest pull request the Action reported,
or that named no reporter, came from an older Action. A pull request another client reported
is skipped, and a repository with no such pull request is not old. `repo_reporter_version` is
the version that pull request named, which is what the repository notice quotes. One current
report on an older pull request does not hide a newer one.
`GET /prs/summary` gives `older_actions`, the repositories in the filter for which that
newest pull request came from an older Action.

## Tokens and people

| | Who | |
|---|---|---|
| `GET /me` | person | Who the token is, and in which organisation. |
| `GET /me/tokens` | person | Their own tokens. |
| `POST /me/tokens` | person | A new `member` token for a machine of theirs: `{"name": "…"}`, optional. The token is in the answer, once. |
| `DELETE /me/tokens/{id}` | person | Revokes one of them. |
| `DELETE /auth/session` | person | Signs out: ends a sign-in made with Google or GitHub. |
| `GET /tokens` | `admin` | Every token of the organisation (never the tokens themselves). |
| `POST /tokens` | `admin` | A new token: `{"email": "…", "role": "member", "name": "…"}`. The role is `admin`, `member` (the default), `ci` or `env`. |
| `DELETE /tokens/{id}` | `admin` | Revokes one. |
| `GET /users` | `admin` | The people who may sign in. |
| `POST /users` | `admin` | Adds one: `{"email": "…", "role": "member"}`, the role `admin` or `member`. `409` where neither Google nor GitHub is set up, or for someone already there; 30 an hour at most. |
| `DELETE /users/{id}` | `admin` | Removes one. |
| `POST /users/{id}/forget-account` | `admin` | Lets a person in with another Google or GitHub account than the one they have used. |

## Without a token

| | |
|---|---|
| `GET /healthz` | `{"ok": true}` while the server runs. (Not under `/api/v1`.) |
| `GET /readyz` | The same once the database has answered; `503` if it does not. (Not under `/api/v1`.) |
| `GET /api/v1/auth/options` | How people can sign in here: the providers set up, and whether this is a hosted service. |
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
