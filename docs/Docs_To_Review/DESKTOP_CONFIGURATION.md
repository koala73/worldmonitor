# Desktop Runtime Configuration Schema

World Monitor desktop now uses a runtime configuration schema with per-feature toggles and secret-backed credentials.

## Secret keys

The desktop vault schema supports the following 17 keys used by services and relays:

- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `FRED_API_KEY`
- `EIA_API_KEY`
- `FINNHUB_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `ACLED_ACCESS_TOKEN`
- `URLHAUS_AUTH_KEY`
- `OTX_API_KEY`
- `ABUSEIPDB_API_KEY`
- `NASA_FIRMS_API_KEY`
- `WINGBITS_API_KEY`
- `VITE_OPENSKY_RELAY_URL`
- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`
- `AISSTREAM_API_KEY`
- `VITE_WS_RELAY_URL`

## Feature schema

Each feature includes:

- `id`: stable feature identifier.
- `requiredSecrets`: list of keys that must be present and valid.
- `enabled`: user-toggle state from runtime settings panel.
- `available`: computed (`enabled && requiredSecrets valid`).
- `fallback`: user-facing degraded behavior description.

## Desktop secret storage

Desktop builds persist secrets in OS credential storage through Tauri command bindings backed by Rust `keyring` entries (`world-monitor` service namespace).

Secrets are **not stored in plaintext files** by the frontend.

## Degradation behavior

If required secrets are missing/disabled:

- Summarization: Groq/OpenRouter disabled, browser model fallback.
- FRED / EIA / Finnhub: economic, oil analytics, and stock data return empty state.
- Cloudflare / ACLED: outages/conflicts return empty state.
- Cyber threat feeds (URLhaus, OTX, AbuseIPDB): cyber threat layer returns empty state.
- NASA FIRMS: satellite fire detection returns empty state.
- Wingbits: flight enrichment disabled, heuristic-only flight classification remains.
- AIS / OpenSky relay: live tracking features are disabled cleanly.
