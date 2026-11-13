#!/usr/bin/env bash
# Every commit in the range must carry "Signed-off-by:" with its author's name and email (DCO).
# Usage: scripts/check-signoff.sh <base>..<head>   (no argument: every commit on HEAD)
set -euo pipefail
range="${1:-HEAD}"
# Commits from before sign-off was required; they are on the public main branch, so they are
# skipped by date rather than rewritten.
required_since=1794602000   # 2026-11-13, when CONTRIBUTING.md adopted the DCO
fail=0
for sha in $(git rev-list --no-merges "$range"); do
  [ "$(git log -1 --format=%ct "$sha")" -lt "$required_since" ] && continue
  author="$(git log -1 --format='%an <%ae>' "$sha")"
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -qxF "$author"; then
    echo "::error::commit $(git log -1 --format='%h %s' "$sha") has no 'Signed-off-by: $author'"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "Sign off your commits (git commit -s; to fix a branch: git rebase --signoff <base>)."
  exit 1
fi
echo "All commits in $range are signed off."
