---
title: Cloud sessions
nav_order: 5
has_children: true
---

# Cloud sessions

A Claude Code cloud session or a Cursor cloud agent runs in a sandbox the platform starts, with
a fresh clone of the repository. Nothing from your home directory is there, so the hooks that
`sessionly install` writes are not there either. Both platforms do run the hooks a repository
carries, so that is where capture for them goes:

```sh
sessionly install --repo          # in the repository's root; --repo DIR for another one
git add .sessionly .claude/settings.json .cursor/hooks.json AGENTS.md
git commit -m "Capture cloud agent sessions"
```

It has to be run in the root of a git repository, with a released `sessionly`: the script it
writes carries the checksums of that release's binaries.

That writes four files, and only adds to the three that may already exist:

- **`.sessionly/hook.sh`**, a script. On a person's own machine it does nothing: sessions there
  are captured by that person's own `sessionly install`, if they have one. In a sandbox it
  fetches the sessionly binary of the version that wrote the script, once per sandbox, checks
  it against the SHA-256 checksum written into the script, and hands it the event. It prints
  nothing and always exits 0.
- **Entries in `.claude/settings.json`** (for Claude Code, the same 20 events as on a
  person's machine) **and `.cursor/hooks.json`** (for Cursor: a turn's prompt, its tool
  calls, what its edits changed, and its end) that run the script.
- **A section in `AGENTS.md`**, between `<!-- sessionly:begin -->` and `<!-- sessionly:end -->`,
  for Codex's cloud, which runs no hooks (see [Codex cloud tasks](codex-cloud-tasks.md)).

## Where sessions are sent

Where a sandbox sends its sessions is not in the repository. It is given to the cloud
environment, as secrets (in Codex's cloud, as environment variables):

| Variable | Meaning |
|---|---|
| `SESSIONLY_URL`, `SESSIONLY_TOKEN` | The server and a token for it, both together. Use a token with the `env` role (see [People, tokens and sign-in](people-and-tokens.md)). Without these the session is captured inside the sandbox and sent nowhere, and the same goes for an address that is not `https://`. |
| `SESSIONLY_LINE_HASHES=on` | Optional. Send line hashes, which [pull request](pull-requests.md) figures need. |
| `SESSIONLY_CONTENT=previews` | Optional. Send previews instead of metadata only. |

Claude Code's cloud sessions and Codex's cloud tasks reach only the hosts on the environment's
allowed list, so add the server's host there. Cursor's cloud agents can reach it as they are.

## What is different about a session from the cloud

- **Who.** Git in a sandbox is set up as the agent (`Claude <noreply@anthropic.com>`,
  `Cursor Agent <cursoragent@cursor.com>`), so the person is the one the platform names:
  Claude Code in the sandbox's environment, Cursor through a socket it serves there.
  `sessionly show` says `Ran in  the cloud`, with the platform's own id for the session and
  what started it.
- **One machine.** A sandbox is new each time, so every sandbox uploads as the machine `cloud`,
  and a session that moves to another sandbox stays one session.
- **Every turn is sent.** The ledger is brought up to date and uploaded each time a turn ends,
  not at most every five minutes: a sandbox may be gone soon after.
- **The branch** is the one checked out in the sandbox, which is the one the agent pushes.
- **Shell commands count.** In a sandbox an agent often edits with the shell (`sed -i`, a
  heredoc) instead of its file tools, and a shell command tells hooks nothing of what it
  changed. So the working tree is compared just before and just after each shell command,
  and what differs is the command's: the files it changed, created or deleted, and the lines.
  They count toward the session's files and lines, the rewrite rate and pull requests like
  any other edit. The comparison uses git with an index and objects kept in `~/.sessionly`;
  the repository's own index, objects and HEAD are not written. Files git ignores are not
  looked at, and new files over 1 MB are left out. Agents run tools side by side: a file a
  file tool changes while a command runs is that tool's, and is not counted a second time
  as the command's. A command that moves to commits it did
  not make (`git pull`, `git checkout main`, a rebase) is not counted, since what that
  brings in is other people's work. A command that carries on in the background is counted
  up to when the call returned. On a person's machine less is counted, since whatever the
  person saved while a command ran would be put down to the agent: see
  [Shell edits](shell-edits.md).
- **Cursor's first prompt may be missing.** A Cursor cloud agent does not always run hooks
  for the prompt it was started with (of two runs on 2026-11-14, one did and one did not).
  Its tool calls are still captured: the turn is recorded with its prompt unknown, and the
  session says it was not captured from its start. Later prompts in the same agent arrive.
- **Review commands** typed in a cloud session are [review runs](session-record.md#review-runs)
  as on a machine. In the cloud the review runs in the session's own thread, so a run has
  no cost of its own; Claude Code's has its findings count where it reports them as a list.
  A review typed as a Cursor cloud agent's very first prompt is missed when that prompt is.
- **Cursor has no cost.** A Cursor cloud agent keeps no transcript and does not tell hooks how
  many tokens a turn used, so its session has prompts, tool calls with their outcome and
  duration, files and lines changed, and the model, but no tokens and no cost.

## What to know

- The first hook in a fresh sandbox waits for the download (a few seconds, once). If the
  download fails or does not match its checksum, nothing is captured, the reason is in
  `~/.sessionly/bootstrap.log` in the sandbox, and it is tried again ten minutes later.
- The script fetches a Linux binary, for x86_64 or arm64, with `curl` or `wget`. A sandbox of
  another kind captures nothing, and `bootstrap.log` says that there is no binary for it.
- **How a sandbox is known.** Claude Code's by `CLAUDE_CODE_REMOTE=true`, Cursor's by the
  socket it serves there, and Codex's by `CODEX_ENVIRONMENT_ID` and `CODEX_THREAD_ID`.
  Anywhere else the script does nothing.
- The rewrite rate is measured while the sandbox exists. After that, what survived shows
  only through [pull requests](pull-requests.md).
- If a session outlives its sandbox, the next one captures only what happens from then on.
  For Claude Code the rest is read from the transcript when the platform brings it along.
  For Cursor it is not there, and the server keeps the fuller copy it already has.
- Claude Code does not load a repository's hooks in sessions over several repositories, or
  in ones started from Slack (its documentation, not tried here).
- `sessionly status --repo` shows what is installed, `sessionly uninstall --repo` removes it,
  and running `install --repo` with a newer sessionly updates the script.
- The script downloads from this project's GitHub releases. To use a copy of your own, set
  `SESSIONLY_RELEASE_BASE` when running `install --repo`; `--checksums FILE` reads the
  release's `SHA256SUMS` from a file instead of downloading it, which is also how a
  `sessionly` built from source, with no release of its version, can write the script.

The platforms' side of this was checked with one real session on each (2026-11-14): which
hooks fire and from which files, what they carry, where the person and the session id are
to be found, and what a sandbox can reach.
