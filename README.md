# Sessionly

A searchable ledger of AI coding agent sessions: what was asked, which tools ran, which files
changed, and what it cost. For Claude Code, Cursor, Grok and Codex, side by side.

[Website](https://sessionly.dev) | [Documentation](https://docs.sessionly.dev) | [Releases](https://github.com/KIvanow/sessionly/releases)

**Status: early, but working end to end.** A local binary captures each session, measures how
much of what the agent wrote survives, and lists, searches and summarizes sessions from the
command line. It can upload to a server, which shows the same figures for a whole team in a web
dashboard, and how much of each pull request agents wrote.

```
Claude Code ──hooks────────┐
Cursor, Grok ──their files─┼─▶ sessionly (local Rust binary) ──▶ ~/.sessionly/   (raw + normalized sessions)
cloud agents ──hooks a ────┘             │
               repository carries        │
                                         │
                                         └──upload──▶ Sessionly server, hosted or self-hosted (TypeScript)
                                                               └─ team dashboard
```

## Install

Each [release](https://github.com/KIvanow/sessionly/releases) has a binary for Linux and
macOS. Unpack one and put `sessionly` on your `PATH`, or build it with Rust 1.89 or later
(`cargo install --path crates/sessionly`). Then:

```sh
sessionly install     # adds the capture hooks
sessionly status      # hooks installed? how many sessions captured?
```

One install covers Claude Code, Cursor, Grok and Codex. `sessionly update` moves to a newer
release. More: [Install](docs-site/install.md).

## Use

```sh
sessionly list                   # sessions, newest first, with filters and text search
sessionly summary                # totals per user, repo, model, tool or day
sessionly show <session>         # one session: cost, prompts, files changed, tools, subagents
sessionly import                 # bring in sessions from before the hooks were installed
```

```
$ sessionly list
ID        TOOL         STARTED (UTC)      ACTIVE      COST  FILES         LINES  REWRITTEN  REPO      PROMPT
2b02c8f5  Claude Code  2026-11-13 18:29      14s     $0.17      2        +24 -0        1/2  e2e2      Do these steps in order, one tool call each: 1. Write a …
6c6a61b0  Claude Code  2026-11-13 18:10      15s     $0.29      1         +1 -0        0/1  e2e2      Do these steps in order, one tool call each, and keep go…
```

More: [Command line](docs-site/cli.md), the [rewrite rate](docs-site/rewrite-rate.md), and
what is known of each [agent](docs-site/agents.md)'s sessions.

## Cloud sessions

Claude Code's cloud sessions, Cursor's cloud agents and Codex's cloud tasks are captured
through hooks a repository carries:

```sh
sessionly install --repo          # in the repository's root
git add .sessionly .claude/settings.json .cursor/hooks.json AGENTS.md
git commit -m "Capture cloud agent sessions"
```

More: [Cloud sessions](docs-site/cloud-sessions.md).

## Server

The server receives uploads and serves the team dashboard. To try it:

```sh
SESSIONLY_ADMIN_TOKEN=choose-a-long-secret docker compose up -d
sessionly connect http://127.0.0.1:8080
sessionly upload
```

Nothing is uploaded unless you connect a server, and by default an upload has no text from
prompts or commands. More: [Server](docs-site/server.md), [Uploading](docs-site/uploading.md),
and [Data and privacy](docs-site/data.md) for what is kept and what is sent.

## Pull requests

A [GitHub Action](action/) reports each pull request to the server, which works out how much
of it coding agents wrote, with which models, and how those lines fared in review. Both sides
send hashes, never source code. More: [Pull requests](docs-site/pull-requests.md).

## Documentation

The documentation is at [docs.sessionly.dev](https://docs.sessionly.dev), built from
[`docs-site/`](docs-site/), where each page is a Markdown file that also reads well here:

- [Install](docs-site/install.md)
- [Command line](docs-site/cli.md) and its [reference](docs-site/commands.md)
- [Agents](docs-site/agents.md): Claude Code, Cursor, Grok, Codex
- [Cloud sessions](docs-site/cloud-sessions.md)
- [Data and privacy](docs-site/data.md)
- [Uploading](docs-site/uploading.md)
- [Server](docs-site/server.md), its [configuration](docs-site/server-configuration.md) and [API](docs-site/api.md)
- [Pull requests](docs-site/pull-requests.md)
- [Editions and license](docs-site/editions.md)

## Editions and license

Everything outside `ee/` is Apache-2.0 (`LICENSE`): the `sessionly` binary, the server and the
dashboard. It never needs a license key. `ee/` (`LICENSE-EE`) holds the Business and Enterprise
features. More: [Editions and license](docs-site/editions.md).

Contributions use DCO sign-off (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md).

## Develop

```sh
cargo test
cargo clippy --all-targets
pnpm typecheck && pnpm test   # the TypeScript side and the GitHub Action
scripts/dummy-session.sh   # runs a short real Claude Code session that exercises most hooks
```

The website ([sessionly.dev](https://sessionly.dev)) is the static pages in [`website/`](website/):
no build step and no JavaScript, and the two typefaces (Space Grotesk and IBM Plex Mono, both
under the SIL Open Font License) are served from `website/fonts/`. `python3 -m http.server -d website` previews it (pages are at
`/privacy.html` and so on locally; the host serves them without the extension, as
`website/vercel.json` says). After changing the DPA, `scripts/website-dpa-pdf.sh` regenerates
`website/dpa.pdf`.

The documentation is the Jekyll site in [`docs-site/`](docs-site/); its
[README](docs-site/README.md) says how to preview it.
