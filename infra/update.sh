#!/bin/sh
# Start the service, or bring it to another version without a gap. New
# copies of the server start beside the old ones; once they answer, Caddy is
# told to send to them, and only then do the old ones leave. Run it in this
# folder: for the first start, after changing SESSIONLY_VERSION or anything
# else in .env, or after `git pull` (with --build to build this checkout).
#
#   ./update.sh            # run the image SESSIONLY_VERSION names
#   ./update.sh --build    # build this checkout and run that
#
# If the new copies do not come up, they are removed and the old ones go on
# answering: nothing has changed, and this exits 1. A copy that is running
# is never removed for not answering, only replaced once its replacement
# does: when the database is away for a while, the copies there are must
# still be there when it is back. It can be run again from
# wherever an earlier run stopped, cut short or not. A copy is old or new by
# what it is (its image, and how it is set up), not by when it was started.
#
# Caddy sends to the copies named in caddy/copies, which this writes. So
# start, update and change the number of copies with this script and not
# with `docker compose up`, and run it again after `docker compose down`.
set -eu
cd "$(dirname "$0")"

compose() {
  # SESSIONLY_COMPOSE lets a test name its own files.
  ${SESSIONLY_COMPOSE:-docker compose --env-file .env -f docker-compose.hosted.yml} "$@"
}

# How long new copies get to answer, in seconds.
patience="${SESSIONLY_UPDATE_WAIT:-180}"

if [ "${1:-}" = --build ]; then
  compose build server
else
  compose pull server
fi

# What a copy of the server should now be.
image="$(compose config --images server | head -1)"
want_image="$(docker image inspect --format '{{.Id}}' "$image")"
want_setup="$(compose config --hash server | cut -d ' ' -f 2)"
copies="$(compose config --format json | sed -n 's/.*"replicas": *\([0-9][0-9]*\).*/\1/p' | head -1)"
copies="${copies:-2}"

# One line per copy of the server there is: its id and what it is.
#   new      what it should be, and answering
#   coming   what it should be and running, but not answering: still
#            starting, or cut off from its database for now. Left alone: it
#            may be all there is, and what would replace it fares no better.
#   old      something else, and running
#   gone     not running, and so serving nobody
survey() {
  for id in $(compose ps -aq server); do
    is="$(docker inspect --format \
      '{{.Image}} {{index .Config.Labels "com.docker.compose.config-hash"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
    case "$is" in
      "$want_image $want_setup running healthy") echo "$id new" ;;
      "$want_image $want_setup running "* | "$want_image $want_setup restarting "*) echo "$id coming" ;;
      *" running "* | *" restarting "*) echo "$id old" ;;
      *) echo "$id gone" ;;
    esac
  done
}
ids() { survey | sed -n "s/ $1\$//p"; }

# Write down which copies Caddy is to send to: the ones given, by name.
list() {
  names=""
  for id in "$@"; do
    names="$names $(docker inspect --format '{{.Name}}' "$id" | sed 's|^/||'):8080"
  done
  echo "to$names" > caddy/copies.next
  mv caddy/copies.next caddy/copies
}

# Have Caddy take up that list and its Caddyfile, without closing anything:
# requests it already passed on are finished where they are. At the first
# start it is not running yet, and reads both when it starts.
take_up() {
  [ -z "$(compose ps -q caddy)" ] || compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1
}

for id in $(ids gone); do docker rm -f "$id" > /dev/null; done
old="$(ids old)"
old_count="$(echo $old | wc -w)"
# The copies that already are what they should be, answering or about to.
have_count="$(echo $(ids new) $(ids coming) | wc -w)"
# Every copy there was before this run. Whatever fails, none of these is removed.
before="$(compose ps -aq server)"

if [ "$old_count" -gt 0 ] || [ "$have_count" -lt "$copies" ] || [ -n "$(ids coming)" ]; then
  # The new ones start beside the old, which keep answering meanwhile.
  # Whichever new one is first brings the database up to date. This also
  # waits for a copy that was not answering yet.
  wanted=$copies
  [ "$have_count" -gt "$wanted" ] && wanted=$have_count
  if ! compose up -d --no-deps --no-recreate --scale "server=$((old_count + wanted))" \
    --wait --wait-timeout "$patience" server; then
    echo >&2
    echo "Not every copy of the server came up. The last each one that is not answering said:" >&2
    for id in $(ids coming) $(ids gone); do
      echo "--- $id" >&2
      docker logs --tail 20 "$id" >&2 2>&1 || true
      # A copy this run started goes. One that was there before stays, to
      # answer again when whatever it is waiting for is back.
      case " $(echo $before) " in *" $id "*) ;; *) docker rm -f "$id" > /dev/null || true ;; esac
    done
    echo >&2
    echo "The copies this run started that did not come up have been removed. The $(echo $before | wc -w) there were before are as they were; nothing else was changed." >&2
    exit 1
  fi

  # Caddy sends to the new ones from here on. If it cannot be told, the old
  # ones stay: both go on running until this is run again.
  # shellcheck disable=SC2046
  list $(ids new)
  if ! take_up; then
    echo "Caddy did not take up the new copies (docker compose logs caddy). The old ones are still answering; run this again." >&2
    exit 1
  fi

  # The old ones finish what they are answering and go.
  for id in $old; do
    docker stop "$id" > /dev/null
    docker rm "$id" > /dev/null
  done
fi

# Every copy is now what it should be, so this leaves them alone and settles
# their number. Caddy is started if it was not running, and made anew if its
# image or its part of the compose file changed, which closes the front door
# for the few seconds that takes.
# shellcheck disable=SC2046
[ -e caddy/copies ] || list $(ids new)
compose up -d --scale "server=$copies" --wait --wait-timeout "$patience"
# The copies there are now, if their number was just settled, and whatever
# changed in the Caddyfile.
# shellcheck disable=SC2046
list $(ids new)
take_up || echo "Caddy did not take up its Caddyfile; see: docker compose logs caddy" >&2
compose ps
