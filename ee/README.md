# @sessionly/ee

Business and Enterprise features. Licensed under [`LICENSE-EE`](../LICENSE-EE), not Apache-2.0.
Nothing outside this directory imports from it (CI checks): capture, the local ledger, upload,
the server and the dashboard run with or without it.

## Running

Run the server from here instead of `apps/server`; everything else is the same.

```sh
SESSIONLY_ORG=acme SESSIONLY_ADMIN_TOKEN=... pnpm --filter @sessionly/ee start
# Docker: docker compose -f docker-compose.yml -f docker-compose.ee.yml up -d --build
```

It runs the core migrations, then its own (tracked in `migrations_ee`). With no license
installed it behaves exactly like the core server; the ee endpoints answer
`403 license_required`.

`SESSIONLY_ORG` is this install's org id (1-64 letters, digits, `-` or `_`). A license is
accepted only if it names the same org.

## The hosted service

With `SESSIONLY_HOSTED=true` this server is a service many organisations share (`src/hosted`):
signing up, signing in with Google or GitHub, adding people by address, deleting an organisation
and purging it a week later, and one repository shown in an organisation of its own (the demo).
It is the core's `hosting` (see `apps/server/src/app.ts`). It takes no licenses, and under
`LICENSE-EE` nobody but the copyright holder may run it for others. Its settings are in
`src/hosted/config.ts`; the operator's commands are `node src/cli.ts org restore <id>`,
`org purge` and `demo import`, with `DATABASE_URL` set.

## License

A license is a JSON file: an Ed25519 signature over its payload (`id`, `org`, `edition`,
`features`, `seats`, `issuedAt`, `expiresAt`). It is verified offline against the public key
built into `src/license/keys.ts`, on install and on every load; there is no phone-home. Install
it with an admin token, from the command line or on the dashboard's Team page:

```sh
sessionly license install acme.license
sessionly license status
```

| State   | When                       | ee features                                                 |
| ------- | -------------------------- | ----------------------------------------------------------- |
| active  | before `expiresAt`         | Everything the license lists                                |
| grace   | up to 14 days after expiry | Everything the license lists                                |
| expired | after the grace period     | Read-only: reads work, changes answer `403 license_expired` |
| missing | no valid license           | None (`403 license_required`); core features as always      |

`seats` is the number of people the license covers. Status shows how many people have access
now; nothing is blocked when that number is higher.

Issuing a license needs the private key, which never enters this repository:

```sh
pnpm --filter @sessionly/ee sign-license --key /secure/license-ed25519.pem \
  --org acme --edition business --months 12 --seats 25 > acme.license
```

## Features

| Feature (`features[]`) | What |
| ---------------------- | ---- |
| `content_policy`       | The organisation sets what uploads from its engineers should contain: `GET /api/v1/policy` (anyone signed in) and `PUT /api/v1/policy {"content": "metadata" \| "previews"}` (admins). The server stores and serves the policy. The `sessionly` binary does not read it yet: each engineer's own `sessionly settings --content` still decides what is sent. |

How it plugs in: `eeApi()` is an entry in the core's `extensions`, which adds routes to the
authenticated API, and the tables are the server's `migrations` option (see
`apps/server/src/run.ts`). Neither is handed the database itself: a route gets the one
organisation's view of its request.
