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
SESSIONLY_ADMIN_EMAIL=you@example.com pnpm run server
```

(`pnpm run server`, not `pnpm server`: that is a command of pnpm's own, which starts nothing
here.)

That starts it on `http://127.0.0.1:8080` with an embedded database in
`apps/server/data/pglite`, which is enough to try it or for a small team. Open that address:
the dashboard opens as its admin, `SESSIONLY_ADMIN_EMAIL`, with no signing in (see
[below](#nobody-signs-in)). Set `DATABASE_URL=postgres://…` to use a Postgres server (16 or
later).

Settings can also be kept in a file named `.env` at the top of the repository, one
`NAME=value` a line; `pnpm run server` reads it, and git ignores it. All of them are in
[Configuration](server-configuration.md).

Then make a token for each machine on the dashboard's Connect page, and on that machine:

```sh
sessionly connect http://127.0.0.1:8080 --token sly_…
sessionly upload
```

## With Docker

The server and Postgres together:

```sh
docker compose up -d
```

It listens on port 8080 of this machine only (`127.0.0.1`); `SESSIONLY_PORT` names another
port. For other machines to reach it, set `SESSIONLY_BIND` to an address of this machine they
can reach (`0.0.0.0` for all of them), on a network you trust: whoever reaches the port is its
admin (see [below](#nobody-signs-in)). The compose file hands
the container the admin's address and token, `SESSIONLY_PUBLIC_URL`, the two page-count settings and the four
`SESSIONLY_DEMO_*` settings (see
[Server configuration](server-configuration.md#showing-a-repository-in-another-organisation)),
from the environment or from a `.env` file beside it. Other
settings (`SESSIONLY_DB_POOL`, `SESSIONLY_RATE_PER_MINUTE` and so on) have to be added to the
file's `environment:` list to reach the server.

Each release also has an image, `ghcr.io/kivanow/sessionly-server:v<version>`. It is the
[ee server](editions.md), which without a license behaves exactly like the core one.

## Nobody signs in

A server of your own has no sign-in: whoever opens the dashboard is its admin, as
`SESSIONLY_ADMIN_EMAIL` (`admin@localhost` unless set). **Anyone who can reach the server can
therefore see every session and make tokens**, so keep it where only your team can reach it: on
this machine, a private network or a VPN, or behind a proxy that asks who is there.

The dashboard opens at `localhost`, at an IP address, or at the host of `SESSIONLY_PUBLIC_URL`.
Opened at any other name (`sessionly.internal`, or through a proxy), it says it could not be
opened until `SESSIONLY_PUBLIC_URL` is set to that address. That keeps a page of another site
whose name is made to point at this server from opening it.

A server from before this does not open without signing in, and says why when it starts, while:

- **`SESSIONLY_ADMIN_TOKEN` is set and it listens beyond this machine** (`HOST` other than
  `127.0.0.1` or `localhost`, as in the Docker image). Until now that token was the only way
  in, perhaps from anywhere. Set `SESSIONLY_OPEN_DASHBOARD=true` once whoever reaches it may
  be its admin; the token keeps working either way.
- **its Google or GitHub settings are still set.** It was signed in to, perhaps from the
  internet; take them out once whoever reaches it may be its admin.
- **it has members or viewers** (who see only part of it): people added when it had signing
  in, or anyone given a member's or viewer's token before (not the admin's own machines'
  tokens, under `SESSIONLY_ADMIN_EMAIL` or an admin's address). Each would otherwise become its
  admin. Open the dashboard with an admin token (`SESSIONLY_ADMIN_TOKEN`), and on the Team
  page remove them or revoke their tokens. A member's token made since does not count: it was
  made knowing that whoever reaches the server is its admin.

What is sent to it still takes a token: each machine connects with one made on the Connect or
Team page (see [People, tokens and sign-in](people-and-tokens.md)), and its sessions are filed
under that token's person. Signing in with Google or GitHub, and a dashboard where each person
sees only their own sessions, are the [hosted service's](https://app.sessionly.dev).

## Before anyone else uses it

- **Put it behind HTTPS.** The `sessionly` binary refuses plain `http://` for anything but
  this machine (`localhost`, `127.0.0.1`, `[::1]`).
- **Decide who can reach it**: anyone who can is its admin (see [above](#nobody-signs-in)).
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
