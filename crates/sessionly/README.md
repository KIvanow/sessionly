# sessionly

The local collector and ledger of [Sessionly](https://sessionly.dev): it captures the sessions of
AI coding agents (Claude Code, Codex, Cursor and Grok) on your machine, keeps them in a local
ledger, and can upload them to a Sessionly server.

```sh
cargo install sessionly
```

Then:

```sh
sessionly install     # adds the capture hooks for Claude Code, Codex, Cursor and Grok
sessionly status      # hooks installed? how many sessions captured?
sessionly import      # bring in sessions from before the hooks were installed
```

Installed this way, update it with `cargo install sessionly` again. Each
[release](https://github.com/KIvanow/sessionly/releases) also has a binary for Linux and macOS.

More: [Install](https://github.com/KIvanow/sessionly/blob/main/docs-site/install.md),
[Command line](https://github.com/KIvanow/sessionly/blob/main/docs-site/cli.md) and the
[repository](https://github.com/KIvanow/sessionly).
