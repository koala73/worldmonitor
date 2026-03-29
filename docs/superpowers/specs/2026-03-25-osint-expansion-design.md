# OSINT Expansion Design

**Date:** 2026-03-25
**Scope:** Three new panels, eight new sidecar routes, two new map layers, four keychain secrets + one localStorage config field

---

## Overview

Extend World Monitor with ThreatIntelHubPanel, GeoIntelPanel, DarkWebPanel. Single-user desktop app — sidecar is single-tenant.

---

## Relationship to Existing Cyber Services

The existing `CyberThreatPanel` covers ThreatFox/OpenPhish/Spamhaus/CISA KEV (in `src/services/cyber/`). New panels use `src/services/osint/` as a sibling directory. Both panel types coexist under the `intelligence` category.

---

## Components

### 1. ThreatIntelHubPanel

**File:** `src/components/ThreatIntelHubPanel.ts` | **ID:** `threat-intel-hub` | priority 2, `intelligence` category

The panel renders four independent sections. Each keyed section renders `showConfigError()` for that section when its flag is false — the other sections are unaffected. URLscan always renders. A panel with all three keys missing shows three `showConfigError()` sections and one URLscan results section. There is no panel-level empty state or combined error message.

Guard: `isFeatureAvailable('<flag>')` in service function (returns `[]`) AND in panel per-section (to branch `showConfigError()` vs data render).

- **GreyNoise** (`/api/greynoise-scanners`): hardcoded seed list ~50 scanner IPs; sidecar calls `https://api.greynoise.io/v3/community/{ip}` per IP, serial batches of 10 with 200ms inter-batch delay. Auth: `key: <GREYNOISE_API_KEY>` request header (GreyNoise Community API requires a free key for this endpoint). Fields returned: `ip` (string), `noise` (bool), `riot` (bool), `classification` (`"malicious"|"benign"|"unknown"`), `name` (string), `link` (string). Missing key → `{ error: 'GREYNOISE_API_KEY not configured' }`. Env: `GREYNOISE_API_KEY`. Flag: `greynoiseIntel`.
- **OTX** (`/api/otx-pulses`): `https://otx.alienvault.com/api/v1/pulses/subscribed?limit=20`, header `X-OTX-API-KEY`. Missing key → `{ error: 'OTX_API_KEY not configured' }`. Env: `OTX_API_KEY`. Flag: `otxPulses`.
- **AbuseIPDB** (`/api/abuseipdb-reports`): `https://api.abuseipdb.com/api/v2/blacklist?limit=50`, header `Key`. Missing key → `{ error: 'ABUSEIPDB_API_KEY not configured' }`. Env: `ABUSEIPDB_API_KEY`. Flag: `abuseIpDb`.
- **URLscan** (`/api/urlscan-feed`): `https://urlscan.io/api/v1/search/?q=task.tags:malicious&size=20`. No key, no flag — always fetches and renders.

### 2. GeoIntelPanel

**File:** `src/components/GeoIntelPanel.ts` | **ID:** `geo-intel` | priority 2, `intelligence` category

The panel has two independent sections. When `acledEvents` flag is false, the ACLED section shows `showConfigError()` and the OpenSky section renders normally — the panel remains visible showing ADSB flight data. The panel is never fully hidden due to missing keys.

**ACLED** (`/api/acled-events`): `https://api.acleddata.com/acled/read?key=<key>&email=<email>&limit=500&fields=event_type,actor1,fatalities,event_date,latitude,longitude,country,source,notes`. Sidecar reads `ACLED_API_KEY` from env, email from `?email=` param. Missing key → `{ error: 'ACLED_API_KEY not configured' }`. Missing email → `{ error: 'email required' }`. Frontend `fetchAcledEvents()` reads `localStorage.getItem('worldmonitor-acled-email')`; returns `[]` without sidecar call if absent. Env: `ACLED_API_KEY`. Flag: `acledEvents` — controls both the ACLED panel section and the `acledEvents` map layer.

**OpenSky** (`/api/adsb-military`): `https://opensky-network.org/api/states/all`. Sidecar filters to military squawk codes and known military ICAO hex prefixes. No key, no feature flag. Fetches whenever the `geo-intel` data task runs.

**Data task:** one `geo-intel` refresh task in `data-loader.ts` calls `fetchAcledEvents()` and `fetchAdsbMilitary()`. Results stored in `ctx.acledEvents: AcledEvent[]` and `ctx.adsbMilitary: AdsbFlight[]`. Panel and map layers read from `ctx` — no duplicate sidecar calls. This task runs only when GeoIntelPanel is enabled; if the panel is disabled by the user, `ctx.acledEvents` and `ctx.adsbMilitary` remain empty and both map layers show no dots — no separate independent task needed.

