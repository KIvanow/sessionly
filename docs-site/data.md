---
title: Data and privacy
nav_order: 6
has_children: true
---

# Data and privacy

What Sessionly keeps, where, and what of it can leave the machine.

There are three forms of a session, each made from the one before:

1. **[The raw capture](raw-capture.md)**: every hook event as the agent sent it, with full
   prompts, file contents and command output. It stays on the machine that captured it, in
   files only you can read, and is never uploaded.
2. **[The session record](session-record.md)**: what the ledger holds. Metadata, counts and
   200-character previews, not full content. It also stays on the machine.
3. **[The upload](upload-contents.md)**: what is sent to a server, and only once you connect
   one. Paths are made relative, and by default all text is left out: no prompts, commands,
   patterns, errors or titles.

Two switches decide what an upload has beyond that, both off by default:

- `sessionly settings --content previews` sends the previews too.
- `sessionly settings --line-hashes on` sends a hash of each line an agent added, which
  [pull request](pull-requests.md) figures need.

`sessionly export <session>` prints what would be sent for a session, connected or not.

What a server does with it:

- A person sees their own sessions; an admin sees the team's (see
  [People, tokens and sign-in](people-and-tokens.md)).
- You can stop a repository of yours and delete what you sent from it, from the command line
  or the dashboard (see [Uploading](uploading.md#stopping-a-repository)).
- The [GitHub Action](pull-requests.md#what-is-sent) sends hashes of a pull request's added
  lines, never the lines, and nothing of what reviews and comments say.
- The dashboard counts which of its pages are opened, and nothing of what they show; a server
  of your own can turn that off (see [Dashboard](dashboard.md#page-counts)). The `sessionly`
  binary and the server send nothing to anyone but each other, except:
  - a connected binary with automatic sync on asks GitHub (or `SESSIONLY_RELEASE_LATEST`), at
    most once a day, for the newest release's version (see
    [What an upload contains](upload-contents.md); `sessionly settings --update-check off`
    stops it);
  - `sessionly update` downloads a release from GitHub, and `sessionly install --repo` reads
    a release's checksums there unless given a file, connected or not;
  - a server set up for signing in with Google or GitHub asks that provider who signed in (see
    [People, tokens and sign-in](people-and-tokens.md#signing-in-with-google-or-github)).

[Files and settings](files.md) lists every file the binary keeps.
