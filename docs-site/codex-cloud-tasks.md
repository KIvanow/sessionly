---
title: Codex cloud tasks
nav_order: 1
parent: Cloud sessions
---

# Codex cloud tasks

Codex's cloud is different, and what Sessionly records of a task there is much less. Tried on
2026-11-17, with Codex 0.167:

- **It runs no hooks.** Not the ones in a repository's `.codex/hooks.json`, present from the
  task's first moment, and none can be put in the home directory: nothing an environment's
  install script leaves behind was there when the task ran.
- **The agent is not in the sandbox.** Only what runs its commands is, so there is no session
  file to read there either, and the `codex cloud` command on a person's machine does not list
  these tasks.
- **It does read `AGENTS.md`** and does what it says.

So `sessionly install --repo` adds a section to `AGENTS.md` that asks the agent, in a Codex
cloud task only, to run the script twice in every turn in which it changes files:
`sh .sessionly/hook.sh codex start` before its first change and `sh .sessionly/hook.sh codex
end` after its last. The working tree is compared between the two, as it is around a shell
command in the other clouds, and the second command brings the ledger up to date and uploads
the session before it returns. If another upload is still going after two minutes it gives up
waiting, and what it stored is sent when the next turn ends.

## What such a session has

- its turns, with when each began and ended;
- the files each turn changed and the lines it added and removed, which count toward the
  rewrite rate and [pull requests](pull-requests.md) like any other edit;
- the repository and branch, that it ran in the cloud, and the person. Git in Codex's sandbox
  is set up as the person who started the task, so that is who the session belongs to.

What it does not have: the text of prompts, tool calls (each turn shows one, named `Turn`,
which stands for all of its work), the model, tokens and cost.

## What to know

- **It depends on the agent.** A turn is recorded only if the agent ran the commands. A turn
  it did not end is ended by the next one's start, with what changed until then. A turn it did
  not start is recorded with nothing known to be its. A turn in which it ran neither is not
  there at all, and its lines count as not an agent's. The one exception: if the turn before
  it was started and never ended, that turn is still open, and it takes these lines too when
  the next start ends it.
- **Other agents read `AGENTS.md` too**, and so does Codex on a person's machine. The section
  says it is for Codex's cloud only, and the script does nothing anywhere else: it looks for
  `CODEX_ENVIRONMENT_ID` and `CODEX_THREAD_ID`, which Codex sets together only in its cloud. Your own text in `AGENTS.md` is
  left as it is, and `sessionly uninstall --repo` takes the section out again.
- **In the cloud environment**, set `SESSIONLY_URL` and `SESSIONLY_TOKEN` as environment
  variables and add the server's host to the allowed domains. The script also has to download
  the sessionly binary from GitHub's releases. With "package manager domains" enabled
  `github.com` could be reached; whether the download itself gets through that setting alone
  has not been tried, so if `bootstrap.log` says it could not download, add `github.com` and
  `release-assets.githubusercontent.com`.
- Where the sandbox does not let commands write to the home directory, Sessionly keeps its
  files in `/tmp/sessionly-<uid>` (under `$TMPDIR`, where that is set) instead of
  `~/.sessionly`.
- This was built from what one environment showed on one day, and the whole path (download,
  capture, upload) has been run in tests but not yet in Codex's cloud itself.