**Type shapes** (defined in `src/types/index.ts` or a new `src/types/osint.ts`):

```ts
interface AcledEvent {
  event_type: string;       // e.g. "Battles", "Explosions/Remote violence"
  actor1: string;
  fatalities: number;
  event_date: string;       // "YYYY-MM-DD"
  latitude: number;
  longitude: number;
  country: string;
  source: string;
  notes: string;
}

interface AdsbFlight {
  icao24: string;
  callsign: string;
  longitude: number;
  latitude: number;
  baro_altitude: number;    // meters
  velocity: number;         // m/s
  squawk: string;           // e.g. "7700"
}
```

### 3. DarkWebPanel

**File:** `src/components/DarkWebPanel.ts` | **ID:** `dark-web` | priority 2, `intelligence` category

No feature flags. No keys. Unconditionally enabled in `FULL_PANELS` (`enabled: true`). Unconditionally wired in `data-loader.ts`. No `isFeatureAvailable()` calls.

- **HIBP** (`/api/hibp-breaches`): `https://haveibeenpwned.com/api/v3/breaches`. Fields: `Name`, `BreachDate`, `PwnCount`, `DataClasses`. Display: breach timeline (most recent first), aggregate records exposed in last 30 days.
- **Tor Metrics** (`/api/tor-metrics`): `https://metrics.torproject.org/relaylist.json`. Fields: per-relay `flags`, `country`. Display: exit node count by country, total relay count.

---

## Sidecar Routes

All eight added to `src-tauri/sidecar/local-api-server.mjs`. All use `ttlCache()`. All behind `LOCAL_API_TOKEN` gate. External calls use `fetchWithTimeout()` + `CHROME_UA`.

| Route | Env Keys | Query Params | TTL |
|---|---|---|---|
| `/api/greynoise-scanners` | `GREYNOISE_API_KEY` | none | 15 min |
| `/api/otx-pulses` | `OTX_API_KEY` | none | 30 min |
| `/api/abuseipdb-reports` | `ABUSEIPDB_API_KEY` | none | 30 min |
| `/api/urlscan-feed` | none | none | 15 min |
| `/api/acled-events` | `ACLED_API_KEY` | `?email=` required | 15 min |
| `/api/adsb-military` | none | none | 3 min |
| `/api/hibp-breaches` | none | none | 60 min |
| `/api/tor-metrics` | none | none | 60 min |

**ACLED TTL cache:** single-entry cache keyed by `'acled-events:' + email`. Single-user app — in practice only one email value exists. If email changes, the old cache entry is never evicted by the new request (different cache key) but will naturally expire at TTL. No maximum-entries limit needed.

Missing key/param → `{ error: string }` response (HTTP 200 with error field — consistent with all other sidecar error responses).

---

## Map Layers

Both added to `FULL_MAP_LAYERS` in `src/config/panels.ts`.

