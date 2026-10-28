# Ofie Hub — Pi SoloHost / Docker

This package is prepared for a standard SoloHost Docker app on port `8080`.
The application runs as the unprivileged `node` user. It 
, 

## SoloHost

- Use this folder/repository as the app source.
- Container port: `8080`.
- Persistent data path: `/data` (the Hub state directory is `/data/ofie-hub`).
- Configure `HUB_DATA_DIR` only if you intentionally need a different writable
 persistent directory.
- Optional `HUB_SECRET` and `PEERS` are reserved for peer networking. This
 image exposes only the web port by default; do not assume P2P is externally
 reachable unless SoloHost explicitly publishes/configures it.

## Local Docker test

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
```

Open `http://localhost:8080`. Persistent Hub state is kept in the `hub-data`
volume. Never place credentials or private keys in the source tree or ZIP.

## Notes

- The default Nitro deployment preset remains `vercel`; the Docker build sets
 `NITRO_PRESET=node-server` so the container runs as a normal Node server.
- The app's existing UI, routes, and business logic are otherwise left intact.
- Dynamic child apps run as child processes inside this same container. They
 are not separate Docker containers and cannot control other Docker containers.
