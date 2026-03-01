# Transport Domain (Scaffold)

This folder is reserved for civil transport providers.

- Aviation source adapters (for example FR24) should be implemented here.
- Maritime source adapters (for example MarineTraffic) should be implemented here.
- Keep this layer raw/civil. Military classification should stay in `server/worldmonitor/military/v1`.

Implemented provider adapters:

- Aviation ADS-B: FR24, OpenSky, AirLabs, aviationstack, AeroDataBox, FlightAware
- Maritime AIS: MarineTraffic, AISStream, VesselFinder, AISHub

Each provider returns normalized records and can be toggled via environment variables.

Local source config (recommended):

- Keep a private file at `server/worldmonitor/transport/private/transport.local.txt`
- Use keys:
  - `adsb_source` (for example: `"opensky"` or `"opensky,fr24"`)
  - `adsb_apikey` (used for FR24)
  - `adsb_base_url` (FR24 API base URL)
  - `opensky_client_id` (optional OpenSky OAuth client id)
  - `opensky_client_secret` (optional OpenSky OAuth client secret)
  - `ais_source` (for example: `"aisstream"`)
  - `ais_key` (used for AISStream)
  - `relay_url` (optional, defaults to `ws://localhost:3004`)
  - recommended layout: split file into commented sections (`ADS-B`, `OpenSky`, `FR24`, `AIS`)
- Auto-load behavior:
  - `vite` (dev server) reads `transport.local.txt` on startup and maps it into runtime env flags.
  - `scripts/ais-relay.cjs` reads `transport.local.txt` on startup and applies the same mapping.
- Optional manual sync into `.env.local` and transport private env:
  - `npm run transport:sync`
  - sync now validates non-empty config and prints warnings for missing keys by selected source
- Example template:
  - `server/worldmonitor/transport/v1/transport-config.example.txt`
