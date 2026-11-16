#!/bin/sh
# Probe: run this as the environment's setup (install) script:
#
#     sh probe/codex-cloud-setup.sh
#
# It leaves three things for the task to find: a line in ~/.bashrc, a hooks
# file in ~/.codex, and a note of what the setup script itself could see.
repo=$(pwd)
note=/tmp/sessionly-probe-setup.log
{
  echo "setup ran at $(date -u +%FT%TZ) in $repo as $(id -un) home=$HOME"
  echo "setup saw these SESSIONLY_ variables (name and length only):"
  env | grep '^SESSIONLY_' | while IFS='=' read -r name value; do
    echo "  $name (${#value} characters)"
  done
  echo "setup: codex is $(command -v codex || echo 'not on PATH')"
  echo "setup: ~/.codex has: $(ls -A "$HOME/.codex" 2>/dev/null | tr '\n' ' ')"
} >"$note" 2>&1

echo 'export SESSIONLY_PROBE_BASHRC=yes' >>"$HOME/.bashrc"

# A user-level hooks file, to tell apart "the cloud runs no hooks" from "it
# runs none of a repository's". One that is already there is left alone.
mkdir -p "$HOME/.codex"
if [ ! -e "$HOME/.codex/hooks.json" ]; then
  hook="sh $repo/probe/codex-cloud-hook.sh user"
  cat >"$HOME/.codex/hooks.json" <<EOF
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "$hook SessionStart" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "$hook PreToolUse" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "$hook Stop" }] }]
  }
}
EOF
  echo "setup: wrote ~/.codex/hooks.json" >>"$note"
else
  echo "setup: ~/.codex/hooks.json was already there, left alone" >>"$note"
fi
exit 0
