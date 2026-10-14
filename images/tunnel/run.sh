#!/bin/sh
# Runs cloudflared with the tunnel token the console writes to the shared volume: nothing while there is
# no token, a restart when it is replaced or removed, and a retry 30 s after cloudflared exits.
set -u
TOKEN=/etc/witden-tunnel/token
pid=""
started=""  # checksum of the token cloudflared was started with

stop() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  pid=""
}
# Sleep in the background so a stop signal is handled at once.
pause() {
  sleep "$1" &
  wait $!
}
trap 'stop; exit 0' TERM INT

echo "witden tunnel: waiting for a token at $TOKEN"
while :; do
  current=""
  [ -s "$TOKEN" ] && current=$(cksum < "$TOKEN")
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null
    pid=""
    started=""
    echo "witden tunnel: cloudflared exited, retrying in 30 s"
    pause 30
    continue
  fi
  if [ "$current" != "$started" ]; then
    stop
    started=$current
    if [ -n "$current" ]; then
      echo "witden tunnel: starting cloudflared"
      cloudflared --no-autoupdate tunnel --metrics 0.0.0.0:2000 run --token-file "$TOKEN" &
      pid=$!
    else
      echo "witden tunnel: no token, cloudflared stopped"
    fi
  fi
  pause 5
done
