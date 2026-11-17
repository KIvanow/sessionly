#!/usr/bin/env bash
# Every commit in the range must carry "Signed-off-by:" with its author's name and email (DCO).
# Usage: scripts/check-signoff.sh <base>..<head>   (no argument: every commit on HEAD)
set -euo pipefail
range="${1:-HEAD}"
# Commits from before sign-off was required; they are on the public main branch, so they are
# skipped by date rather than rewritten.
required_since=1794602000   # 2026-11-13, when CONTRIBUTING.md adopted the DCO
# Commits that reached main without a sign-off after that, on 2026-11-16. They are skipped for
# the same reason, each by name: this list is not to grow.
excepted="
a496c0228fb7eb28c158f858ba367c1ea5fc8b53
5f945d760285298129e7c793de1e9ea75b69a182
0bc83b1f2336ddbb31d71630dc32452d6de24d67
ee382e7e33a7328e713af1a33d46dcb4555e23d7
"
fail=0
for sha in $(git rev-list --no-merges "$range"); do
  [ "$(git log -1 --format=%ct "$sha")" -lt "$required_since" ] && continue
  case "$excepted" in *"$sha"*) continue ;; esac
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
