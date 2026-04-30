# Peru National Data Sources Proposal

## Summary

This document proposes a set of Peru-focused national data sources that could expand World Monitor's regional situational awareness coverage for infrastructure, transport, emergency management, hydrometeorology, seismic activity, energy, macroeconomics, and environmental monitoring.

The goal is to identify official or high-value public sources before implementing any new data layer. This proposal is documentation-only and does not introduce code changes, dependencies, or live data ingestion.

## Rationale

Peru is highly exposed to transport disruptions, heavy rains, landslides, floods, earthquakes, energy demand shifts, and regional emergency events. Adding Peru-focused official sources would improve World Monitor's usefulness for:

- LATAM situational awareness.
- Critical infrastructure monitoring.
- Business continuity planning.
- Logistics and transport risk analysis.
- MSP / ISP field operations planning.
- Emergency and disaster monitoring.
- Energy and macroeconomic context.

## Candidate Sources

| Priority | Source | Domain | Potential World Monitor Use |
|---:|---|---|---|
| 1 | MTC / Provias Nacional road status viewer | Transport infrastructure | Road transitability layer |
| 2 | SUTRAN interactive alert map | Road alerts / transport risk | Road disruption and warning layer |
| 3 | INDECI / COEN | Emergency management | Emergency reports and disaster awareness feed |
| 4 | SENAMHI | Weather and hydrometeorology | Rainfall, river, climate and hydrological alert layer |
| 5 | IGP / CENSIS | Seismic monitoring | Peru earthquake layer |
| 6 | COES | Energy grid / electricity | Demand, generation and frequency indicators |
| 7 | BCRPData | Macroeconomics | Peru macro indicators for the finance variant |
| 8 | OEFA / MINAM / SINIA | Environmental monitoring | Water, air, protected areas and environmental risk layers |
| 9 | Peru National Open Data Platform | Public datasets catalog | Source discovery and dataset registry |

## 1. Transport Infrastructure

### 1.1 MTC Road Status Viewer

- **Source:** Ministerio de Transportes y Comunicaciones (MTC)
- **Public viewer:** https://saecoe.mtc.gob.pe/visor
- **Domain:** National road transitability
- **Coverage:** Peru national road network
- **Reported status model:**
  - Green: normal transit
  - Yellow: restricted transit
  - Red: interrupted / blocked transit

### Potential Layer

```text
Layer: Peru Road Transitability
Type: transport_infrastructure
Country: PE
Severity mapping:
  normal -> low
  restricted -> medium
  interrupted -> high
```

### Use Cases

- Route risk monitoring.
- Logistics disruption analysis.
- Road closure awareness.
- Emergency planning during rainy season.
- MSP / ISP field operations planning.

## 2. SUTRAN Road Alerts

- **Source:** Superintendencia de Transporte Terrestre de Personas, Carga y Mercancias (SUTRAN)
- **Public viewer:** http://gis.sutran.gob.pe/alerta_sutran/
- **Domain:** Road disruption alerts
- **Potential events:**
  - Heavy rain
  - Landslides
  - Mudslides / huaicos
  - Road accidents
  - Social blockades
  - Infrastructure damage
  - Snow / weather-related disruptions

### Potential Layer

```text
Layer: Peru SUTRAN Road Alerts
Type: road_alerts
Country: PE
```

## 3. Emergency Management

### INDECI / COEN

- **Source:** Instituto Nacional de Defensa Civil (INDECI) / Centro de Operaciones de Emergencia Nacional (COEN)
- **Website:** https://coen.indeci.gob.pe/
- **Domain:** Emergency and disaster monitoring

### Potential Feed

```text
Feed: Peru Emergency Reports
Type: emergency_management
Country: PE
```

### Candidate Event Types

- Floods
- Landslides
- Heavy rains
- Earthquakes
- Fires
- Infrastructure damage
- Humanitarian response
- Regional emergency coordination

## 4. Hydrometeorology

### SENAMHI

- **Source:** Servicio Nacional de Meteorologia e Hidrologia del Peru (SENAMHI)
- **Domain:** Weather, climate and hydrological monitoring

### Potential Layer

```text
Layer: Peru Hydro-Meteorological Alerts
Type: hydromet_alerts
Country: PE
```

### Candidate Signals

- Rainfall alerts
- River levels
- Hydrological warnings
- Frost / cold events
- Heat waves
- Wind alerts
- Flood risk conditions

## 5. Seismic Activity

### IGP / CENSIS

- **Source:** Instituto Geofisico del Peru (IGP) / Centro Sismologico Nacional
- **Domain:** Seismic monitoring

### Potential Layer

```text
Layer: Peru Earthquakes
Type: seismic_activity
Country: PE
```

### Candidate Fields

- Magnitude
- Depth
- Epicenter
- Region
- Event time
- Coordinates
- Perceived / non-perceived classification, if available

## 6. Energy Infrastructure

### COES

- **Source:** Comite de Operacion Economica del Sistema Interconectado Nacional (COES)
- **API documentation:** https://appserver.coes.org.pe/waMediciones/Help
- **Domain:** Electricity demand, generation and system frequency

### Potential Panel

```text
Panel: Peru Power Grid Indicators
Variant: finance / infrastructure
Country: PE
```

### Candidate Metrics

- Demand
- Generation
- Area-level demand
- Daily forecast
- Frequency
- Maximum demand ranking

## 7. Macroeconomic Indicators

### BCRPData

- **Source:** Banco Central de Reserva del Peru (BCRP)
- **API documentation:** https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api
- **Domain:** Economic and financial indicators

### Potential Panel

```text
Panel: Peru Macro Indicators
Variant: finance
Country: PE
```

### Candidate Metrics

- Exchange rate
- Inflation
- Reference interest rate
- International reserves
- Monetary indicators
- Commodity-linked indicators

## 8. Environmental Monitoring

### OEFA / MINAM / SINIA

- **Source examples:** OEFA, MINAM, SINIA
- **Domain:** Environmental supervision and open environmental data

### Potential Layer

```text
Layer: Peru Environmental Monitoring
Type: environmental_risk
Country: PE
```

### Candidate Datasets

- Water quality
- Air quality
- Protected areas
- Environmental supervision points
- Deforestation
- Solid waste
- Glaciers and hydrological indicators

## Implementation Notes

Before implementation, each source should be reviewed for:

1. Machine-readable access method: API, RSS, GeoJSON, ArcGIS FeatureServer, WMS/WFS, CSV, JSON or DKAN datastore.
2. License and attribution requirements.
3. Update frequency.
4. Stability of endpoint.
5. Field-level data quality.
6. Geographic coordinates or geocoding feasibility.
7. Whether the data can be safely cached.
8. Whether the source is official, journalistic, civic or third-party.

## Suggested Next Steps

1. Validate MTC and SUTRAN map network calls to identify whether they expose a stable public endpoint.
2. Validate INDECI / COEN feeds or report endpoints.
3. Validate SENAMHI alert and hydrological data access.
4. Validate IGP seismic dataset endpoint.
5. Add a separate RSS candidate document for Peru news sources.
6. Start with a documentation-only PR before introducing live data ingestion.

## Proposed PR Scope

```text
docs: add Peru national data sources proposal
```

Documentation-only contribution. No code changes.