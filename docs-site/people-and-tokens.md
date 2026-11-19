---
title: People, tokens and sign-in
nav_order: 2
parent: Server
---

# People, tokens and sign-in

## Tokens and roles

Each token belongs to one person and has one of four roles. Uploads are filed under the token's
owner, whatever name the record carries.

| Role | What it can do |
|---|---|
| `member` | Upload sessions, see their own, take their own back, stop and allow their own repositories, and make tokens for their own machines. |
| `admin` | The same for everyone's sessions in the organisation, and also: the Pull requests and Team pages, creating and revoking tokens, adding and removing people. |
| `ci` | For the [GitHub Action](pull-requests.md): report pull requests, and nothing else. |
| `env` | For a cloud agent's environment (see [Cloud sessions](cloud-sessions.md)): upload sessions, and nothing else. |
| `viewer` | Only in the organisation a repository is [shown in](server-configuration.md#showing-a-repository-in-another-organisation), which anyone who signs in may join: see what an admin sees, and change nothing. |

- A cloud session an `env` token uploads is filed under the person the platform says started
  it, since several people start sessions in one environment. It can take back only a session
  filed under its own address. **Whoever holds it can therefore upload a session in anyone's
  name**, so give it only to those environments.
- `ci` and `env` tokens can also ask whether they are accepted (`GET /api/v1/ping`), which is
  how `sessionly connect` checks one.
- A token looks like `sly_` followed by 32 characters, and is sent as
  `Authorization: Bearer <token>`. Only a hash of each token is stored, so it is shown once,
  when it is made.

## Making tokens

- **On the dashboard.** An admin makes tokens of any role on the Team page; everyone makes
  tokens for their own machines on the Connect page (those are always `member`).
- **Through the API.** `POST /api/v1/tokens`, `GET /api/v1/tokens` and
  `DELETE /api/v1/tokens/{id}`, for admins. See the [API reference](api.md#tokens-and-people).
- **From the command line**, on the server's machine:

```sh
pnpm token create --email ann@example.com [--name "Ann's laptop"] [--role admin|member]
pnpm token list
pnpm token revoke <id>
```

What to know about the command line:

- It makes `admin` and `member` tokens only. A `ci` or `env` token is made on the Team page or
  through the API.
- With the embedded database, stop the server first: one process at a time can open it.
- **It does not read the `.env` file.** `pnpm server` does; these commands take `DATABASE_URL`
  from the environment only, and without it they open the embedded database. For a server on
  Postgres whose address is in `.env`, give it on the command line:
  `DATABASE_URL=postgres://… pnpm token list`.
- `--org <id>` names an organisation other than a self-hosted server's own, `default`.

## Signing in with Google or GitHub

With the [settings](server-configuration.md) for either (with Docker
Compose, put them in a `.env` file beside `docker-compose.yml`, which passes them on), an
admin adds
people by their email address on the Team page (`POST /api/v1/users`), and each signs in with
an account that has that address: a Google account's address, or any address GitHub has
verified for a GitHub account. Nothing is sent to anyone, and no password is kept: what is
asked of Google or GitHub is which account this is and which addresses are its. Signing in
lasts a week.

The first time someone signs in to an organisation, they are shown which one
it is and who added them, and asked; the account they sign in with then is from that time on
the only one that gets in as them there, whoever else comes to have the address. If that
account is gone, another admin lets them in with a new one from the Team page.

People then make the tokens for their own machines on the Connect page
(`POST /api/v1/me/tokens`). Without those settings there are only tokens, as above, and the
Team page has no list of people.

**Removing a person** ends their sign-in and revokes their `admin` and `member` tokens. A `ci`
token made under their address keeps reporting pull requests. An `env` token keeps working, and
a session it files under their address is not stored until they are added again. Revoke those
on the Team page if the token should stop too. Nobody can remove themselves. The confirmation
can also delete that person's sessions, and the repositories they stopped. Pull requests stay,
and a session that is gone is shown as "(deleted since)" on a pull request. While they stay
removed, a session filed under their address is not stored. Leaving the box unticked keeps the
sessions and the repositories they stopped. Ticking it forgets those repositories, so adding
the person again does not stop them.

**The owner** is who signed an organisation up on a hosted service; a server of your own has
none, and there the admin token from the environment is the owner for a download. An owner
cannot be removed, and only an admin who has signed in (not one with a token) can let an
owner in with a new account. For an owner with no other admin,
`pnpm person forget-account --email owner@example.com` does (with the embedded database,
stop the server first). `pnpm person list` shows the people there are. On a hosted service
the owner can download everything the organisation has, and can delete the organisation,
from the Team page. Deleting it signs everyone out at once. The rows go after 7 days.
`pnpm org restore <id>` undoes that within the 7 days, and `pnpm org purge` removes what is due.

## Organisations

Every token, session and pull request belongs to an organisation, and a
request sees only its own organisation's: each query names it, and row-level
security in the database enforces it underneath. A server you host for your team has one,
`default`, and you never see the word. A hosted service has one per sign-up:
[`infra/`](https://github.com/KIvanow/sessionly/blob/main/infra/README.md) is how
to run one.
