---
title: Editions and license
nav_order: 10
---

# Editions and license

Everything outside `ee/` is Apache-2.0 ([`LICENSE`](https://github.com/KIvanow/sessionly/blob/main/LICENSE)): the `sessionly` binary (capture, ledger,
rewrite rate, command line, upload), the server and the dashboard. It never needs a license key.

`ee/` ([`LICENSE-EE`](https://github.com/KIvanow/sessionly/blob/main/LICENSE-EE)) holds the Business and Enterprise features, and the hosted
service: signing up, signing in with Google or GitHub, adding people by address, deleting an
organisation, and showing a repository in an organisation of its own (`ee/src/hosted`, with
`SESSIONLY_HOSTED=true`). Nothing outside it imports from it, which CI checks. A server of your
own needs none of that: its dashboard opens without signing in, and machines connect with
tokens.

## Running the ee server

Run the ee server in place of the core one; everything else is the same:

```sh
SESSIONLY_ORG=acme SESSIONLY_ADMIN_TOKEN=choose-a-long-secret pnpm --filter @sessionly/ee start
# Docker:
SESSIONLY_ORG=acme SESSIONLY_ADMIN_TOKEN=choose-a-long-secret \
  docker compose -f docker-compose.yml -f docker-compose.ee.yml up -d --build
```

`SESSIONLY_ORG` is this install's org id (1 to 64 letters, digits, `-` or `_`). It is needed:
a license is accepted only if it names the same org, installing one without it set is refused,
and the Docker overlay does not start without it. The other settings are the core server's
(see [Configuration](server-configuration.md)).

With no license installed the ee server behaves exactly like the core one, and the ee
endpoints answer `403 license_required`.

## Licenses

```sh
sessionly license install acme.license   # needs an admin token
sessionly license status
```

A license can also be pasted into the License card on the dashboard's Team page. Licenses are
Ed25519-signed files checked offline (no phone-home), when installed and each time they are
loaded.

| State | When | ee features |
|---|---|---|
| active | before the license expires | Everything the license lists |
| grace | up to 14 days after it expires | Everything the license lists |
| expired | after that | Read-only: reads work, changes answer `403 license_expired` |
| missing | no valid license | None (`403 license_required`) |

The core never stops, whatever the state.

- A license that has already expired is not installed.
- `seats` is the number of people the license covers. Status shows how many people have access
  now; nothing is blocked when that number is higher.
- A change of license can take up to 30 seconds to be seen by every request.
- A hosted service (`SESSIONLY_HOSTED=true`) takes no licenses.
- On a core server, `sessionly license status` says that the core needs none.

## Features

So far there is one:

| Feature | What |
|---|---|
| `content_policy` | The organisation sets what uploads from its engineers should contain: `GET /api/v1/policy` (anyone signed in) and `PUT /api/v1/policy {"content": "metadata" \| "previews"}` (admins). Unset, it is `metadata`. **The server stores and serves the policy; the `sessionly` binary does not read it yet**, so each engineer's own `sessionly settings --content` still decides what is sent. |

See [ee/README.md](https://github.com/KIvanow/sessionly/blob/main/ee/README.md) for how a license is issued and how the ee code plugs
into the server.

Contributions use DCO sign-off (`git commit -s`); see
[CONTRIBUTING.md](https://github.com/KIvanow/sessionly/blob/main/CONTRIBUTING.md).
