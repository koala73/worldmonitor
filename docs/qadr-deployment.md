# QADR deployment

This fork is deployed on QADR behind the existing `fgpt_ingress` Caddy stack and exposed at `https://monitor.gantor.ir/`.

## What is customized

- Persian locale added as a first-class language.
- RTL support extended to Persian.
- Branding and metadata updated for `monitor.gantor.ir`.
- Runtime API fallback prefers the current web origin instead of upstream `worldmonitor.app`.
- QADR-specific compose stack added in `compose.qadr.yaml`.
- Optional seeder loop runs on QADR to keep Redis-backed datasets fresh.

## Required QADR files

- repo checkout: `/home/saman/workspaces/worldmonitor`
- env file: `/home/saman/workspaces/worldmonitor/.env`
- compose file: `/home/saman/workspaces/worldmonitor/compose.qadr.yaml`

## Required ingress

In the FreeGPT ingress source of truth:

- `monitor.gantor.ir` reverse proxies to `qadr-worldmonitor:8080`

Because QADR mounts the workspace `Caddyfile` directly, recreate the Caddy container after pulling ingress changes:

```bash
docker compose -f /home/saman/workspaces/freegpt/stacks/ingress-core/compose.yaml up -d --force-recreate caddy
```

## Required DNS

Add to the live `gantor.ir` zone on QADR:

```dns
monitor    IN A   5.235.208.128
```

## Compose notes

- `worldmonitor` joins `fgpt_ingress` so Caddy can reach it.
- `worldmonitor` joins `fgpt_ai` so it can use the internal LiteLLM gateway.
- `worldmonitor` uses `Dockerfile.qadr-prebuilt` on QADR, not the full build-stage `Dockerfile`.
- Build the frontend and compiled handler bundle on a stable workstation first:

```bash
npm ci --ignore-scripts
node docker/build-handlers.mjs
npx tsc
npx vite build
```

- Then sync the repo contents, including `dist/` and generated `api/**/*.js`, to `/home/saman/workspaces/worldmonitor` before running `docker compose` on QADR.
- `seeders` uses `node:22-alpine` and runs `./scripts/run-seeders.sh` every 30 minutes by default.
- Redis state stays local to this stack through the `redis-data` volume.
