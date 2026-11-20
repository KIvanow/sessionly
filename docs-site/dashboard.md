---
title: Dashboard
nav_order: 3
parent: Server
---

# Dashboard

Sign in with a token, or with Google or GitHub where the server is set up for them. An admin
sees the whole team; a member sees their own sessions. The dashboard has the website's look,
light or dark as the system is, and serves the same two typefaces itself, from
`apps/web/public/fonts/`.

## Pages

- **Overview:** total cost (with cost per session and per active hour, and, once the
  [Action](pull-requests.md) reports pull requests, where it went: **merged or open pull
  requests**, **closed without merging**, and **not in a pull request**, which is sessions
  whose work has not reached a pull request yet: exploration, abandoned branches, work whose
  pull request is not open yet, and what a session spent on another branch than its pull
  request's. Every dollar is in one of the three, and they add up to the total; see
  [how a pull request is charged](pull-requests.md#how-to-read-it)), sessions, active time,
  prompts, tokens, tool calls and failure rate, files changed, the share of files rewritten
  since and of agent lines kept at 7 days (see [Rewrite rate](rewrite-rate.md#at-1-7-and-30-days));
  cost per day (per week for long ranges, with a table
  view; choosing a column narrows the page to that day or week); and the same totals by tool,
  person, repository and model. A repository's row names the agents and models that worked in
  it, and opens to compare those agents within it and to list the files they changed: which
  agents touched each file, sessions, lines added and removed, how many of the agents' lines
  are still there, and when it was last changed.
- **Sessions:** a searchable, paged list, 50 to a page.
- **One session:** cost and tokens per model, prompts with how long each took and how it ended,
  how much of what the agent wrote in the whole session was still there 1, 7 and 30 days after
  it ended and is there now, files changed with how much of each survives as last measured,
  tools, and subagents.
- **Pull requests** (admins): see [Pull requests](pull-requests.md).
- **Team** (admins): add and remove people where they sign in with Google or GitHub, and create
  and revoke tokens for what cannot sign in: a cloud environment, CI, or a machine set up for
  someone. On a server of your own it also shows the [license](editions.md).
- **Connect:** a token of your own for each of your machines, with the commands to run. For
  admins it also has what to set up for cloud agents and for pull requests.

Period, person, repository, tool and model filters apply to both Overview and Sessions; a
session counts under its most used model. Some of them are shown only when there is something
to choose:

- the person filter and the totals by person are an admin's: a member has one person to see;
- the tool filter and the totals by tool appear once there are sessions from more than one
  agent;
- a further filter separates sessions from the cloud from those on people's machines, once
  what you can see has both.

Someone signed in to more than one organisation in the same browser gets a switch between them.

## Stop submitting a repository

Choosing one repository, on Overview or Sessions, offers **Stop submitting**. After you
confirm, it deletes the sessions you submitted from it and stops further ones; for a folder
that is named by its path, the folders inside it and repositories cloned there are stopped too.
Repositories you stopped are listed there, with **Allow again**. The copies on your machines
stay, and are sent again after that. It is the same list `sessionly exclude` keeps: see
[Uploading](uploading.md#stopping-a-repository).

## What it shows depends on what was uploaded

With the default `metadata` level there is no text: sessions are listed by id and prompts show
only their length. Sessions uploaded with `previews` show titles and the first 200 characters
of each prompt (see [What an upload contains](upload-contents.md)).

## What the browser keeps

Being signed in is kept in the browser's local storage: the token you signed in with, or the
one the server gave when you signed in with Google or GitHub, for each organisation. Signing
out removes it. Nothing else is kept, and counting pages (below) keeps nothing at all.

## Page counts

The dashboard counts which of its pages are opened, with PostHog's EU cloud, so
that I can see which parts are used. A count says three things: the page's name (`overview`,
`sessions`, `session`, `pulls`, `pull`, `team`, `connect`, or `other`), whether the server is
hosted or self-hosted, and an id made up for that one load of the page. It is sent in the form
PostHog takes a page view in, so it also carries the project's public key, a made-up address
built from the page's name (`https://dashboard.sessionly.invalid/sessions`), and two
instructions: to make no profile of a person, and not to look the sender's address up for a
location. Nothing is read from the browser to put in it, and it
never carries the address the dashboard runs at, an organisation, a person, a session, a token
or anything a page shows. Nothing is kept in the browser for it: no cookie, no local storage
and no id that lasts past the page. The sign-in screen counts as `overview`.

The count is written out and sent by the dashboard's own code
([`apps/web/src/telemetry.ts`](https://github.com/KIvanow/sessionly/blob/main/apps/web/src/telemetry.ts),
under a hundred lines), with no analytics library. It goes as a `GET` made with no referrer
and no credentials, so the browser adds no `Origin`, no `Referer` and no cookie: nothing in the
request names where the dashboard runs. A `POST` would not do: Chromium sends the page's origin
with every cross-site `POST`, which for a self-hosted server is a name inside your network.
PostHog's servers see the IP address a count comes from and the browser's standard headers, as
any server does. The
dashboard's Content Security Policy lets it reach only `https://eu.i.posthog.com`, and only
while counting is on. Browsers that send Do Not Track or Global Privacy Control are not counted.

To turn it off on a server of your own, set `SESSIONLY_TELEMETRY=off` (`false`, `0` and `no`
do the same). `DO_NOT_TRACK` set to anything but those does the
same. The dashboard then counts nothing and its policy allows no address but its own. A server
of your own that is counting says so when it starts. The
`sessionly` program and the server send nothing either way.

## Working on the dashboard

`pnpm dev` runs it with live reload and passes API calls to a server on port 8080
(`SESSIONLY_SERVER=http://…` names another).
