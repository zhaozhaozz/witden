# Cloudflare Tunnel for the platform's public address: cloudflared plus a small supervisor that waits for the
# token the console writes, and restarts cloudflared when the token changes. Idle while there is none.
FROM cloudflare/cloudflared:2026.10.0 AS cloudflared

FROM alpine:3.22
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY run.sh /usr/local/bin/witden-tunnel
USER nobody
ENTRYPOINT ["/bin/sh", "/usr/local/bin/witden-tunnel"]
