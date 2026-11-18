---
title: Configuration
nav_order: 1
parent: Server
---

# Server configuration

Everything is set through the environment, or through the `.env` file `pnpm server` reads.

## Settings

| Setting | Meaning |
|---|---|
| `PORT`, `HOST` | Where to listen. Default `127.0.0.1:8080`; the Docker image listens on `0.0.0.0`. |
| `DATABASE_URL` | `postgres://…` or `postgresql://…` (Postgres 16 or later), or unset for the embedded database (in `apps/server/data/pglite`; in the Docker image, `/data/pglite`). Anything else is taken as a folder to keep an embedded database in. |
| `SESSIONLY_DB_POOL` | Postgres only: connections kept at most. Default 10. |
| `SESSIONLY_DB_QUERY_SECONDS` | Postgres only: how long a statement may take. Default 30, and a day (86400) at most. |
| `SESSIONLY_ADMIN_TOKEN` | An admin token that always works, for first use. |
| `SESSIONLY_ADMIN_EMAIL` | Who uploads made with that token belong to. Default `admin@localhost`. |
| `SESSIONLY_PUBLIC_URL` | Where people reach the dashboard, e.g. `https://sessionly.example.com`: a scheme and a host, with no path, or the server does not start. Needed for signing in with Google or GitHub, which send people back there; open the dashboard at exactly this address. (A server on your own machine sends a browser at `127.0.0.1` on to `localhost`, or the other way; behind a proxy it sends nobody anywhere, whatever `Host` the proxy passes on.) Google takes a plain `http://` address only for `localhost`, `127.0.0.1` and `[::1]`. |
| `SESSIONLY_GOOGLE_CLIENT_ID`, `SESSIONLY_GOOGLE_CLIENT_SECRET` | Optional, both together: people then sign in with Google (see [People, tokens and sign-in](people-and-tokens.md)). From an OAuth client of type "Web application" in Google Cloud, whose redirect URI is the public address followed by `/api/v1/auth/google/callback`. |
| `SESSIONLY_GITHUB_CLIENT_ID`, `SESSIONLY_GITHUB_CLIENT_SECRET` | Optional, both together: people then sign in with GitHub. From an OAuth app on GitHub, whose callback URL is the public address followed by `/api/v1/auth/github/callback`. |
| `SESSIONLY_RATE_PER_MINUTE` | Requests a token may make in a minute; past that the answer is 429. Unset, a server of your own has no limit. |
| `SESSIONLY_TRUST_PROXY` | `true` when the server is behind a proxy of yours that sets `X-Forwarded-For`: the caller's address is then taken from it. Used only for the limits on signing in, which are per address. |
| `SESSIONLY_TELEMETRY`, `DO_NOT_TRACK` | `SESSIONLY_TELEMETRY=off` stops the dashboard counting its pages, and so does `DO_NOT_TRACK=1`. See [Dashboard](dashboard.md#page-counts). |
| `SESSIONLY_HOSTED` | `true` for a service many organisations sign up to. It has settings of its own (`SESSIONLY_SIGNUP`, `SESSIONLY_SIGNUP_CODE` and the sign-up limits): see [`infra/`](https://github.com/KIvanow/sessionly/blob/main/infra/README.md). |
| `SESSIONLY_ORG` | The ee server only: this install's org id. See [Editions and license](editions.md). |

What the server says at its start is worth reading once: it names a setting it could not use
(half of a Google or GitHub pair, a sign-in provider without a public address, a number that
is not one), and stops rather than start with a public address it cannot make sense of.

With Docker Compose only some of these reach the container: see [Server](server.md#with-docker).

## The database's user

Requests run as a second database role that cannot log in, which
the server makes at its first start; its name comes from the database's name. If the
database's user may not create roles (the one a managed database's panel makes usually may
not), the server stops and prints one statement for the database's admin to run. It asks
again if the database is later renamed, or restored under another name, because the role
goes with the name. Running the statement twice is harmless.

Upgrading a server from before organisations: it now needs Postgres 16 or later, and a
database user who may not create roles needs that statement run once, or the server does not
start (it says which). When restoring a dump into another database, use `pg_restore
--no-acl`: the grants in the dump are to the role of the old name, and the server makes its
own at the next start. A role of an old name that is left in the cluster holds nothing in
this database any more and can be dropped.

## A database that goes quiet

After a failover the old connections can stay open and
answer nothing. A statement that passes the limit is ended by the database, and a
connection that has not answered a fifth of the limit later is thrown away and replaced,
so the server finds the new database by itself, within the limit and that fifth. Bringing
the database up to date at a start is not limited. The two settings are whole numbers in
plain digits; anything else is said at the start and left out, and the default applies. There
is no way to have no limit: a number above a day is taken as a day, and said. (A number too
large for the database to hold, above 2147483647, is not a number to it at all: it is left
out like any other, and the limit is the default 30 seconds.)

The limits are set for each transaction, not for the connection, so a pooler in transaction
mode in front of Postgres works.
