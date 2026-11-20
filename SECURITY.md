# Security

## Reporting a vulnerability

If you believe you have found a security problem in Sessionly (the `sessionly` binary, the
server, the dashboard, the GitHub Action) or on [sessionly.dev](https://sessionly.dev), please
email [kristiyan@sessionly.dev](mailto:kristiyan@sessionly.dev) with enough detail to
reproduce it, rather than opening a public issue. I read that address myself.

Please give me a reasonable window to fix the issue before you publish it, and do not access,
change or delete other people's data while demonstrating it. There is no bug bounty.

## Supported versions

Fixes go into the newest release. `sessionly update` brings a binary to it, and each release
has a server image, `ghcr.io/kivanow/sessionly-server:v<version>`.

What the binary and the server keep, send and protect is described at
[sessionly.dev/security](https://sessionly.dev/security).
