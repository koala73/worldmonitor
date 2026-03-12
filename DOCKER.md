# World Monitor — Docker Self-Hosting Guide

Run World Monitor as a fully self-contained Docker container with a local API backend.

## Architecture

```
┌─── Docker Container ──────────────────────────────┐
│  supervisord                                       │
│    ├── nginx (port 80)                             │
│    │     ├── / → static frontend (Vite build)      │
│    │     └── /api/ → proxy_pass localhost:46123     │
│    └── node local-api-server.mjs (port 46123)      │
│          ├── Loads api/*.js handlers dynamically    │
│          └── Cloud fallback → api.worldmonitor.app  │
└───────────────────────────────────────────────────┘
```

The container uses the same `local-api-server.mjs` sidecar from the Tauri desktop app. It dynamically loads all `api/*.js` serverless handlers and serves them as local HTTP endpoints. Routes that can't be served locally (missing dependencies or data) automatically fall back to `api.worldmonitor.app`.

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor

# 2. Create your environment file
cp .env.docker.example .env.docker
# Edit .env.docker and add your API keys

# 3. Build and run
docker compose up -d

# 4. Open in browser
open http://localhost:8080
```

## Configuration

### Environment Variables

Copy `.env.docker.example` to `.env.docker` and fill in your values. All variables are optional — the app works without any API keys but some panels will show limited data.

See `.env.docker.example` for the full list of supported variables.

### Docker Secrets (Recommended for API Keys)

For production deployments, use Docker secrets instead of environment variables to keep API keys out of process metadata and `docker inspect` output.

**1. Create a secrets directory:**

```bash
mkdir -p secrets
echo "gsk_your_groq_key" > secrets/groq_api_key.txt
echo "your_finnhub_key" > secrets/finnhub_api_key.txt
```

**2. Uncomment the secrets sections in `docker-compose.yml`:**

```yaml
services:
  worldmonitor:
    secrets:
      - GROQ_API_KEY
      - FINNHUB_API_KEY

secrets:
  GROQ_API_KEY:
    file: ./secrets/groq_api_key.txt
  FINNHUB_API_KEY:
    file: ./secrets/finnhub_api_key.txt
```

The entrypoint script automatically reads `/run/secrets/KEYNAME` files and exports them as environment variables. Both methods (env vars and secrets) work simultaneously — secrets take priority.

### Build Arguments

Customize the build with `--build-arg`:

| Argument | Default | Description |
|----------|---------|-------------|
| `VITE_VARIANT` | `full` | Build variant (`full`, `lite`) |
| `VITE_WS_API_URL` | `http://127.0.0.1:46123` | API base URL for the frontend |

```bash
docker compose build --build-arg VITE_VARIANT=lite
```

## Cloud Fallback

By default, `LOCAL_API_CLOUD_FALLBACK=true`. When the local API can't handle a request (e.g., missing npm dependency or data source), it transparently proxies to `api.worldmonitor.app`. Set to `false` for fully air-gapped operation (some panels may show empty data).

## Optional: Local AI with Ollama

Uncomment the `ollama` service in `docker-compose.yml` to run a local Ollama instance. Then set:

```bash
# In .env.docker
OLLAMA_API_URL=http://worldmonitor-ollama:11434
OLLAMA_MODEL=llama3
```

For GPU acceleration (NVIDIA), uncomment the `deploy` section in the compose file.

## Frontend-Only Mode

If you only need the static frontend (proxying API calls to the cloud), use the simpler Dockerfile in `docker/`:

```bash
docker build -f docker/Dockerfile -t worldmonitor-frontend .
docker run -p 8080:80 worldmonitor-frontend
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Container unhealthy | Check `docker logs worldmonitor` for nginx or node errors |
| API returns 502 | Node process may have crashed — check `docker logs worldmonitor` for `[local-api]` errors |
| Panels show empty data | Add API keys via `.env.docker` or Docker secrets |
| Build fails at `npm run build` | Ensure sufficient RAM (2GB+ recommended) |
| Port 8080 in use | Change port mapping in `docker-compose.yml`: `"9090:80"` |
