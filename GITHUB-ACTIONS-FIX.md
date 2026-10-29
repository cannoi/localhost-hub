# GitHub Actions Docker build fix

## Root cause
`vite.config.ts` forced `nitro({ preset: "vercel" })`.
The Vercel preset does **not** write `.output/server/index.mjs`.
The Dockerfile then failed on:
`COPY --from=build /app/.output` → **"/app/.output": not found**

## Fix
1. `vite.config.ts` — `preset: process.env.NITRO_PRESET || "vercel"`
2. `Dockerfile` — sets `NITRO_PRESET=node-server` and `test -f .output/server/index.mjs` after build
3. `DEBIAN_FRONTEND=noninteractive` to quiet debconf noise
4. Removed blocked SoloHost strings (blocked host-daemon phrases)
5. Added EN/VI toggle + `/api/chat` AI helper

## Verify locally
```sh
docker build -t ofie-hub .
docker run --rm -p 8080:8080 ofie-hub
curl -s http://127.0.0.1:8080/health
```
