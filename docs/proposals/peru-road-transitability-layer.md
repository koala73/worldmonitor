# Peru Road Transitability Layer Proposal

## Summary

This document proposes a Peru road transitability layer for World Monitor using official public information from Peru's Ministry of Transport and Communications (MTC), Provias Nacional, concessionaires, and SUTRAN alert sources.

The first implementation step should be endpoint discovery and validation. This proposal is documentation-only and does not introduce scraping, dependencies, or live ingestion.

## Problem Statement

Peru's national road network is frequently affected by heavy rains, landslides, mudslides, accidents, social blockades, maintenance works and infrastructure damage. These events can affect logistics, field operations, emergency response, travel, and business continuity.

A road transitability layer would improve World Monitor's infrastructure and operational-risk coverage for Peru and could become a template for other LATAM countries.

## Candidate Sources

### MTC / Provias Nacional Road Status Viewer

- **Source:** Ministerio de Transportes y Comunicaciones (MTC) / Provias Nacional
- **Public viewer:** https://saecoe.mtc.gob.pe/visor
- **Domain:** national road status / transitability
- **Expected status model:**
  - green: normal transit
  - yellow: restricted transit
  - red: interrupted / blocked transit

### SUTRAN Interactive Alert Map

- **Source:** Superintendencia de Transporte Terrestre de Personas, Carga y Mercancias (SUTRAN)
- **Public viewer:** http://gis.sutran.gob.pe/alerta_sutran/
- **Domain:** road alerts and operational road warnings
- **Potential event classes:**
  - heavy rain
  - landslide
  - mudslide / huaico
  - road accident
  - social blockade
  - infrastructure damage
  - restricted circulation

## Proposed World Monitor Layer

```text
Layer: Peru Road Transitability
Type: transport_infrastructure
Country: PE
Primary source: MTC / Provias Nacional
Secondary source: SUTRAN road alerts
```

## Severity Mapping

| Source status | Suggested World Monitor severity | Suggested meaning |
|---|---|---|
| Normal transit | low | road segment is operational |
| Restricted transit | medium | degraded road availability or partial restriction |
| Interrupted / blocked transit | high | road segment is unavailable or blocked |
| Unknown / unavailable | unknown | source unavailable or status not classified |

## Suggested Data Model

```ts
interface PeruRoadStatusEvent {
  id: string;
  source: 'mtc' | 'sutran';
  country: 'PE';
  region?: string;
  province?: string;
  district?: string;
  roadName?: string;
  routeCode?: string;
  kilometerStart?: number;
  kilometerEnd?: number;
  status: 'normal' | 'restricted' | 'interrupted' | 'unknown';
  severity: 'low' | 'medium' | 'high' | 'unknown';
  cause?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  geometry?: unknown;
  updatedAt?: string;
  sourceUrl: string;
}
```

## User Value

This layer would support:

- logistics disruption monitoring;
- route risk assessment;
- field operations planning;
- emergency response awareness;
- MSP / ISP technician dispatch planning;
- rainy season monitoring;
- regional business continuity analysis;
- infrastructure risk dashboards.

## Implementation Discovery Checklist

Before implementation, inspect the public viewers and identify whether either source exposes:

- JSON API;
- GeoJSON;
- ArcGIS FeatureServer;
- WMS / WFS;
- CSV / XLS download;
- public REST endpoint;
- static dataset;
- official RSS / alert feed.

Avoid brittle HTML scraping unless no other official machine-readable option exists and the project maintainers approve the approach.

## Implementation Approach

### Phase 1 — Source Discovery

1. Inspect browser network calls for the MTC viewer.
2. Inspect browser network calls for the SUTRAN alert map.
3. Identify response format and update cadence.
4. Validate attribution and reuse constraints.
5. Document endpoint stability and sample payloads.

### Phase 2 — Data Adapter Proposal

If a stable endpoint exists:

1. Add a source adapter.
2. Normalize status values.
3. Map road events to World Monitor severity.
4. Add caching policy.
5. Add basic tests for parsing and severity mapping.
6. Document source attribution.

### Phase 3 — Map Layer

1. Add toggleable Peru road layer.
2. Render road disruptions as markers or line segments depending on available geometry.
3. Add popup with status, cause, route and source link.
4. Add filter by severity and region if feasible.

## Risks and Constraints

| Risk | Mitigation |
|---|---|
| No stable public endpoint | Keep as documented proposal until endpoint is confirmed |
| Viewer-only data | Avoid fragile scraping unless approved |
| Incomplete geolocation | Support event markers first, route geometry later |
| Attribution requirements | Display source and link for each event |
| Update frequency unknown | Start with conservative caching |
| Duplicate MTC/SUTRAN reports | Add deduplication by route, location, time and description |

## Proposed PR Scope

```text
docs: propose Peru road transitability layer
```

Documentation-only contribution. No code changes.
