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

- **Google.** In the Google Cloud console, under
  [Google Auth Platform](https://console.cloud.google.com/auth/overview):
  - **Branding**: the app's name and a support address, which people see when they sign in.
  - **Audience**: "External". While its status is "Testing", only the test users listed
    there can sign in, a hundred at most; "In production" lets any Google account in. With
    the two scopes below, publishing needs no review by Google.
  - **Data access**: the scopes `openid` and `email`, and no others.
  - **Clients**: create an OAuth client of type "Web application" with the authorised
    redirect URI `https://app.example.com/api/v1/auth/google/callback`. Its id and secret are
    `SESSIONLY_GOOGLE_CLIENT_ID` and `SESSIONLY_GOOGLE_CLIENT_SECRET`.
- **GitHub.** Under Settings → Developer settings →
  [OAuth Apps](https://github.com/settings/developers), create an OAuth app with the
  authorization callback URL `https://app.example.com/api/v1/auth/github/callback`. Its id and
  a secret generated there are `SESSIONLY_GITHUB_CLIENT_ID` and
  `SESSIONLY_GITHUB_CLIENT_SECRET`.

What is asked of either is which account this is and which email addresses are its:
Google's one address, if Google has verified it, and every address GitHub has verified for a
GitHub account (the `user:email` scope). Nothing else of the account is read. What is kept
is the account's number (Google's `sub`, GitHub's user id), beside the person it signed in
as.

**Who an address is.** A person is added to an organisation by address, and the first
account that signs in to it under that address is from then on who that person is there. A
provider goes on vouching for an address long after it was verified: Google for an address
that is not its own, since the account was made; GitHub until its holder takes the address
off. So an address alone would let in whoever had it once. After the first sign-in it does
not: another account that has the address, of the same provider or the other, is told to
use the first one and is not let in.

When that account is gone (deleted and made again, or the person now uses the other
provider), someone else lets them in with another: an admin of the organisation, from its
Team page ("Let in with another account"), for anyone but themselves. For the owner that
takes an admin who has signed in: an admin token does it for anyone else, and not for the
owner, since a token says nothing of who holds it. An owner who is the only admin has
nobody to ask there, and whoever runs the service does it:

```sh
docker compose --env-file .env -f docker-compose.hosted.yml run --rm --no-deps -w /app/apps/server \
  server node src/cli.ts person forget-account --org acme-x7k2p9 --email owner@acme.example
```

(`person list --org …` shows who signs in with what.) Either way the person is then as
someone who was just added: whoever next signs in under their address is asked first, and
is that person from then on. Their sessions are ended; the tokens of their machines are not.
So do it for someone you know has lost the account, not on the word of a message from the
address. Each time it is done the server's log has a line saying for whom, in which
organisation, and by whom.

People who signed in before the account was kept (no release did that; a trial database
may have some) are treated the same way by the migration: asked as someone new at their
next sign-in, and never taken straight in.

What this does not cover is the first sign-in itself. Whoever a provider vouches for under
an address is taken to be its holder, so add people under addresses whose mailboxes are
theirs now, and remove a person when they leave. Which Google Workspace an account belongs
to (`hd`) is not looked at, and there is no rule that an organisation's people must come
from one.

**Cookies.** Two, both this host's alone (`__Host-`), not readable by scripts, and sent
only over HTTPS: one for the ten minutes at most between leaving for a provider and coming
back, so that only the browser that left is taken back; and one from coming back until the
person has chosen where to sign in, ten minutes at most, which is what carries the sign-in.
Nothing of it is in an address, so nothing of it is in a link, a history or a log. They are
the only cookies the service sets. A hosted service does not start unless its public address
is `https://`. The one exception is `http://localhost` (or `127.0.0.1`, `[::1]`), for trying
it on the machine it runs on; the cookies then have neither the prefix nor `Secure`.

**One address.** People sign in at `SESSIONLY_PUBLIC_URL` and nowhere else: a provider sends
them back there, and the cookies are kept for that host. So open the dashboard at exactly
that address. A server tried on its own machine has several names, and there the server
helps: with `http://localhost:8080` as the public address, a browser at
`http://127.0.0.1:8080` or `http://[::1]:8080` is sent on to the same page at `localhost`.
That is the only case in which it sends a browser anywhere: for any other host, and for
one of the machine's names on another port, it answers where it is asked.

That matters behind a proxy. Many pass on their own name for the server as `Host`, not the
one the browser asked for (nginx unless told `proxy_set_header Host $host;`, Apache without
`ProxyPreserveHost On`, a tunnel with a host override), and a server that went by it would
send every browser to the public address, to be handed straight back. The server does not
go by it, so such a proxy works as it is; passing the browser's `Host` on is still the
better setup, and is what the Caddyfile here does.

Google takes a plain `http://` address to send people back to only for this machine's own
names (`localhost`, `127.0.0.1`, `[::1]`); a server reached over plain HTTP under any other
name can offer GitHub alone.

What the dashboard asks while someone signs in is taken from the dashboard only: as JSON,
and from this very origin where the browser says where from. A page on a neighbouring host
of the same domain cannot create an organisation, or end a sign-in, in the name of someone
who has just signed in.

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
- 5 organisations an hour created by one address, and 20 owned by one person in all,
  counted by their addresses and by the account they signed in with.
- 100 organisations an hour in all (`SESSIONLY_SIGNUPS_PER_HOUR`). The server logs a warning,
  once an hour, when this is reached: until the hour is over nobody can sign up.
- 30 people an hour added by one organisation.
- 10 wrong invitation codes an hour from one network, and 10 by one account
  (`SESSIONLY_SIGNUP_CODE`). Past either, no code of theirs is looked at until the hour is
  over. Only someone who has signed in is told whether a code is right, and a try is counted
  before the code is looked at. Past 1,000 wrong ones an hour from everyone, the log says
  so once; nobody is refused for that, or one guesser could close signing up for all.

An organisation costs its maker nothing, and anyone can add anyone's address to one of
theirs. So nobody is taken into an organisation they have not chosen: someone who signs in
is shown the organisations they have signed in to before, and then the ones their addresses
were added to, the newest first and ten at a time with the rest a click away, each with its
name and id and who added them, and is asked. Adding an address to many organisations
beforehand, or afterwards, hides neither the ones a person is in nor the one they were just
told about. Someone in one organisation they have signed in to before goes straight in,
unless the browser is signed in somewhere already: then they are asked too. Who
added them is shown only if that was a person who had signed in, whose address is then their
own; someone added with a token is told so and no more, since a token's address and name are
whatever its maker typed. An organisation's name may not contain what could make a link, or
letters that are styled forms of other letters. Being added sends nobody anything.

A hosted service refuses to start with `SESSIONLY_ADMIN_TOKEN` set, without Postgres,
without a public address that is `https://` (or this machine's own, to try it), or with
neither Google nor GitHub set up, and says which.

**When signing in does not work.** The page says one of a few things, and the server's log
says why. "Not set up right" means the provider named a setting: `redirect_uri_mismatch`
(the address in the provider's settings is not the one above), `invalid_client` or
`incorrect_client_credentials` (the id or the secret), `admin_policy_enforced` (a Google
Workspace that does not allow the app). The log has the provider's own word and nothing
else of what it sent.

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
documentation says they do, and in a browser against a stand-in: a link to the page someone
comes back to, opened in another browser, signed in or not, does nothing there. It was then
tried through Google and GitHub themselves on one machine, at `http://localhost:8080`
against a local Postgres.

It runs this way at app.sessionly.dev: a DigitalOcean droplet and a managed Postgres 17, both
in Frankfurt. There, on the first start, `update.sh` (under dash, the system's `sh`) stopped
with the statement for the database's admin and removed what it had started; once `doadmin`
had run it, the next run came up, and Caddy got its certificate from Let's Encrypt. Checked
on that database: every table with an org column has row-level security on; a request with
no organisation set sees no rows; one organisation can neither read nor write another's; and
requests cannot read the sign-in codes or the counters. Checked from outside: only ports 80
and 443 answer, and the sign-in cookies are set with their `__Host-` names. Not checked there:
a failover of the database, and an update under load.
