---
title: Home
layout: home
nav_order: 1
---

# Sessionly documentation

Sessionly is a searchable ledger of AI coding agent sessions: what was asked, which tools ran,
which files changed, and what it cost. For Claude Code, Cursor, Grok, Codex and OpenCode, side by side.

A local binary captures sessions on each developer's machine and keeps them in a local ledger.
It can upload to a server, which shows the same figures for a whole team in a web dashboard.

```
Claude Code ──hooks────────┐
Cursor, Grok ──their files─┼─▶ sessionly (local Rust binary) ──▶ ~/.sessionly/   (raw + normalized sessions)
OpenCode ────its database──┤             │
cloud agents ──hooks a ────┘             │
               repository carries        │
                                         └──upload──▶ Sessionly server, hosted or self-hosted (TypeScript)
                                                               └─ team dashboard
```

- **The local binary** captures hook events, parses transcripts, normalizes sessions, keeps
  the local ledger and uploads to a server if you connect one. All parsing and redaction
  happens on the developer's machine, or for a cloud session in its sandbox.
- **The server and dashboard** receive normalized sessions, aggregate them per team, and
  serve the manager view. The same code runs hosted or self-hosted.

## Quick start

Put the `sessionly` binary of a [release](https://github.com/KIvanow/sessionly/releases) on
your `PATH`, then:

```sh
sessionly install     # adds the capture hooks
sessionly status      # hooks installed? how many sessions captured?
```

Work with your agent as usual, and then:

```sh
sessionly list        # sessions, newest first
sessionly summary     # totals per user, repo, model, tool or day
sessionly show <id>   # one session: cost, prompts, files changed, tools
```

Nothing leaves the machine until you connect a server:

```sh
sessionly connect https://sessionly.example.com
```

## On one machine

- [Install](install.md): the binary, the hooks, and updating.
- [Command line](cli.md): listing, searching and summing up sessions, the
  [rewrite rate](rewrite-rate.md), [past sessions](past-sessions.md) and
  [cost](cost.md), with a [reference](commands.md) of every command.
- [Agents](agents.md): what is known of a session of [Claude Code](claude-code.md),
  [Cursor and Grok](cursor-and-grok.md), [Codex](codex.md) and [OpenCode](opencode.md).
- [Cloud sessions](cloud-sessions.md): capturing Claude Code's cloud sessions, Cursor's cloud
  agents and [Codex's cloud tasks](codex-cloud-tasks.md).

## For a team

- [Uploading](uploading.md): connecting a server, and stopping a repository.
- [Server](server.md): running one, its [configuration](server-configuration.md),
  [people, tokens and sign-in](people-and-tokens.md), the [dashboard](dashboard.md) and the
  [API](api.md).
- [Pull requests](pull-requests.md): how much of a pull request agents wrote, and how those
  lines fared in review.

## What is kept, and what is sent

- [Data and privacy](data.md): [the raw capture](raw-capture.md),
  [the session record](session-record.md), [what an upload contains](upload-contents.md) and
  [every file](files.md) the binary keeps.
- [Editions and license](editions.md): what is Apache-2.0, and what is not.
