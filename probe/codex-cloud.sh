#!/bin/sh
# Probe: what a Codex cloud task has that Sessionly could capture a session
# from. Run inside the task and paste everything it prints. It changes
# nothing in the repository and prints no secret: variables are shown by name
# and length, files by name.
say() { printf '\n== %s\n' "$1"; }

say "1. where this runs"
echo "user=$(id -un) home=$HOME pwd=$(pwd)"
echo "shell: \$0=$0 flags=$-"
echo "parents: $(ps -o args= -p $PPID 2>/dev/null | cut -c1-200)"
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)  remote: $(git remote get-url origin 2>/dev/null | sed 's#//[^@]*@#//#')"
echo "git identity: $(git config user.name) <$(git config user.email)>"

say "2. what the setup script left (only there if it was run)"
cat /tmp/sessionly-probe-setup.log 2>/dev/null || echo "no /tmp/sessionly-probe-setup.log: /tmp did not carry over, or setup was not run"

say "3. did hooks run"
if [ -s /tmp/sessionly-probe-hooks.log ]; then
  echo "runs by where and event:"
  sed 's/^[^ ]* \(where=[^ ]*\) \(event=[^ ]*\).*/\1 \2/' /tmp/sessionly-probe-hooks.log | sort | uniq -c
  echo "first lines:"
  head -n 4 /tmp/sessionly-probe-hooks.log | cut -c1-900
else
  echo "no hook has run (no /tmp/sessionly-probe-hooks.log)"
fi

say "4. is ~/.bashrc read for the agent's commands"
echo "SESSIONLY_PROBE_BASHRC=${SESSIONLY_PROBE_BASHRC:-not set}"
grep -c SESSIONLY_PROBE_BASHRC "$HOME/.bashrc" 2>/dev/null | sed 's/^/lines in ~\/.bashrc that set it: /'

say "5. variables (name and length only)"
env | grep -E '^(SESSIONLY_|CODEX_|OPENAI_|CHATGPT_)' | while IFS='=' read -r name value; do
  echo "$name (${#value} characters)"
done | sort
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ]; then proxy=set; else proxy="not set"; fi
echo "proxy: HTTPS_PROXY is $proxy, SSL_CERT_FILE=${SSL_CERT_FILE:-not set}"

say "6. Codex itself, and its session files"
echo "codex: $(command -v codex || echo 'not on PATH') $(codex --version 2>/dev/null)"
echo "CODEX_HOME=${CODEX_HOME:-not set}"
echo "~/.codex has: $(ls -A "$HOME/.codex" 2>/dev/null | tr '\n' ' ')"
echo "processes that look like the agent:"
ps -eo pid,args 2>/dev/null | grep -iE 'codex|app-server' | grep -v grep | cut -c1-160 | head -n 8
# Where Codex could keep them, not the whole disk: that can take minutes.
places=$(for dir in "${CODEX_HOME:-}" "$HOME/.codex" /root/.codex /tmp /workspace /var/lib /opt; do
  [ -d "$dir" ] && echo "$dir"
done | sort -u)
found=$(echo "$places" | while read -r dir; do
  find "$dir" -maxdepth 8 -name 'rollout-*.jsonl*' -printf '%T@ %TY-%Tm-%TdT%TH:%TM %s bytes %p\n' 2>/dev/null
done | sort -rn | cut -d' ' -f2-)
echo "looked in: $(echo "$places" | tr '\n' ' ')"
echo "rollout files there (newest first):"
echo "${found:-none}" | head -n 8
newest=$(echo "$found" | grep '\.jsonl$' | head -n 1 | sed 's/^.* bytes //')
if [ -n "$newest" ]; then
  echo "record types in the newest one:"
  sed 's/"payload".*//' "$newest" | grep -o '"type":"[^"]*"' | sort | uniq -c
  echo "from its first record (who made it and the system prompt are left out):"
  for key in id session_id source thread_source originator cli_version history_mode cwd; do
    head -n 1 "$newest" | grep -o "\"$key\":\(\"[^\"]*\"\|{[^}]*}\)" | head -n 1
  done
fi

say "7. can the task reach the Sessionly server"
if command -v curl >/dev/null 2>&1; then
  for method in GET PUT; do
    path=/api/v1/ping
    [ "$method" = PUT ] && path=/api/v1/sessions/probe/codex/probe
    code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' -d '{}' "https://app.sessionly.dev$path" 2>&1)
    echo "$method $path -> $code   (401 means it got through; 000 or a proxy's 403 means blocked)"
  done
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -L https://github.com/KIvanow/sessionly/releases/latest 2>&1)
  echo "GET the releases page on github.com -> $code"
else
  echo "curl is not installed"
fi

say "done"
