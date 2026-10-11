#!/bin/sh
# Container command of images without a process supervisor: keeps the Computer Runner running and
# forwards SIGTERM / SIGINT to it so `docker stop` shuts it down cleanly.
child=""
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child"; fi; exit 0' TERM INT

while :; do
  /usr/local/bin/node /opt/witden/runner/witden-runner.mjs "$@" &
  child=$!
  wait "$child"
  status=$?
  child=""
  echo "witden-runner exited with status $status; restarting in 2s" >&2
  sleep 2 &
  wait $!
done
