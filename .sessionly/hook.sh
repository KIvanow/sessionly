#!/bin/sh
# Sessionly capture for cloud agent sessions. https://sessionly.dev
#
# Written by `sessionly install --repo` (sessionly 0.3.1). To update it,
# run that again with a newer sessionly rather than editing it.
#
# The hooks in .claude/settings.json and .cursor/hooks.json run this on every
# hook event, with the event on standard input.
#
# - On a person's own machine it does nothing. Sessions there are captured by
#   that person's own `sessionly install`, if they have one.
# - In a Claude Code cloud session or a Cursor cloud agent it fetches the
#   sessionly binary once per sandbox, checks it against the checksum below,
#   and hands it the event. Where sessions are sent is up to the sandbox's
#   environment (SESSIONLY_URL and SESSIONLY_TOKEN); without those nothing
#   leaves the sandbox.
#
# It prints nothing and always exits 0, so it cannot block or change a session.

VERSION=0.3.1
BASE=https://github.com/KIvanow/sessionly/releases/download
SHA256_X86_64=8edc55a6c740de735f32e192432d4a3c94129f958f9059f628c07b90eb61fca4
SHA256_AARCH64=60cd5eedbcf63186ce9c99758b4cf22374d486e55a572fdf162f579a05543eef

case "${1:-}" in
  # Cursor's cloud also runs the hooks in .claude/settings.json. There the
  # entry in .cursor/hooks.json is the one that captures.
  claude) [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -z "${CURSOR_VERSION:-}" ] || exit 0 ;;
  cursor) [ -S "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" ] || exit 0 ;;
  *) exit 0 ;;
esac

home="${SESSIONLY_HOME:-$HOME/.sessionly}"
bin="$home/bin/sessionly-$VERSION"

note() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$home/bootstrap.log"
}

get() {
  if command -v curl > /dev/null; then
    curl -fsSL --retry 2 --max-time 60 -o "$2" "$1"
  else
    wget -q -T 60 -O "$2" "$1"
  fi
}

checksum() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

download() {
  failed="$home/bin/failed-$VERSION"
  # A download that failed is not tried again for ten minutes.
  [ -n "$(find "$failed" -mmin -10 2> /dev/null)" ] && return 1
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target=x86_64-unknown-linux-musl want=$SHA256_X86_64 ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl want=$SHA256_AARCH64 ;;
    *) target= want= ;;
  esac
  tmp="$home/bin/download-$$"
  rm -rf "$tmp"
  if [ -z "$want" ]; then
    note "no sessionly $VERSION binary for $(uname -s) $(uname -m)"
  elif ! mkdir "$tmp" || ! get "$BASE/v$VERSION/sessionly-$target.tar.gz" "$tmp/sessionly.tar.gz"; then
    note "could not download $BASE/v$VERSION/sessionly-$target.tar.gz"
  elif [ "$(checksum "$tmp/sessionly.tar.gz")" != "$want" ]; then
    note "the download does not match its checksum; not using it"
  elif tar -xzf "$tmp/sessionly.tar.gz" -C "$tmp" sessionly && chmod 755 "$tmp/sessionly" &&
    mv "$tmp/sessionly" "$bin"; then
    rm -rf "$tmp" "$failed"
    note "installed sessionly $VERSION"
    return 0
  else
    note "could not unpack the download"
  fi
  rm -rf "$tmp"
  : > "$failed"
  return 1
}

# Hooks run in parallel: one downloads while the others wait for it.
fetch() {
  mkdir -p "$home/bin" && chmod 700 "$home" || return 1
  lock="$home/bin/fetching"
  waited=0
  until mkdir "$lock" 2> /dev/null; do
    [ -x "$bin" ] && return 0
    waited=$((waited + 1))
    if [ "$waited" -gt 300 ]; then
      # Half a minute: whoever is downloading was killed, or is too slow to
      # wait for. This event is not captured; the next hook may try.
      rmdir "$lock" 2> /dev/null
      return 1
    fi
    sleep 0.1
  done
  [ -x "$bin" ] || download
  rmdir "$lock" 2> /dev/null
}

[ -x "$bin" ] || fetch > /dev/null 2>&1
[ -x "$bin" ] && "$bin" capture > /dev/null 2>&1
exit 0
