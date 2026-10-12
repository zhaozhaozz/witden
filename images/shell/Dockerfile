# Development computer: shell tools plus the Computer Runner, which executes the platform's operations
# (commands, terminals, files, agent processes) inside this container.
# Build from the repository root:  docker build -f images/shell/Dockerfile -t witden/computer-shell:latest .
#
# Everything runs as the unprivileged user `witden` (uid 1000), the runner included. Isolation also comes from
# the platform's container settings (dropped capabilities, no-new-privileges, no host mounts).

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

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git tmux procps less vim-tiny nano \
      python3 python3-pip python3-venv build-essential pkg-config \
      ripgrep jq unzip zip openssh-client file \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -u 1000 witden \
 && mkdir -p /workspace && chown witden:witden /workspace

# Node.js 22 with npm for roles; the runner uses the same binary.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

COPY --from=runner /opt/witden/runner /opt/witden/runner
# Login and interactive shells load the computer's model proxy settings when the platform enabled it.
COPY images/common/model-proxy.sh /etc/profile.d/witden-model-proxy.sh
RUN echo '. /etc/profile.d/witden-model-proxy.sh' >> /etc/bash.bashrc
COPY --chmod=755 images/shell/runner-loop.sh /opt/witden/runner/runner-loop.sh

# Roles are not root: global npm / pip installs go to ~/.local.
ENV NPM_CONFIG_PREFIX=/home/witden/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/home/witden/.local/bin:$PATH

USER witden
WORKDIR /home/witden
CMD ["/opt/witden/runner/runner-loop.sh"]
