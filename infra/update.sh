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
# answering: nothing has changed, and this exits 1. Only the copies a run
# starts are waited for, and only they are removed for not answering. Every
# other copy stays until enough new ones answer, and then goes, whatever it
# was and whether it answers or not: when the database is away for a while,
# the copies there are must still be there when it is back, and what an
# earlier run left half done is cleared away by the next one that works. So
# it can be run again from wherever an earlier run stopped, however that run
# ended. A copy is old or new by what it is (its image, and how it is set
# up), not by when it was started.
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
#            starting, cut off from its database for now, or left by a run
#            that was killed
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

# Wait for each copy given to answer. Fails once one of them has stopped,
# keeps being restarted, or was found not answering after its time to start,
# or when the time for all of them is up.
await() {
  until=$(($(date +%s) + patience))
  while :; do
    waiting=""
    for id in "$@"; do
      is="$(docker inspect --format \
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id" 2> /dev/null || echo gone)"
      case "$is" in
        "running healthy "*) ;;
        "running starting "[012] | "restarting starting "[012] | "created "*) waiting="$waiting $id" ;;
        *) return 1 ;;
      esac
    done
    [ -n "$waiting" ] || return 0
    [ "$(date +%s)" -lt "$until" ] || return 1
    sleep 1
  done
}

for id in $(ids gone); do docker rm -f "$id" > /dev/null; done
# Every copy there is before this run. Whatever fails, none of these is removed.
before="$(compose ps -aq server)"
# The ones that already are what they should be, and answer.
keep="$(ids new | head -n "$copies")"
missing=$((copies - $(echo $keep | wc -w)))

if [ "$missing" -gt 0 ]; then
  # The new ones start beside whatever is there, which keeps answering
  # meanwhile. Whichever new one is first brings the database up to date.
  started=""
  # Stopped by hand, this takes back what it started. (Killed outright it
  # cannot, and the next run that works clears up.)
  undo() {
    for id in $started; do docker rm -f "$id" > /dev/null 2>&1 || true; done
  }
  trap 'undo; exit 1' INT TERM HUP
  compose up -d --no-deps --no-recreate --scale "server=$(($(echo $before | wc -w) + missing))" server
  for id in $(compose ps -aq server); do
    case " $(echo $before) " in *" $id "*) ;; *) started="$started $id" ;; esac
  done
  # shellcheck disable=SC2086
  if ! await $started; then
    echo >&2
    echo "Not every new copy of the server came up. The last each one that is not answering said:" >&2
    for id in $started; do
      case " $(ids new | tr '\n' ' ') " in *" $id "*) continue ;; esac
      echo "--- $id" >&2
      docker logs --tail 20 "$id" >&2 2>&1 || true
    done
    undo
    echo >&2
    echo "The copies this run started have been removed. The $(echo $before | wc -w) there were before are as they were; nothing else was changed." >&2
    exit 1
  fi
  trap - INT TERM HUP
  keep="$keep $started"
fi

# Caddy sends to those from here on. If it cannot be told, nothing is
# removed: every copy goes on running until this is run again.
# shellcheck disable=SC2086
list $keep
if ! take_up; then
  echo "Caddy did not take up the new copies (docker compose logs caddy). The old ones are still answering; run this again." >&2
  exit 1
fi

# Every other copy goes: the ones of another version, the ones an earlier
# run left that never answered, and those there are too many of. One that
# answers finishes what it is answering first.
for id in $(compose ps -aq server); do
  case " $(echo $keep) " in *" $id "*) continue ;; esac
  if [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" = healthy ]; then
    docker stop "$id" > /dev/null
  fi
  docker rm -f "$id" > /dev/null
done

# Caddy is started if it was not running, and made anew if its image or its
# part of the compose file changed, which closes the front door for the few
# seconds that takes. A change to the Caddyfile alone it only reads again.
compose up -d --no-deps --wait --wait-timeout "$patience" caddy
take_up || echo "Caddy did not take up its Caddyfile; see: docker compose logs caddy" >&2
compose ps
