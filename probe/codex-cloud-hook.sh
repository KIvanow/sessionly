#!/bin/sh
# Probe: what a hook is run with. Called as: codex-cloud-hook.sh <where> <event>
# <where> is "repo" for the repository's .codex/hooks.json and "user" for the
# one the setup script puts in ~/.codex. Writes one line per run, never prints,
# always exits 0.
log=/tmp/sessionly-probe-hooks.log
{
  printf '%s where=%s event=%s cwd=%s payload=' "$(date -u +%FT%TZ)" "$1" "$2" "$(pwd)"
  # the payload names the session and its transcript: the start is enough
  head -c 700 | tr '\n' ' '
  printf '\n'
} >>"$log" 2>/dev/null
exit 0