**`acledEvents`** — gated by `acledEvents` feature flag. Reads from `ctx.acledEvents`. If GeoIntelPanel is disabled (task doesn't run), `ctx.acledEvents` is empty and layer renders no dots. Colors: battles `#ef4444`, explosions `#f97316`, violence against civilians `#991b1b`, protests `#eab308`, riots `#d97706`. Popup: actor names, fatalities, date, source URL.

**`militaryFlights`** — no feature flag; unconditionally in `FULL_MAP_LAYERS`. Reads from `ctx.adsbMilitary`. If GeoIntelPanel is disabled, `ctx.adsbMilitary` is empty and layer renders no dots — no separate wiring needed. Colors: 7700 `#dc2626`, 7600 `#ea580c`, 7500 `#9f1239`, standard military `#3b82f6`. Popup: callsign, altitude, speed, squawk. Poll: 2 min (GeoIntelPanel ADSB task cadence); sidecar TTL: 3 min.

---

## Frontend Services

New sibling directory to `src/services/cyber/`:

```
src/services/osint/
  index.ts          # re-exports
  threat-intel.ts   # fetchGreyNoise, fetchOtxPulses, fetchAbuseIpDb, fetchUrlscanFeed
  geo-intel.ts      # fetchAcledEvents, fetchAdsbMilitary
  dark-web.ts       # fetchHibpBreaches, fetchTorMetrics
```

Guard: `isFeatureAvailable()` in service (execution) + in panel per-section (UI branch). DarkWebPanel services: no guard.

`fetchAcledEvents()` reads `localStorage.getItem('worldmonitor-acled-email')`, passes as `?email=`. Returns `[]` without sidecar call if absent.

**Cadences:**

| Task | Poll | TTL |
|---|---|---|
| adsb-military | 2 min | 3 min |
| acled-events | 10 min | 15 min |
| greynoise-scanners, urlscan-feed | 15 min | 15 min |
| otx-pulses, abuseipdb-reports | 30 min | 30 min |
| hibp-breaches, tor-metrics | 60 min | 60 min |

---

## Settings & API Keys

4 new entries in `SUPPORTED_SECRET_KEYS` in `main.rs` (25 → 29): `GREYNOISE_API_KEY`, `OTX_API_KEY`, `ABUSEIPDB_API_KEY`, `ACLED_API_KEY`.

**`ACLED_EMAIL`** is stored in `localStorage` as `worldmonitor-acled-email`. It is not in the keychain. In the Settings → API Keys tab it is rendered as a plain `<input type="text">` in its own row immediately below the `ACLED_API_KEY` row, using the same visual row styling as the secret key inputs but with `type="text"` (value visible) and saved to `localStorage` directly on change (no keychain IPC call). The implementing developer adds a custom render path for this field in the API Keys tab, separate from the standard keychain key render loop.

Changes required:

- `src-tauri/src/main.rs` — 4 new entries in `SUPPORTED_SECRET_KEYS`
- `src/services/runtime-config.ts` — 4 keychain key defs (`isDesktopOnly: true`); `ACLED_EMAIL` localStorage-backed field; feature flags `greynoiseIntel`, `otxPulses`, `abuseIpDb`, `acledEvents`
- `src/services/settings-constants.ts` — `HUMAN_LABELS` + `SIGNUP_URLS` for all five

---

## Files to Create

| File | Purpose |
|---|---|
| `src/components/ThreatIntelHubPanel.ts` | Panel component |
| `src/components/GeoIntelPanel.ts` | Panel component |
| `src/components/DarkWebPanel.ts` | Panel component |
| `src/services/osint/index.ts` | Re-exports |
| `src/services/osint/threat-intel.ts` | fetchGreyNoise, fetchOtxPulses, fetchAbuseIpDb, fetchUrlscanFeed |
| `src/services/osint/geo-intel.ts` | fetchAcledEvents, fetchAdsbMilitary |
| `src/services/osint/dark-web.ts` | fetchHibpBreaches, fetchTorMetrics |

## Files to Modify

| File | Change |
|---|---|
| `src-tauri/sidecar/local-api-server.mjs` | 8 new route handlers |
| `src-tauri/src/main.rs` | 4 new entries in `SUPPORTED_SECRET_KEYS` |
| `src/config/panels.ts` | `FULL_PANELS`: 3 new entries; `PANEL_CATEGORY_MAP` `intelligence` array: add `threat-intel-hub`, `geo-intel`, `dark-web`; `FULL_MAP_LAYERS`: add `acledEvents`, `militaryFlights` |
| `src/services/runtime-config.ts` | 4 key defs + localStorage field + 4 feature flags |
| `src/services/settings-constants.ts` | Labels + signup URLs |
| `src/components/index.ts` | Export 3 new panel classes |
| `src/app/panel-layout.ts` | Instantiate 3 panels; register in panel map |
| `src/app/data-loader.ts` | Wire refresh tasks; store ACLED + ADSB results in `ctx.acledEvents` and `ctx.adsbMilitary` |
| `src/app/app-context.ts` | Add `panels.threatIntelHub: ThreatIntelHubPanel \| undefined`, `panels.geoIntel: GeoIntelPanel \| undefined`, `panels.darkWeb: DarkWebPanel \| undefined`; add `ctx.acledEvents: AcledEvent[]`, `ctx.adsbMilitary: AdsbFlight[]` |

---

## Error Handling

- Sidecar → `{ error: string }` on missing key/param or external failure — services return `[]`
- Per-section guard: `isFeatureAvailable()` in service (execution) + panel (UI branch per section)
- DarkWebPanel: no guard — always fetches
- `fetchAcledEvents()` → `[]` without sidecar call if `worldmonitor-acled-email` absent
- No circuit breakers — `fetchWithTimeout()` sufficient

---

## Out of Scope

- IntelX (paid API)
- Personal breach checking
- ADSB-Exchange commercial API
- Dark web forum scraping
- Merging new feeds into existing `CyberThreatPanel`
