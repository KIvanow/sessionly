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
| `SESSIONLY_HASH_KEY` | 32 characters or more of random text (`openssl rand -hex 32`). The server keeps a hash of each email address on a pull request's commits, to [match its lines again](pull-requests.md#the-pull-requests-page) later; with this set, the hash is keyed, and the database alone does not confirm a guessed address. Without it the hash is a plain one. Keep it the same: after a change, pull requests have to be reported once more before they can be matched again. |
| `SESSIONLY_DEMO_FROM`, `SESSIONLY_DEMO_REPO`, `SESSIONLY_DEMO_ORG` | Shows one repository's sessions in a second organisation, for a demo of real work: see [below](#showing-a-repository-in-another-organisation). All three or none. |
| `SESSIONLY_DEMO_HIDE` | What of that repository not to show, separated by commas: file names, paths, folders and patterns with `*`, as the Action's `ignore` takes them. See [below](#what-is-not-shown). |
| `SESSIONLY_DEMO_MINUTES` | How often the second organisation is brought up to date (default 30). |
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

## Showing a repository in another organisation

With `SESSIONLY_DEMO_FROM` (the id of the organisation sessions are uploaded to),
`SESSIONLY_DEMO_REPO` (the repository, as sessions are filed under it:
`github.com/owner/name`) and `SESSIONLY_DEMO_ORG` (the id of another organisation), the server
copies that repository's sessions from the first organisation to the second: when it starts,
and every `SESSIONLY_DEMO_MINUTES` after (30 by default). Nothing changes on anyone's machine, and no other repository's
sessions are read. The repository may also be given as its address
(`https://github.com/owner/name.git`, `git@github.com:owner/name.git`), and its letters in
either case. A folder (`~/code/name`) is not a repository's name, and the server says so when
it starts.

What is copied is written anew from what is safe to show, and the second organisation holds
nothing else:

- **Kept:** who ran the session and under whose address it is filed, when, for how long, the
  agent and its models, token counts and cost, how each prompt and tool call ended and the
  name of the tool, whether it ran in the cloud and on which branch, the files it read or
  changed that are known to be in the repository (see below), and the hashes of the lines it
  added to them.
- **Left out:** every prompt (its text, its length and its hash), the title, what a tool was
  given and what it said went wrong, which MCP server a tool is from (any such tool is shown
  as `mcp`), what a subagent was asked to do and its type, the cloud platform's id of the
  session, the working directory and where the clone is, and every path that is outside the
  repository, under `SESSIONLY_DEMO_HIDE` (in a worktree's copy of the repository too), or
  not known to be in it. How many lines the session added to those is kept, without their
  hashes, so that it hashed as many lines in both organisations. A worktree outside the clone
  (`~/worktrees/feat`, or a folder beside the clone) is somewhere else on the person's machine
  too: the files a session changed there, and its lines, are left out, as there is no telling
  which of its paths are the repository's. A pull request written in such a worktree shows
  fewer agent lines in the second organisation than in the first.

A path is known to be in the repository when a pull request reported to the second
organisation names it among its files, as it was first reported or as it was last (in a
worktree's copy of the repository too). A file a session wrote that nobody committed
(`.env.local`, a note of the person's own) is in none of them, and is never shown. A session
copied before a pull request named one of its files is copied again at the next copy after
that report.

What a session cost a pull request is its cost in the proportion of its lines there to all
it added. A pull request costs the same in both organisations when none of the lines its
sessions added elsewhere are left out. Lines added to a file that is hidden, or not known,
are counted but cannot be matched to any pull request: what they cost is in no pull request
of the second organisation, though it was in one in the first.

A session taken back, or whose repository its person stopped, is removed from the second
organisation at the next copy, and so is everything that was copied when another repository
is named. A copy deleted in the second organisation is copied again. One it turns down (its
person stopped the repository there, or was removed, or a session of the same name there is
someone else's) is offered again when it changes, when its person has allowed a repository
again in the second organisation since, and otherwise a day later. A change to
`SESSIONLY_DEMO_HIDE` copies every session again at the next start; one the second
organisation turns down then is removed from it, as the copy it has shows what may now be
hidden. Only sessions the server copied are ever removed there: ones uploaded to the second
organisation directly are left alone, and so is one stored there under the same name after
its copy was deleted.

When the first organisation has none of the repository's sessions, what was copied is kept
until it has had none on three copies in a row (an hour and a half, at the default 30
minutes; the count is kept in the database, and goes on when the server is started again).
So a repository named wrong does not empty the demo at once, and the server says it each
time. A copy made before a change to `SESSIONLY_DEMO_HIDE` is not kept meanwhile: it is
removed at once, as it may show what is hidden now. When the first organisation is gone, or deleted, everything copied from it is removed
at the next copy. When the second one is gone, nothing is copied, and the server says so.

When `SESSIONLY_DEMO_ORG` names another organisation, or is unset, the server removes what
it copied from the one it copied to before, when it starts, and says so. If any of that
fails, it tries again every ten minutes until it is done. While the settings
are set but wrong, the organisation `SESSIONLY_DEMO_ORG` names is left as it is.

Pull requests are not copied: report them to the second organisation with a second step of
the [Action](pull-requests.md) and a `ci` token of that organisation (`comment: false`, so
the pull request gets one comment). The server keeps such a report without the files under
`SESSIONLY_DEMO_HIDE`, and without where a comment on one of them is. When that setting
changes, what it hides now is taken out of the pull requests already kept there, at the next
copy (or when the server starts, if the other settings are wrong): their files as first and
as last reported, the files on their page, where their comments are, and which of their lines
each session wrote. Then they are matched again. Their figures are then those of a pull
request reported after the change: a hidden file's lines leave both what it was opened with
and what it has now, so what survived review is of the files shown. A file hidden and then
shown again comes back with the next report, but only in what the pull request has now: what
it was opened with is kept for good, so those lines count as added after it was opened. After
each copy, the server matches again the pull requests
there that a session it copied or removed may change (those whose look-back of 90 days
takes it in, and for a cloud session those on its branch), since a report arrives before
the sessions that wrote its lines.

The second organisation is made like any other, so that it has an owner. Whoever can open it
sees the costs and the addresses of the people who worked on the repository.

### What is not shown

`SESSIONLY_DEMO_HIDE` takes entries as the Action's [`ignore`](pull-requests.md) does: a file
name, a path, or a pattern with `*` (which also matches `/`). One without a `/` matches a file
of that name in any folder; one with a `/` is a path from the repository's root. An entry also
hides a folder of that name, with everything in it: `docs`, `docs/` and `/docs` all hide every
folder called `docs`, wherever it is, and `site/docs` only the one at `site/docs`. A leading `/`
or `./` is taken off, letters match in either case, and an entry is matched in a worktree's
copy of the repository too. A blank entry between two commas is none.

```
SESSIONLY_DEMO_HIDE=docs/, *.env, secrets.md, site/private/*.md
```

An entry that can hide nothing (`/`, `.`, or one that climbs out with `..`) is said when the
server starts, and then the repository is not copied and pull requests reported to
`SESSIONLY_DEMO_ORG` are refused, until it is put right. Whenever `SESSIONLY_DEMO_ORG` is set,
its reports are kept without what `SESSIONLY_DEMO_HIDE` hides, even when the other settings
are wrong and nothing is copied.
