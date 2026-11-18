---
title: Install
nav_order: 2
---

# Install

Each [release](https://github.com/KIvanow/sessionly/releases) has a binary for Linux (x86_64
and arm64, statically linked) and macOS (Apple silicon and Intel), as
`sessionly-<target>.tar.gz`, with their SHA-256 checksums in `SHA256SUMS`. Unpack one and put
`sessionly` on your `PATH`. Or build it, which needs Rust 1.89 or later:

```sh
cargo install --path crates/sessionly   # or: cargo build --release
```

Then:

```sh
sessionly install                        # adds hooks to ~/.claude/settings.json
sessionly status
```

`sessionly install --project DIR` writes to `DIR/.claude/settings.json` instead, so you can try
it on one project first. The hook command contains the absolute path of the binary, so don't
commit a settings file that has it. (To capture sessions that run in the cloud, a repository
carries hooks of another kind: see [Cloud sessions](cloud-sessions.md).)

One install covers every agent on the machine:

- **Claude Code** runs the hooks in `~/.claude/settings.json`.
- **Cursor and Grok** run the hooks in that same file, whether or not Claude Code is installed
  (see [Cursor and Grok](cursor-and-grok.md)).
- **Codex** has a hooks file of its own, `~/.codex/hooks.json`, which `sessionly install`
  also writes when `~/.codex` exists. Codex asks you to approve the hooks before it runs them
  (see [Codex](codex.md)).

The settings file is always the one in your home directory: `CLAUDE_CONFIG_DIR` does not move
where the hooks are written.

`sessionly status` then says where the hooks are, how many of the events are hooked, how much
has been captured, and what is set (`--project DIR` and `--repo` look at those instead).

## What install changes

- It adds or removes only hook entries whose command is a `sessionly` binary followed by
  `capture`, wherever that binary is: installing again after the binary moved replaces the
  entries that named the old place. Other hooks and settings, key order, file permissions and
  a symlinked location are kept.
- The file is rewritten as JSON with two-space indentation. Comments are not supported; a file
  that isn't valid JSON, or isn't a JSON object, is left untouched and install stops with an
  error.
- The file as it was before Sessionly's first change, if there was one, is saved next to it as
  `settings.json.sessionly-bak` and never overwritten. Codex's is `hooks.json.sessionly-bak`.
- `sessionly uninstall` removes the entries again, from Codex's file too
  (`uninstall --project DIR` from a project's). Running either command twice changes nothing.

## Updating

To move to a newer release later:

```sh
sessionly update            # --check only says whether there is one; --version 0.4.0 names one
```

It downloads the release's archive for this machine, checks it against the release's
`SHA256SUMS`, runs the new binary once to see that it is the version asked for, and then puts
it where the old one was, in one step. If any of that fails, nothing is changed. The hooks name
the binary by its path, which stays the same, so they need nothing, and Codex does not ask to
approve them again. What it does not do:

- A repository set up with [`install --repo`](cloud-sessions.md) keeps fetching the version its
  script names, until `install --repo` is run there again with the new binary and committed.
- A binary built from source is replaced by the released one like any other. To stay on your
  own build, rebuild instead.
- It needs to be able to write where the binary is, and the `tar` program to unpack the
  archive. There are released binaries only for Linux and macOS.
- Without `--version` it moves only to a release that is newer than the one you have, and a
  release candidate is never taken for one. `--version` installs the release it names,
  an older one too.
- If `sessionly` on your `PATH` is a link to the binary, the link stays and the file it
  points to is replaced.

`SESSIONLY_RELEASE_BASE` names another place to download from, as for `install --repo`: under
it, a release is `v<version>/SHA256SUMS` and `v<version>/sessionly-<target>.tar.gz`.
`SESSIONLY_RELEASE_LATEST` names another place to ask for the newest version: an address that
answers with JSON whose `tag_name` is the release's tag. For `update`, either can be a
`file://` address.
