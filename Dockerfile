# SoloHost-compatible production image.
# No privileged mode. No host network. Runs as unprivileged node user.
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NITRO_PRESET=node-server \
    VITE_AUTH_ENABLED=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# node-server preset must emit `.output/server/index.mjs` (see vite.config.ts)
RUN npm run build \
 && test -f .output/server/index.mjs \
 && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NITRO_PRESET=node-server \
    HOST=0.0.0.0 \
    PORT=8080 \
    HUB_DATA_DIR=/data/ofie-hub

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/ofie-hub/sites /data/ofie-hub/apps \
 && chown -R node:node /app /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
