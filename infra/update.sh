#!/bin/sh
# Bring the service to another version without a gap: new copies of the
# server start beside the old ones, and the old ones leave only once the new
# ones answer. Run it in this folder, after changing SESSIONLY_VERSION in
# .env (or after `git pull`, with --build to build this checkout).
#
#   ./update.sh            # run the image SESSIONLY_VERSION names
#   ./update.sh --build    # build this checkout and run that
set -eu
cd "$(dirname "$0")"

compose() {
  # SESSIONLY_COMPOSE lets a test name its own files.
  ${SESSIONLY_COMPOSE:-docker compose --env-file .env -f docker-compose.hosted.yml} "$@"
}

copies="$(compose config --format json | sed -n 's/.*"replicas": *\([0-9][0-9]*\).*/\1/p' | head -1)"
copies="${copies:-2}"
old="$(compose ps -q server)"

if [ "${1:-}" = --build ]; then
  compose build server
else
  compose pull server
fi

# Twice as many for a moment: the old keep answering while the new start,
# and whichever new one is first brings the database up to date.
compose up -d --no-deps --no-recreate --scale "server=$((copies * 2))" --wait server

# The old ones finish what they are answering and go. Caddy sends what was
# meant for them to the others.
if [ -n "$old" ]; then
  # shellcheck disable=SC2086
  docker stop $old > /dev/null
  # shellcheck disable=SC2086
  docker rm $old > /dev/null
fi

# Back to the usual number, and Caddy too if its part changed.
compose up -d --no-recreate --scale "server=$copies" --wait
compose ps
