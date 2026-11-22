#!/bin/sh
# Sessionly capture for cloud agent sessions. https://sessionly.dev
#
# Written by `sessionly install --repo` (sessionly 0.7.1). To update it,
# run that again with a newer sessionly rather than editing it.
#
# The hooks in .claude/settings.json and .cursor/hooks.json run this on every
# hook event, with the event on standard input. Codex's cloud runs no hooks:
# there the agent runs it, as AGENTS.md asks, before and after a turn's work.
#
# - On a person's own machine it does nothing. Sessions there are captured by
#   that person's own `sessionly install`, if they have one.
# - In a Claude Code cloud session, a Cursor cloud agent or a Codex cloud
#   task it fetches the sessionly binary once per sandbox, checks it against the checksum below,
#   and hands it the event. Where sessions are sent is up to the sandbox's
#   environment (SESSIONLY_URL and SESSIONLY_TOKEN); without those nothing
#   leaves the sandbox.
#
# It prints nothing and always exits 0, so it cannot block or change a session.

VERSION=0.7.1
BASE=https://github.com/KIvanow/sessionly/releases/download
SHA256_X86_64=1562bac5dad439e11a601a579a1045d02b5f6f2911893a39e0f6829dc2a9a962
SHA256_AARCH64=a73996b8430ff6a9ea2406715b3eeb838d1bf97e15de67ca43b0c944e69d7c03

case "${1:-}" in
  # Cursor's cloud also runs the hooks in .claude/settings.json. There the
  # entry in .cursor/hooks.json is the one that captures.
  claude) [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -z "${CURSOR_VERSION:-}" ] || exit 0 ;;
  cursor) [ -S "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" ] || exit 0 ;;
  # Codex names its thread to every command, on a person's machine too. The
  # cloud environment it names only in its cloud.
  codex) [ -n "${CODEX_THREAD_ID:-}" ] && [ -n "${CODEX_ENVIRONMENT_ID:-}" ] || exit 0 ;;
  *) exit 0 ;;
esac

home="${SESSIONLY_HOME:-$HOME/.sessionly}"
# Codex runs its commands in a sandbox of its own, which may not let them
# write to the home directory.
if [ "$1" = codex ] && [ -z "${SESSIONLY_HOME:-}" ] &&
  ! { mkdir -p "$home" && [ -w "$home" ]; } 2> /dev/null; then
  home="${TMPDIR:-/tmp}/sessionly-$(id -u)"
  SESSIONLY_HOME="$home"
  export SESSIONLY_HOME
fi
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
    note "installed sessionly $VERSION ($$)"
    return 0
  else
    note "could not unpack the download"
  fi
  rm -rf "$tmp"
  : > "$failed"
  return 1
}

# Hooks run in parallel: one downloads while the others wait for it.
#
# The lock is a file that this shell creates only if it is not there yet
# (set -C): one system call, made by the shell itself. It used to be a folder
# made with mkdir. Where several hooks asked at the same moment, each was
# told it had made the folder, and two of them downloaded: seen on Ubuntu
# 26.04, whose mkdir is not GNU's, and never where it is.
#
# Each step is noted with the process it was, in bootstrap.log, so that a
# sandbox where two hooks still download shows how. It is a few lines, once
# per sandbox.
fetch() {
  mkdir -p "$home/bin" && chmod 700 "$home" || return 1
  lock="$home/bin/fetching.lock"
  waited=0
  until (set -C && : > "$lock") 2> /dev/null; do
    if [ -x "$bin" ]; then
      note "$$ stopped waiting for the lock after $waited waits: the binary is there"
      return 0
    fi
    waited=$((waited + 1))
    if [ "$waited" -gt 300 ]; then
      # Half a minute: whoever is downloading was killed, or is too slow to
      # wait for. This event is not captured; the next hook may try.
      rm -f "$lock"
      note "$$ waited half a minute for the lock, removed it and gave up"
      return 1
    fi
    sleep 0.1
  done
  if [ -x "$bin" ]; then
    note "$$ took the lock after $waited waits: the binary is there"
  else
    note "$$ took the lock after $waited waits: no binary yet, downloading"
    download
    note "$$ finished downloading ($?)"
  fi
  if rm "$lock" 2> /dev/null; then
    note "$$ released the lock"
  else
    note "$$ found the lock gone when releasing it"
  fi
}

[ -x "$bin" ] || fetch > /dev/null 2>&1
[ -x "$bin" ] || exit 0
if [ "$1" = codex ]; then
  "$bin" turn "${2:-}" < /dev/null > /dev/null 2>&1
else
  "$bin" capture > /dev/null 2>&1
fi
exit 0
