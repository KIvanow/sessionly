---
title: Server
nav_order: 8
has_children: true
---

# Server

The server receives uploads and serves the dashboard. Both are TypeScript: `apps/server` (Hono,
Postgres) and `apps/web` (React). The same code runs for one team on a machine of its own, as
described here, and as a hosted service many organisations sign up to, which
[`infra/`](https://github.com/KIvanow/sessionly/blob/main/infra/README.md) describes.

## Run it

From a checkout, with Node 22.18 or later and pnpm:

```sh
pnpm install
pnpm build      # builds the dashboard; the server then serves it
SESSIONLY_ADMIN_TOKEN=choose-a-long-secret SESSIONLY_ADMIN_EMAIL=you@example.com pnpm server
```

That starts it on `http://127.0.0.1:8080` with an embedded database in
`apps/server/data/pglite`, which is enough to try it or for a small team. Open that address and
sign in with the token. Set `DATABASE_URL=postgres://…` to use a Postgres server (16 or later).

Settings can also be kept in a file named `.env` at the top of the repository, one
`NAME=value` a line; `pnpm server` reads it, and git ignores it. All of them are in
[Configuration](server-configuration.md).

Then, on a developer's machine:

```sh
sessionly connect http://127.0.0.1:8080   # paste the token, or pass it with --token
sessionly upload
```

## With Docker

The server and Postgres together:

```sh
SESSIONLY_ADMIN_TOKEN=choose-a-long-secret docker compose up -d
```

It listens on port 8080 of the machine; `SESSIONLY_PORT` names another. The compose file hands
the container the admin token and address, the public address, the Google and GitHub settings,
the two page-count settings and the four `SESSIONLY_DEMO_*` settings (see
[Server configuration](server-configuration.md#showing-a-repository-in-another-organisation)),
from the environment or from a `.env` file beside it. Other
settings (`SESSIONLY_DB_POOL`, `SESSIONLY_RATE_PER_MINUTE` and so on) have to be added to the
file's `environment:` list to reach the server.

Each release also has an image, `ghcr.io/kivanow/sessionly-server:v<version>`. It is the
[ee server](editions.md), which without a license behaves exactly like the core one.

## Before anyone else uses it

- **Put it behind HTTPS.** The `sessionly` binary refuses plain `http://` for anything but
  this machine (`localhost`, `127.0.0.1`, `[::1]`).
- **Decide how people get in**: a token an admin makes for each, or signing in with Google or
  GitHub. See [People, tokens and sign-in](people-and-tokens.md).
- **Know what the dashboard sends**: it counts which of its pages are opened, and
  `SESSIONLY_TELEMETRY=off` stops that. See [Dashboard](dashboard.md#page-counts).

## Running it

- **Health.** `GET /healthz` answers `{"ok":true}` while the server runs. `GET /readyz` asks
  the database first and answers 503 when it does not reply. Neither needs a token.
- **The database is brought up to date at every start**, in one transaction, so a new version
  needs nothing run by hand. If that fails the server says so and stops.
- **Nothing is deleted by age.** Sessions and pull requests stay until someone
  [stops a repository](uploading.md#stopping-a-repository) or a session is taken back.
  An organisation its owner deleted is removed after 7 days, and everything of it with
  that. The server does this once an hour. `pnpm org purge` does that pass now, and
  `pnpm org restore <id>` clears a deletion that has not been purged. The default
  organisation is never removed.
- **There is no request log.** Errors the server did not expect are printed, the first five
  in any ten seconds and then a count of the rest.
- **A request can be 32 MB at most**, which is far more than a session's upload.
- **A limit on requests** per token is off on a server of your own unless
  `SESSIONLY_RATE_PER_MINUTE` is set. Adding people is limited either way, to 30 an hour.
- **Stopping** it (`SIGINT`, `SIGTERM`) closes the server and its database connections first.

## What was checked

Checked with the real binary and one machine's history, against both the embedded database and
Postgres in Docker: 100 sessions uploaded in under three seconds, a repeat upload sent nothing,
and the server's totals equal the local `sessionly summary` exactly.
