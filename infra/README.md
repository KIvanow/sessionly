# Hosting Sessionly for many organisations

This folder runs Sessionly as a service anyone can sign up to: copies of the server behind
[Caddy](https://caddyserver.com), with a managed Postgres for the data. One team hosting for
itself does not need any of this: the `docker-compose.yml` at the top of the repository is for
that.

What a hosted service is, in the server's terms: `SESSIONLY_HOSTED=true`. Signing up creates an
organisation, each organisation sees only its own rows (every query names it, and Postgres
row-level security enforces it underneath), people sign in by a link sent to their address,
and there is no admin of everything.

## What you need

- **A machine with Docker**, reachable on ports 80 and 443. 2 vCPU and 4 GB is plenty to
  start with; the server is two small Node processes.
- **A domain name** pointing at it, for example `app.example.com`. Caddy gets its certificate
  from Let's Encrypt on the first start, which needs the DNS to be right already.
- **A managed Postgres**, version 16 or later, in the same region. The server connects as the
  role the provider gives you, which must be allowed to create a role (`CREATEROLE`): the
  first start makes `sessionly_app`, the role every request runs as.
- **An SMTP account** for the sign-in links. Many cloud providers block outgoing ports 25, 465
  and 587 on new accounts; mail providers offer another port (often 2525 or 2587) for this.

## First start

```sh
git clone https://github.com/KIvanow/sessionly /opt/sessionly
cd /opt/sessionly/infra
cp .env.example .env && chmod 600 .env
$EDITOR .env
docker compose --env-file .env -f docker-compose.hosted.yml up -d --build --wait
```

`--build` builds the image from the checkout. To run a published release instead, set
`SESSIONLY_VERSION` in `.env` to its tag and leave `--build` out; the image is
`ghcr.io/kivanow/sessionly-server`.

Then check it:

```sh
curl -s https://app.example.com/readyz             # {"ok":true}: it reaches its database
curl -s https://app.example.com/api/v1/auth/options
```

Open `https://app.example.com`, choose "Create an organisation", and use the link that
arrives. You are that organisation's owner. The first page is how to connect a machine.

### The database address

Give the server the provider's certificate authority, so the connection is verified:

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB?sslmode=verify-full&sslrootcert=/etc/sessionly/db-ca.crt
DATABASE_CA_FILE=/opt/sessionly/infra/ca-certificate.crt
```

`DATABASE_CA_FILE` is the file on the machine; the compose file mounts it where the address
says. Without the authority, `sslmode=require` fails against a provider that signs with its
own (the server's Postgres client verifies the certificate either way), and
`sslmode=no-verify` encrypts without checking who it is talking to.

Either of the provider's ports works: the direct one, or a connection pool in transaction
mode. Everything the server does per request is inside one transaction, and migrations take a
lock that ends with theirs. Each copy of the server keeps at most `SESSIONLY_DB_POOL`
connections; copies times that must stay under what the database allows.

Restrict the database to the machine (a "trusted source", or a firewall rule), so the address
alone is not enough to reach it.

## Settings

All in `infra/.env`; `.env.example` describes each. The ones that decide who gets in:

| Setting | Meaning |
|---|---|
| `SESSIONLY_SIGNUP` | `open`: anyone can create an organisation. `off`: nobody can; the ones that exist carry on. |
| `SESSIONLY_SIGNUP_CODE` | If set, signing up needs this code as well: a waiting list, or invitations. |
| `SESSIONLY_RATE_PER_MINUTE` | Requests one token may make a minute (default 600). |

Limits that are not settings: 5 requests for a link a minute from one address, 5 links an hour
to one address, 20 uses of a link a minute from one address.

A hosted service refuses to start with `SESSIONLY_ADMIN_TOKEN` set, without Postgres, or
without the mail settings, and says which.

## Updating

```sh
cd /opt/sessionly && git pull
cd infra && docker compose --env-file .env -f docker-compose.hosted.yml up -d --build --wait
```

Compose replaces the copies of the server and waits until they answer. New migrations run at
start, in one transaction, and only add things: to go back, run the version before.

## What is kept where

- **Everything of value is in Postgres.** Use the provider's backups and point-in-time
  recovery, and try a restore before you need one.
- **The machine keeps** Caddy's certificates (the `caddy-data` volume) and `.env`. Losing the
  volume only means new certificates.
- **Logs** are the containers' own (`docker compose logs server`). The server writes no log of
  requests; errors go to standard error. A message that could not be sent is logged with the
  address's domain only, never the link.

## Not built yet

- **Plans, quotas and billing.** Every organisation is unlimited.
- **Deleting an organisation and exporting its data** from the dashboard. An operator can
  delete one in the database: `DELETE FROM orgs WHERE id = '…'` takes everything of it along.
- **A deploy job.** Updating is the commands above, by hand.

## Checked, and not

Checked here: the whole test suite on Postgres 17 as a role that is not a superuser, signing
up and connecting a machine against a local Postgres, and that the compose file is valid.
Not checked: this stack on a real machine with a real managed database, a real mail provider,
and Caddy getting a certificate.
