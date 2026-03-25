# Desktop Runtime Configuration

World Monitor desktop uses a runtime configuration schema with per-feature toggles and secret-backed credentials.

## Supported Secret Keys

The desktop vault schema is defined by Rust `SUPPORTED_SECRET_KEYS` in `src-tauri/src/main.rs`. It currently supports these 25 keys:

- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `FRED_API_KEY`
- `EIA_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `ACLED_ACCESS_TOKEN`
- `ACLED_EMAIL`
- `URLHAUS_AUTH_KEY`
- `OTX_API_KEY`
- `ABUSEIPDB_API_KEY`
- `WINGBITS_API_KEY`
- `WS_RELAY_URL`
- `VITE_OPENSKY_RELAY_URL`
- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`
- `AISSTREAM_API_KEY`
- `VITE_WS_RELAY_URL`
- `FINNHUB_API_KEY`
- `NASA_FIRMS_API_KEY`
- `OLLAMA_API_URL`
- `OLLAMA_MODEL`
- `WTO_API_KEY`
- `AVIATIONSTACK_API`
- `ICAO_API_KEY`
- `THREATFOX_API_KEY`

Note: `UC_DP_KEY` still exists in the TypeScript `RuntimeSecretKey` union, but it is not part of the desktop Rust keychain or sidecar allowlist.

## Feature Availability Model

Each runtime feature exposes:

- `id`: stable feature identifier
- `requiredSecrets`: keys that must be present and valid
- `enabled`: user toggle state from the runtime settings UI
- `available`: computed availability after validation
- `fallback`: user-facing degraded behavior description

## Secret Storage

Desktop builds persist secrets through Tauri command bindings backed by OS credential storage.

- Service namespace: `world-monitor`
- Storage backend: consolidated `secrets-vault` entry in the OS keychain
- Frontend behavior: secrets are not written to plaintext config files

## Expected Degradation

When secrets are missing or disabled, the desktop app degrades feature-by-feature instead of failing globally:

- AI summarization: cloud providers narrow to whatever is configured and validated; local Ollama and browser fallback can still be used when available.
- Economic and market enrichment: `FRED_API_KEY`, `EIA_API_KEY`, and `FINNHUB_API_KEY` gate economic charts, oil analytics, and some market panels.
- Conflict and outage feeds: `ACLED_ACCESS_TOKEN`, `ACLED_EMAIL`, and `CLOUDFLARE_API_TOKEN` gate conflict and outage-backed panels.
- Cyber threat feeds: `URLHAUS_AUTH_KEY`, `OTX_API_KEY`, `ABUSEIPDB_API_KEY`, and `THREATFOX_API_KEY` gate parts of the cyber layer.
- Fire and climate overlays: `NASA_FIRMS_API_KEY` gates FIRMS-backed fire detection.
- Aviation and live tracking: `WINGBITS_API_KEY`, `AVIATIONSTACK_API`, `ICAO_API_KEY`, `AISSTREAM_API_KEY`, `WS_RELAY_URL`, `VITE_WS_RELAY_URL`, `VITE_OPENSKY_RELAY_URL`, `OPENSKY_CLIENT_ID`, and `OPENSKY_CLIENT_SECRET` gate enrichment and relay-backed transport features.
- Trade and institutional data: `WTO_API_KEY` gates WTO-backed trade policy enrichment.

## Related Docs

- [API_KEY_DEPLOYMENT.md](API_KEY_DEPLOYMENT.md)
- [RELAY_PARAMETERS.md](RELAY_PARAMETERS.md)
- [RELEASE_PACKAGING.md](RELEASE_PACKAGING.md)
