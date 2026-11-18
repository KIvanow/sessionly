---
title: Uploading
nav_order: 7
---

# Uploading

Nothing is uploaded unless you connect a server: your own (see [Server](server.md)) or a
hosted one. What is sent then, and how to see it first, is under
[What an upload contains](upload-contents.md).

```sh
sessionly connect https://sessionly.example.com   # asks for the token, checks it, saves both
sessionly upload                                   # send new and changed sessions now
sessionly upload --dry-run                         # only count what would be sent
sessionly exclude ~/Documents                      # stop submitting it, and delete what you already sent
sessionly exclude                                  # list the repositories you stopped
sessionly include ~/Documents                      # submit one again
sessionly settings --content previews              # opt in to sending previews
sessionly disconnect                               # stop uploading, forget the token
```

- `connect` asks for the token on a line of its own (it is shown as you type or paste it).
  The token can also come from `--token` or the `SESSIONLY_TOKEN` environment variable. It is
  stored in `~/.sessionly/config.json`, readable only by you, and never printed.
- `connect` checks the token with the server and saves nothing if that fails; `--no-check`
  saves without asking the server. `--content previews` sets what is sent in the same step.
- Plain `http://` is accepted only for a server on this machine (`localhost`, `127.0.0.1`,
  `[::1]`).
- A session is sent again only when its payload changed. Failed uploads are retried on the next
  run.
- `upload --dry-run` sends and records nothing. It still needs a server to be connected, and
  asks it which repositories you stopped, so that their sessions are left out of the count;
  if the server does not answer, it counts without that and says so.
- With a server connected, uploads also happen by themselves: see
  [Automatic sync](cli.md#automatic-sync).
- `SSL_CERT_FILE` names a file of root certificates (PEM) to trust in place of the built-in
  ones, for a server whose certificate is from an authority of your own.
- Where no server is saved, `SESSIONLY_URL` and `SESSIONLY_TOKEN` in the environment, both
  together, name one for uploads. That is how a [cloud sandbox](cloud-sessions.md) is told.

## Stopping a repository

- `sessionly exclude ~/Documents` stops that repository and deletes the sessions you already
  submitted from it. A directory is named by its origin remote when it has one, otherwise by
  the `~/…` path the dashboard shows. A path also covers folders inside it (`~/Downloads` stops
  `~/Downloads/notes` and leaves `~/Downloads-backup`), including a clone in there that has a
  remote; a remote such as `github.com/owner/name` is only itself. Only your sessions are
  deleted, and pull requests are left as they are.
- The list of what you stopped is kept on the server, so it holds for every machine of yours
  and for the dashboard. The copy on the machine that captured a session stays, and is not
  sent while its repository is stopped. After `sessionly include` (or **Allow again** on the
  dashboard), the next upload from each machine that still has the sessions sends them again,
  whether or not that machine uploaded anything in between. Until then what was deleted stays
  gone.
- Sessions from a cloud environment are stopped the same way: the server refuses them for the
  person they are filed under. An environment's token only uploads: it cannot ask what the
  server still has, so a cloud session deleted this way comes back only if it goes on after
  its repository is allowed again.

## Endpoints the binary uses

The binary uses these endpoints, all with `Authorization: Bearer <token>`. The
[API reference](api.md) has the rest of what a server answers.

- `GET /api/v1/ping` answers 2xx if the token is accepted.
- `PUT /api/v1/sessions/{machine_id}/{source}/{session_id}` stores or replaces one session. The
  body is the payload described under [What an upload contains](upload-contents.md).
- `DELETE /api/v1/sessions/{machine_id}/{source}/{session_id}` takes one back. The binary
  sends it only for a session that has become part of another (a Codex subagent's thread
  uploaded before its session was known), and only once the server has the session it is
  part of. Only the person a session is filed under can take it back; the answer is
  `{"removed": true}`, or `false` if there was none of theirs. A server from before this
  answers 404, and a token that may not gets 403: the binary keeps the session noted and asks
  again at a later upload, and until then such a server keeps the extra copy.
- `GET`, `PUT` and `DELETE /api/v1/repos/excluded` list the repositories you stopped, stop one
  (and delete the sessions you already submitted from it), or allow one again. Every upload
  starts by reading the list, so a stopped repository's sessions are not sent at all.
- `GET /api/v1/sessions/held?machine={machine_id}` lists the sessions of yours the server has
  from this machine. It is asked once after a repository was allowed again, to find what
  stopping it deleted.
