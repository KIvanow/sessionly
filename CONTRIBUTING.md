# Contributing

Thanks for helping. Bug reports, price updates and pull requests are all welcome.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO), not a CLA. Every commit must carry a sign-off line that matches its author:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. CI rejects commits without one. To fix a branch:
`git rebase --signoff main` and force-push.

By signing off you certify the DCO 1.1: that you wrote the change or have the right to submit it
under the license of the part of the repository it touches.

## Licenses

- Everything outside `ee/` is Apache-2.0 (`LICENSE`).
- `ee/` is under `LICENSE-EE`.
- Code outside `ee/` must never import from `ee/`; CI checks this. Capture, the local ledger,
  the command line, upload, the server and the dashboard must work with no license present.
  `ee/` plugs in through the server's extension points (`extensions` and `prepare` in
  `apps/server/src/run.ts`).

## Before you open a pull request

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## Prices

Model prices live in `crates/sessionly/src/pricing.rs`. Never guess one: a model without a
published price stays out of the table, and its requests are reported as unpriced.
