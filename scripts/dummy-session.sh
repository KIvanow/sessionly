#!/usr/bin/env bash
# Runs a short headless Claude Code session in this project so the Sessionly
# hooks fire. Install them first (sessionly install), then watch the events
# live in another terminal with: sessionly watch
set -euo pipefail
cd "$(dirname "$0")"

claude -p "Do these steps in order, one tool call each, and keep going if a step fails:
1. Run the shell command: echo hello-from-dummy
2. Read the file README.md (just the first 5 lines).
3. Run the shell command: ls ./definitely-not-a-real-path
4. Write a file named scratch.txt containing 'hi'.
5. Use a subagent (Agent tool) to run: echo hello-from-subagent
Then reply with one short sentence summarizing which steps succeeded." \
  --allowedTools "Bash(echo:*)" "Bash(ls:*)" "Read" "Agent"
