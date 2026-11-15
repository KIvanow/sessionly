# Hosting Sessionly for many organisations

This folder runs Sessionly as a service anyone can sign up to: copies of the server behind
[Caddy](https://caddyserver.com), with a managed Postgres for the data. One team hosting for
itself does not need any of this: the `docker-compose.yml` at the top of the repository is for
that.

What a hosted service is, in the server's terms: `SESSIONLY_HOSTED=true`. Signing up creates an
organisation, each organisation sees only its own rows (every query names it, and Postgres
row-level security enforces it underneath), people sign in with Google or GitHub, and there
is no admin of everything.

## What you need

- **A machine with Docker**, reachable on ports 80 and 443. 2 vCPU and 4 GB is plenty to
  start with; the server is two small Node processes.
- **A domain name** pointing at it, for example `app.example.com`. Caddy gets its certificate
  from Let's Encrypt on the first start, which needs the DNS to be right already.
- **A managed Postgres**, version 16 or later, in the same region, with a database and a user
  for Sessionly. One statement has to be run in it by its admin before the first start: see
  [The database's role](#the-databases-role).
- **A way for people to sign in**: Google, GitHub, or both. See
  [Signing in](#signing-in) for what to create at each. The server sends no email.

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

Open `https://app.example.com`, choose "Create an organisation", sign in with Google or
GitHub, and name it. You are that organisation's owner. The first page is how to connect a
machine.

### Signing in

Each provider gives an id and a secret for this server, and has to be told the one address
it may send people back to. With `app.example.com` as the domain:

- **Google.** In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
  create an OAuth client of type "Web application" with the authorised redirect URI
  `https://app.example.com/api/v1/auth/google/callback`. The consent screen needs only the
  `openid` and `email` scopes, and has to be published ("In production") for accounts outside
  your own to get in. Its id and secret are `SESSIONLY_GOOGLE_CLIENT_ID` and
  `SESSIONLY_GOOGLE_CLIENT_SECRET`.
- **GitHub.** Under Settings → Developer settings →
  [OAuth Apps](https://github.com/settings/developers), create an OAuth app with the
  authorization callback URL `https://app.example.com/api/v1/auth/github/callback`. Its id and
  a secret generated there are `SESSIONLY_GITHUB_CLIENT_ID` and
  `SESSIONLY_GITHUB_CLIENT_SECRET`.

All that is asked of either is which email addresses are the person's: Google's one address,
if Google has verified it, and every address GitHub has verified for a GitHub account (the
`user:email` scope). Nothing else of the account is read, and nothing of it is kept. A
person is known here by address: whoever signs in with an account that has an address is
who that address is in each organisation it was added to.

The browser carries one cookie, for the ten minutes at most between leaving for the provider
and coming back, so that only the browser that left is signed in. It is the only cookie the
service sets.

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

A statement may take `SESSIONLY_DB_QUERY_SECONDS` (30). The database ends one that passes
it, and a connection that has not answered a fifth of that later is thrown away and replaced.
That is what gets the service over a failover that leaves the old connections open and
silent: requests on them fail once, after 36 seconds at most, and the next ones are answered
by the new database, with nothing restarted. Bringing the database up to date is not limited.

Restrict the database to the machine (a "trusted source", or a firewall rule), so the address
alone is not enough to reach it.

## Settings

All in `infra/.env`; `.env.example` describes each. The ones that decide who gets in:

| Setting | Meaning |
|---|---|
| `SESSIONLY_SIGNUP` | `open`: anyone can create an organisation. `off`: nobody can; the ones that exist carry on. |
| `SESSIONLY_SIGNUP_CODE` | If set, signing up needs this code as well: a waiting list, or invitations. |
| `SESSIONLY_RATE_PER_MINUTE` | Requests one token may make a minute (default 600). |

A setting that is a count (this one, the two below, `SESSIONLY_DB_POOL`,
`SESSIONLY_DB_QUERY_SECONDS`) is a whole number above 0 in plain digits. Anything else
(`1e3`, `0x10`, `0.5`) is left out with a warning at the start, and the default applies.

Limits that are not settings:

- 20 times a minute off to a provider from one caller (an IPv6 caller is its /64), 20 times
  back, and 20 looks at or uses of what coming back gives.
- 10 organisations an hour created from one network, a /24 or a /48 of IPv6
  (`SESSIONLY_SIGNUPS_PER_NETWORK`). An office or a phone network shares one.
- 5 organisations an hour created by one address.
- 100 organisations an hour in all (`SESSIONLY_SIGNUPS_PER_HOUR`). The server logs a warning,
  once an hour, when this is reached: until the hour is over nobody can sign up.
- 30 people an hour added by one organisation.

An organisation costs its maker nothing, and anyone can add anyone's address to one of
theirs. So nobody is taken into an organisation they have not chosen: someone who signs in
is shown the organisations their addresses were added to (ten at most, the ones they have
signed in to before first), each with its name and id and who added them, and is asked. Who
added them is shown only if that was a person who had signed in, whose address is then their
own; someone added with a token is told so and no more, since a token's address and name are
whatever its maker typed. An organisation's name may not contain what could make a link, or
letters that are styled forms of other letters. Being added sends nobody anything.

A hosted service refuses to start with `SESSIONLY_ADMIN_TOKEN` set, without Postgres,
without its public address, or with neither Google nor GitHub set up, and says which.

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
  were never touched and go on answering. Copies that stop at once fail it in seconds.
- **It waits only for the copies it started itself**, and only those does it remove for not
  answering. When the database is away, running it changes nothing, and the copies there are
  answer again when the database is back.
- **Once enough new copies answer, every other copy goes**: the ones of the version before,
  and whatever an earlier run left behind, answering or not.
- **It can be run again from any state**: after a failure, or after a run that was killed
  with old and new copies both running, to the same version, the one before, or the next.
  It tells old from new by what a copy is (its image and its settings), not by when it
  started. Stopped with Ctrl-C, it removes what it started.
- **One run at a time.** A second `update.sh` started in this folder while one is at work
  is refused with a message and changes nothing. The lock (`.update.lock`, held with
  `flock`) is let go when the run ends, however it ends, so there is nothing to clear after
  one that was killed. If a killed run's last step is still finishing, the next run says so
  and waits for it, 20 seconds at most. Run it as the same user each time: after a run as
  root, another user's stops at once and says whose the files are.
- **Stopped or failed before Caddy was told**, by Ctrl-C, a signal or a step that fails, it
  removes what it started, also copies that `docker compose` was still making.
- **Copies that leave are asked to stop** and finish what they are answering, whether or not
  they were found well. One that has not stopped after `stop_grace_period` is ended.
- **A failed update does not undo migrations**, and old copies answer beside new ones while
  an update runs. So a migration must leave the version before it able to run: add, and
  remove only what the version before no longer reads.
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

### Moving from the old name

The stack is called `sessionly`. Before it had a name it took this folder's, `infra`, as any
other project in a folder of that name would, and the two would have been taken for one. A
stack that was started under the old name is not found under the new one, and `update.sh`
refuses to start a second beside it. Once, in this folder:

```sh
docker compose -p infra --env-file .env -f docker-compose.hosted.yml down   # the site is down from here
docker run --rm -v infra_caddy-data:/from -v sessionly_caddy-data:/to caddy:2.11.9 cp -a /from/. /to/
./update.sh                                                                # and up again
```

The second line keeps Caddy's certificate; without it Caddy asks for a new one at its start.
Compose then warns that it did not make that volume itself, and uses it all the same.
`docker volume rm infra_caddy-data infra_caddy-config` afterwards removes what is left.

## What is kept where

- **Everything of value is in Postgres.** Use the provider's backups and point-in-time
  recovery, and try a restore before you need one.
- **The machine keeps** Caddy's certificates (the `caddy-data` volume) and `.env`. Losing the
  volume only means new certificates.
- **Logs** are the containers' own (`docker compose logs server`). The server writes no log of
  requests; errors go to standard error. A sign-in that failed at Google or GitHub is logged
  with what the provider answered, never the code or an address.

## Not built yet

- **Plans, quotas and billing.** Every organisation is unlimited.
- **Deleting an organisation and exporting its data** from the dashboard. An operator can
  delete one in the database: `DELETE FROM orgs WHERE id = '…'` takes everything of it along.
- **A deploy job.** Updating is the commands above, by hand.
- **Inviting someone by a link.** A person is added by address, and has to sign in with a
  Google or GitHub account that has that address. Nothing tells them they were added.
- **Other ways to sign in**: Microsoft, or a company's own single sign-on.

## Checked, and not

Checked here: the whole test suite on Postgres 16 and 17, both as a user who may create roles
and as one who may not (with the statement above run by an admin who is not a superuser);
signing up and connecting a machine against a local Postgres; and this stack on one machine,
where `update.sh` was run while requests kept arriving:

- replacing two copies, eight times: none of about 7,000 requests refused;
- to copies that exit at once and to copies that run and never answer: exit 1, the old
  copies still answering, none refused;
- killed outright (`kill -9`) while waiting for an image whose copies never answer, and then
  run again to the same image (exit 1, nothing more left behind), to the image before, and
  to a newer one (both exit 0, with what the killed run left removed): none refused;
- killed part-way to a good image and run again; stopped part-way with a signal;
- from two copies to three and back; from nothing;
- a copy cut off from the database: Caddy stopped sending to it within its five seconds, and
  sent to it again once the database was back;
- every copy cut off from the database, and `update.sh` run meanwhile: exit 1, both copies
  left as they were, and answering again within seconds of the database coming back.

Signing in was checked against stand-ins for Google and GitHub that answer as their
documentation says they do, and through Google and GitHub themselves on one machine, at
`http://localhost:8080` against a local Postgres: creating an organisation with a Google
account, and signing in with a Google and with a GitHub account. Not checked: either of them
sending people back to a public address over HTTPS.

Not checked: a real managed database, and Caddy getting a public certificate.
