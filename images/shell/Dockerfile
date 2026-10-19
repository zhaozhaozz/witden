# Development computer: shell tools plus the Computer Runner, which executes the platform's operations
# (commands, terminals, files, agent processes) inside this container.
# Build from the repository root:  docker build -f images/shell/Dockerfile -t witden/computer-shell:latest .
#
# Everything runs as the unprivileged user `witden` (uid 1000), the runner included. Isolation also comes from
# the platform's container settings (dropped capabilities, no-new-privileges, no host mounts). The runner token
# is kept from the rest of the computer by witden-init (packages/runner/src/init.ts): only the runner gets it,
# and every process holding it runs from an execute-only binary, which other processes cannot inspect.
# `witden` may run `sudo apt-get` without a password when the template allows it (sudo_apt): the platform then
# starts the container without no-new-privileges, and that user is root in the computer.

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
RUN node packages/runner/build.mjs --outdir /opt/witden/runner \
 && mkdir -p /opt/witden/runner/node_modules \
 && cp -r node_modules/playwright-core /opt/witden/runner/node_modules/

# --- computer -----------------------------------------------------------------------------------------------
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git tmux procps less vim-tiny nano \
      python3 python3-pip python3-venv build-essential pkg-config \
      ripgrep jq unzip zip xz-utils openssh-client file tini sudo \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -u 1000 witden \
 && mkdir -p /workspace && chown witden:witden /workspace
COPY images/common/sudoers-apt /etc/sudoers.d/witden-apt
RUN chmod 0440 /etc/sudoers.d/witden-apt

# Node.js 22 with npm for roles; the runner uses the same binary.
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

# Roles are not root: global npm / pip installs go to ~/.local.
ENV NPM_CONFIG_PREFIX=/home/witden/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/home/witden/.local/bin:$PATH

USER witden
WORKDIR /home/witden
# Through sh: Docker's capabilities still count when it starts PID 1, which makes tini readable to it and so
# inspectable; started again by sh, which has none, tini is protected like the rest.
ENTRYPOINT ["/bin/sh", "-c", "exec /opt/witden/bin/tini -- /opt/witden/bin/node /opt/witden/runner/witden-init.mjs \"$@\"", "witden-init"]
CMD []
