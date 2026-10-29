# Multi-arch: build with
#   docker buildx build --platform linux/amd64,linux/arm64 -t ofie-hub .
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/sites /data/apps \
  && chown -R node:node /data
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080 \
    P2P_PORT=8090 \
    DATA_DIR=/data \
    NODE_ENV=production
EXPOSE 8080 8090
USER node
VOLUME ["/data"]
CMD ["node", "server.js"]
