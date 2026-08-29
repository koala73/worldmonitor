# OpenSky Auth Setup

God's Eye View uses explicit auth modes for `/api/opensky`:

- `OPENSKY_AUTH_MODE=oauth` (default, recommended)
- `OPENSKY_AUTH_MODE=auto` (OAuth first, then Basic fallback)
- `OPENSKY_AUTH_MODE=basic`
- `OPENSKY_AUTH_MODE=anon`

Reference: OpenSky REST API docs recommend OAuth2 Client Credentials flow.

## Quick Start (OAuth Client JSON)

Import credentials from JSON (`clientId`/`clientSecret` or `client_id`/`client_secret`) into Keychain:

```bash
./scripts/opensky-import-client.sh /path/to/credentials.json
# or: npm run opensky:import -- /path/to/credentials.json
```

Then launch:

```bash
./scripts/dev-fresh.sh
```

Expected startup lines:

- `OpenSky auth mode: oauth`
- `OpenSky OAuth: configured`

## Optional: Launch With File (No Keychain Import)

```bash
OPENSKY_CREDENTIALS_FILE=/path/to/credentials.json ./scripts/dev-fresh.sh
```

Launchers resolve OAuth creds in this order:

1. `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`
2. `OPENSKY_CREDENTIALS_FILE`
3. Keychain (`opensky-network` / `client_id`, `client_secret`)

## Basic Auth (Legacy)

Basic auth is still supported for now, but OpenSky is moving away from it.

```bash
OPENSKY_AUTH_MODE=basic ./scripts/dev-fresh.sh
```

## Troubleshooting

Inspect proxy headers:

```bash
curl -si http://localhost:4173/api/opensky | grep -iE 'HTTP/|X-OpenSky-Auth'
```

Useful reasons:

- `oauth_invalid_or_missing`: OAuth client not found/usable
- `oauth_invalid_credentials`: OAuth client rejected by OpenSky
- `basic_invalid_credentials`: username/password rejected
- `missing_basic_creds`: basic mode missing user/pass
- `rate_limited`: OpenSky throttling
