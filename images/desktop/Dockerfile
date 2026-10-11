# Desktop computer: Xvfb + Fluxbox + Chromium, driven by the Computer Runner (xdotool, ImageMagick, CDP) and
# observed over VNC. Two VNC servers listen on localhost only: 5900 (control) and 5901 (view-only); the platform
# reaches them through the runner's loopback streams, so the desktop is never exposed directly.
# Build from the repository root:  docker build -f images/desktop/Dockerfile -t witden/computer-desktop:latest .
#
# supervisord runs as root only to start every program as the unprivileged user `witden` (uid 1000);
# the runner, the X server and the browser all run as witden.

# --- runner bundle ------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /build
COPY package-lock.json /build/lock.json
# Same dependency versions as the repository lockfile.
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund $(node -p "const p=require('./lock.json').packages; \
      ['esbuild','ws','playwright-core'].map((n) => n + '@' + p['node_modules/' + n].version).join(' ')")
COPY packages/shared/src packages/shared/src
COPY packages/runner/src packages/runner/src
COPY packages/runner/build.mjs packages/runner/
RUN node packages/runner/build.mjs --outfile /opt/witden/runner/witden-runner.mjs \
 && mkdir -p /opt/witden/runner/node_modules \
 && cp -r node_modules/playwright-core /opt/witden/runner/node_modules/

# --- computer -----------------------------------------------------------------------------------------------
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox xterm xdotool imagemagick x11-utils dbus-x11 \
      chromium fonts-noto-cjk fonts-dejavu-core \
      supervisor socat tmux procps ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -u 1000 witden \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --no-first-run"' \
      > /etc/chromium.d/witden-container

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=runner /opt/witden/runner /opt/witden/runner

COPY images/desktop/supervisord.conf /etc/supervisor/conf.d/witden.conf
COPY images/desktop/fluxbox-startup /home/witden/.fluxbox/startup
# Plain background: the default style tries to set a wallpaper and pops up an error dialog without one,
# which would confuse a role reading the screen.
COPY images/desktop/fluxbox-overlay /home/witden/.fluxbox/overlay
# fbsetbg cannot set the style's wallpaper in this minimal image and would pop up an error dialog; use a solid colour.
RUN chown -R witden:witden /home/witden/.fluxbox && chmod +x /home/witden/.fluxbox/startup \
 && printf '#!/bin/sh\nexec fbsetroot -solid "#2f3b45"\n' > /usr/bin/fbsetbg

WORKDIR /home/witden
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
