# Desktop computer: Xvfb + Fluxbox + Chromium, driven by the Computer Runner (xdotool, ImageMagick, CDP) and
# observed over VNC. Two VNC servers listen on localhost only: 5900 (control) and 5901 (view-only); the platform
# reaches them through the runner's loopback streams, so the desktop is never exposed directly.
# It carries the same development tools as images/shell, so a desktop computer is also a development computer.
# Build from the repository root:  docker build -f images/desktop/Dockerfile -t witden/computer-desktop:latest .
#
# Everything, supervisord included, runs as the unprivileged user `witden` (uid 1000). witden-init starts
# supervisord without the runner token and the runner with it; see images/shell/Dockerfile and
# packages/runner/src/init.ts for how the token is kept from the rest of the computer, and for system packages.

# --- runner bundle ------------------------------------------------------------------------------------------
# The image's own copy of the runner, built as in images/shell/Dockerfile (and the platform image).
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
RUN node packages/runner/build.mjs --outdir /opt/witden/runner --with-playwright-core

# --- computer -----------------------------------------------------------------------------------------------
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox xterm xdotool imagemagick x11-utils dbus-x11 \
      chromium fonts-noto-cjk fonts-dejavu-core supervisor socat \
      bash ca-certificates curl wget git tmux procps less vim-tiny nano \
      python3 python3-pip python3-venv build-essential pkg-config \
      ripgrep jq unzip zip xz-utils openssh-client file tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -u 1000 witden \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --no-first-run"' \
      > /etc/chromium.d/witden-container

# Node.js 22 with npm, as in the shell image; the runner uses the same binary.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
COPY --from=runner /opt/witden/runner /opt/witden/runner
# Execute-only copies for the processes that hold the runner token (tini as PID 1, witden-init, the runner).
RUN install -d -m 755 /opt/witden/bin \
 && install -m 111 /usr/local/bin/node /opt/witden/bin/node \
 && install -m 111 /usr/bin/tini /opt/witden/bin/tini
# Tells the platform to start this image without Docker's own init, which would hold the token readably.
LABEL witden.init="protected"
# Login and interactive shells load the computer's model proxy settings when the platform enabled it.
COPY images/common/model-proxy.sh /etc/profile.d/witden-model-proxy.sh
RUN echo '. /etc/profile.d/witden-model-proxy.sh' >> /etc/bash.bashrc

COPY images/desktop/supervisord.conf /etc/witden/supervisord.conf
COPY images/desktop/fluxbox-startup /home/witden/.fluxbox/startup
# Plain background: the default style tries to set a wallpaper and pops up an error dialog without one,
# which would confuse a role reading the screen.
COPY images/desktop/fluxbox-overlay /home/witden/.fluxbox/overlay
# fbsetbg cannot set the style's wallpaper in this minimal image and would pop up an error dialog; use a solid colour.
RUN chown -R witden:witden /home/witden/.fluxbox && chmod +x /home/witden/.fluxbox/startup \
 && printf '#!/bin/sh\nexec fbsetroot -solid "#2f3b45"\n' > /usr/bin/fbsetbg

# Global npm / pip installs go to ~/.local, as in the shell image.
ENV NPM_CONFIG_PREFIX=/home/witden/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/home/witden/.local/bin:$PATH

# The image's own packages: the platform never removes them (see the Docker Manager's packages), and they are
# marked manually installed, so removing a later package with --auto-remove cannot take one of them along.
RUN dpkg-query -W -f='${Package}\n' | sort > /opt/witden/image-packages \
 && apt-mark manual $(cat /opt/witden/image-packages) >/dev/null

USER witden
WORKDIR /home/witden
# The command is the service witden-init keeps running next to the runner.
# Through sh: Docker's capabilities still count when it starts PID 1, which makes tini readable to it and so
# inspectable; started again by sh, which has none, tini is protected like the rest.
ENTRYPOINT ["/bin/sh", "-c", "exec /opt/witden/bin/tini -- /opt/witden/bin/node /opt/witden/runner/witden-init.mjs \"$@\"", "witden-init"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/witden/supervisord.conf"]
