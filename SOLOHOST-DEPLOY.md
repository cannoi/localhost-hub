# Ofie Hub — Pi SoloHost / Docker

Published image: **`ghcr.io/cannoi/localhost-hub:latest`**

## SoloHost config (minimal)

Only two operator fields:

| Field | Env | Default | Notes |
|-------|-----|---------|--------|
| Management password | `HUB_SECRET` | empty | Required if Hub is reachable from the public Internet |
| Host port | `HOST_PORT` | **48080** | High port to avoid conflicts with 8080/8090 services |

Container always listens on **8080** internally. Host maps `${HOST_PORT}:8080`.

## Security model (read before exposing the port)

- **If `HUB_SECRET` is set, it is the only way to use management APIs** (`/api/hub`, `/api/logs`, chat state).
  The browser asks for it once (stored in this browser only) and sends it in the `x-hub-secret` header.
- **If `HUB_SECRET` is empty**, management is allowed only when the TCP peer is a private/loopback address
  *and* the request was not relayed (no `X-Forwarded-*`). Client headers such as `Host`, `Origin`,
  `X-Forwarded-For` are never trusted by themselves. If the runtime cannot report the peer, access is denied.
- **Docker caveat:** published ports can make every client look like the private Docker gateway (172.x).
  **Always set `HUB_SECRET` before forwarding the port to the Internet.**
- Behind a reverse proxy you control, either set `HUB_SECRET` (recommended) or `HUB_TRUST_PROXY=1`
  (then every address in `X-Forwarded-For` must be private).
- Public website content is only `/api/vhost/{slug}/` (CSP `sandbox`, `nosniff`). `/health` returns liveness only to the public.
- Private keys live in `state.json` (mode 0600, directory 0700, atomic writes with `.bak`). Backups **contain private keys** — store offline.
- Dynamic apps still run as child processes of the Hub (no container isolation); they get a minimal environment (no `HUB_SECRET`).

## Domain / TLS (honest model)

- The Hub stores **domain metadata** only (`customDomain`). Host-header routing for custom domains is **not wired to a
  route and not verified end-to-end**; use `/api/vhost/{slug}/` through your reverse proxy path rewrite until it is.
- DNS and TLS certificates are your reverse proxy's job. The Hub never fakes certificates.

## Local test

```sh
export HOST_PORT=48080
export HUB_SECRET=change-me
docker compose up -d
curl -s http://127.0.0.1:48080/health
```

Persistent data: Docker volume `hub-data` → `/data/ofie-hub` (state.json, sites, apps).
