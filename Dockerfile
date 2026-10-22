# witden platform image: one image, three processes (see docker-compose.yml)
#   api      node packages/server/dist/cli.js serve --role api      REST API, console, runner hub, execution gateway
#   worker   node packages/server/dist/cli.js serve --role worker   agent loops; no Docker access
#   manager  node packages/manager/dist/main.js                     the only process that talks to Docker
# The AI computers are separate images (images/shell, images/desktop).

# The Computer Runner, built exactly like the computer images' own copy (images/shell/Dockerfile): the manager
# installs it into the runner volume the computers mount read-only (packages/manager/src/live-runner.ts).
FROM node:22-bookworm-slim AS runner
WORKDIR /build
COPY package-lock.json /build/lock.json
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund $(node -p "const p=require('./lock.json').packages; \
      ['esbuild','ws','playwright-core'].map((n) => n + '@' + p['node_modules/' + n].version).join(' ')")
COPY packages/shared/src packages/shared/src
COPY packages/runner/src packages/runner/src
COPY packages/runner/build.mjs packages/runner/
RUN node packages/runner/build.mjs --outdir /opt/witden/runner --with-playwright-core

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/
COPY packages/manager/package.json packages/manager/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @witden/shared -w @witden/manager -w @witden/server -w @witden/web \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf packages/runner packages/web/src packages/web/node_modules packages/*/src packages/*/test

FROM node:22-bookworm-slim
ENV NODE_ENV=production WITDEN_DATA_DIR=/data WITDEN_WEB_DIST=/app/packages/web/dist
WORKDIR /app
COPY --from=build /app /app
COPY --from=runner /opt/witden/runner /opt/witden/runner-dist
# /tunnel: the Cloudflare Tunnel token, shared read-only with the optional "tunnel" service
RUN mkdir -p /data /tunnel && chown node:node /data /tunnel
USER node
VOLUME ["/data"]
EXPOSE 8320 8330
CMD ["node", "packages/server/dist/cli.js", "serve"]
