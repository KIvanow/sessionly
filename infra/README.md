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
- **A managed Postgres**, version 16 or later, in the same region, with a database and a user
  for Sessionly. One statement has to be run in it by its admin before the first start: see
  [The database's role](#the-databases-role).
- **An SMTP account** for the sign-in links. Many cloud providers block outgoing ports 25, 465
  and 587 on new accounts; mail providers offer another port (often 2525 or 2587) for this.

## First start

```sh
git clone https://github.com/KIvanow/sessionly /opt/sessionly
cd /opt/sessionly/infra
cp .env.example .env && chmod 600 .env
$EDITOR .env
./update.sh --build
```

`update.sh` is how the service is started, updated, and given more or fewer copies; see
[Updating](#updating) for why not `docker compose up`. `--build` builds the image from the
checkout. To run a published release instead, set `SESSIONLY_VERSION` in `.env` to its tag and
leave `--build` out; the image is `ghcr.io/kivanow/sessionly-server`.

Then check it:

```sh
curl -s https://app.example.com/readyz             # {"ok":true}: it reaches its database
curl -s https://app.example.com/api/v1/auth/options
```

Open `https://app.example.com`, choose "Create an organisation", and use the link that
arrives. You are that organisation's owner. The first page is how to connect a machine.

### The database's role

Every request runs as a role of its own, which may see one organisation's rows at a time.
Each database has its own: `sessionly_app_` and 16 hex digits made from the database's name.
The server creates the role itself if its user may create roles. The user a managed
database's panel makes usually may not, so the admin does it once. On DigitalOcean, connect
as `doadmin` **to the database Sessionly will use** and run this, with Sessionly's user in
place of `sessionly` on the line that grants:

```sql
DO $$
DECLARE app text := 'sessionly_app_' || left(encode(sha256(convert_to(current_database(), 'UTF8')), 'hex'), 16);
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', app);
  END IF;
  EXECUTE format('GRANT %I TO %I', app, 'sessionly');
END $$;
```

It works out the role's name from the database it is run in, so it is the same text for any
database, and running it twice does no harm. If it has not been run, the server does not
start, and prints this same statement with its own user's name filled in. Nothing else in
the database needs an admin: the server's user owns the tables it makes.

The role goes with the database's name. After renaming the database, or restoring it under
another name, the server asks for the statement once more (or, if it may create roles, makes
the new role itself); it then grants the new role what the old one held here and takes that
from the old one. The role being one per database is also what keeps a second database on
the same cluster (a staging copy, say) apart: its user cannot take this one's role.

Postgres 16 is the oldest this runs on. Before 16, a user who may create roles can grant
itself any role of the cluster, this one included, and the server refuses to start there.

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

Limits that are not settings:

- 5 requests for a link a minute from one caller (an IPv6 caller is its /64), and 20 looks at
  or uses of a link.
- 5 sign-ups an hour asked for from one network (a /24, or a /48 of IPv6).
- 5 messages an hour to one mailbox to finish signing up, and 5 on being added to
  organisations. Only messages that go out are counted, and a mailbox is counted once however
  its address is spelt (`+tag`, and Gmail's dots).
- A link to sign in is not sent again while one that was asked for still works (15 minutes).
  So asking in someone's name gets them four messages an hour at most, and cannot leave them
  without a link that works.
- 100 sign-up messages an hour in all (`SESSIONLY_SIGNUPS_PER_HOUR`). The server logs a
  warning, once an hour, when this is reached: until the hour is over nobody can sign up.
- 30 people an hour added by one organisation.

These exist because the service sends mail on a stranger's word. No message carries what its
asker wrote: not a name, not an address, and an organisation's name only to someone who has
signed in to that organisation before. The page a link opens shows the organisation's name
and id and who added the address, and asks before going on. An organisation's name may not
contain what could make a link, or letters that are styled forms of other letters.

A hosted service refuses to start with `SESSIONLY_ADMIN_TOKEN` set, without Postgres, or
without the mail settings, and says which.

## Updating

```sh
cd /opt/sessionly && git pull
cd infra && ./update.sh --build      # or set SESSIONLY_VERSION in .env and run ./update.sh
```

`update.sh` starts new copies of the server beside the old ones. Once the new ones answer, it
tells Caddy to send to them, and only then stops the old, which finish what they were
answering. Nothing is refused in between. New migrations run at start, in one transaction,
and only add things: to go back, run the version before.

- **If the new copies do not come up** (within `SESSIONLY_UPDATE_WAIT` seconds, 180 unless
  set), it prints the last lines each one logged, removes them, and exits 1. The old copies
  were never touched and go on answering.
- **It can be run again from any state**: after a failure, or after a run that was cut short
  with old and new copies both running. It tells old from new by what a copy is (its image
  and its settings), not by when it started.
- **Changing `SESSIONLY_REPLICAS`** or any other setting in `.env` is the same command.
- **Caddy** takes up a changed `caddy/Caddyfile` without closing anything. It is replaced
  only when its image or its part of the compose file changed, which closes the front door
  for a few seconds.

Caddy sends to the copies named in `caddy/copies`, a file `update.sh` writes. It asks each
one every five seconds whether it can reach its database (`/readyz`) and sends nothing to
one that cannot. Caddy only asks copies it is given by name, which is why they are written
down and not found under the name they share. So **start, update and scale with
`update.sh`, not with `docker compose up`**, and run it again after `docker compose down`:
copies started behind its back are not in the file, and get nothing.

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

Checked here: the whole test suite on Postgres 16 and 17, both as a user who may create roles
and as one who may not (with the statement above run by an admin who is not a superuser);
signing up and connecting a machine against a local Postgres; and this stack on one machine,
where `update.sh` was run while requests kept arriving:

- replacing two copies, eight times: none of about 8,700 requests refused;
- to copies that exit at once, to copies that run and never answer, and to an image that
  cannot start, each twice in a row: exit 1, the old copies still answering, none refused;
- again after a run killed part-way, with old and new copies both running: none refused;
- from two copies to three and back; from nothing after `docker compose down`;
- a copy cut off from the database: Caddy stopped sending to it within its five seconds, and
  sent to it again once the database was back.

Not checked: a real managed database, a real mail provider, and Caddy getting a public
certificate.
