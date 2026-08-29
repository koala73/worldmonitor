/**
 * How each World Monitor tracker looks on the God's Eye View globe.
 *
 * Ported from GlobeMap's `buildMarkerElement` and its `setX()` normalizers,
 * which together were ~700 lines of interleaved DOM-building and field
 * plucking. Splitting them apart — accessors here, drawing in
 * bridgeSource.ts — is what lets one renderer serve every tracker.
 *
 * The colours, glyphs and size curves are deliberately the ORIGINALS. Users
 * read this map by colour ("orange dot = major outage"), and a renderer swap
 * is not a licence to relearn it. Where GlobeMap animated a CSS pulse, the
 * equivalent here is a static translucent ring: a per-frame animator on a
 * Cesium entity re-tessellates its primitive every frame, which is the exact
 * cost the vendored earthquakes layer documents having removed.
 *
 * Gating mirrors GlobeMap's `flushMarkersImmediate` exactly — including the
 * several payloads that share one toggle (outages + traffic anomalies + DDoS
 * all ride the `outages` layer) and the one payload that ignores the tray
 * entirely (`newsLocations`).
 */

import type { BridgeSpec, MarkerStyle } from './types';

/* ── Palettes, verbatim from GlobeMap ──────────────────────────────────── */

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  fighter: '#ff4444', bomber: '#ff8800', recon: '#44aaff',
  tanker: '#88ff44', transport: '#aaaaff', helicopter: '#ffff44',
  drone: '#ff44ff', maritime: '#44ffff',
};

const VESSEL_TYPE_COLORS: Record<string, string> = {
  carrier: '#ff4444', destroyer: '#ff8800', frigate: '#ffcc00',
  submarine: '#8844ff', amphibious: '#44cc88', patrol: '#44aaff',
  auxiliary: '#aaaaaa', research: '#44ffff', icebreaker: '#88ccff',
  special: '#ff44ff',
};

const VESSEL_TYPE_ICONS: Record<string, string> = {
  carrier: '⛴', destroyer: '▲', frigate: '▲',
  submarine: '◆', amphibious: '⬡', patrol: '▶',
  auxiliary: '●', research: '◎', icebreaker: '❅',
  special: '★',
};

const VESSEL_TYPE_LABELS: Record<string, string> = {
  carrier: 'Aircraft Carrier', destroyer: 'Destroyer', frigate: 'Frigate',
  submarine: 'Submarine', amphibious: 'Amphibious', patrol: 'Patrol',
  auxiliary: 'Auxiliary', research: 'Research', icebreaker: 'Icebreaker',
  special: 'Special Mission', unknown: 'Unknown',
};

const CLUSTER_ACTIVITY_COLORS: Record<string, string> = {
  deployment: '#ff4444', exercise: '#ff8800', transit: '#ffcc00', unknown: '#6688aa',
};

const HOTSPOT_ESCALATION_COLORS: Record<number, string> = {
  5: '#ff2020', 4: '#ff6600', 3: '#ffaa00', 2: '#ffdd00', 1: '#88ff44',
};

const WEATHER_SEVERITY_COLORS: Record<string, string> = {
  Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff',
};

const NATURAL_CATEGORY_ICONS: Record<string, string> = {
  earthquakes: '〽', volcanoes: '\u{1F30B}', severeStorms: '\u{1F300}',
  floods: '\u{1F4A7}', wildfires: '\u{1F525}', drought: '☀',
};

const PROTEST_TYPE_COLORS: Record<string, string> = {
  riot: '#ff3030', protest: '#ffaa00', strike: '#44aaff',
  demonstration: '#88ff44', civil_unrest: '#ff6600',
};

const CLIMATE_TYPE_COLORS: Record<string, string> = {
  warm: '#ff4400', cold: '#44aaff', wet: '#00ccff', dry: '#ff8800', mixed: '#88ff88',
};

/**
 * Satellite dot colours by operator country. GlobeMap read these from a
 * module-level table it defined itself; it moved here with the markers.
 */
const SAT_COUNTRY_COLORS: Record<string, string> = {
  US: '#4488ff', CN: '#ff2020', RU: '#ff8800', EU: '#44cc44',
  JP: '#ff88cc', IN: '#ffaa44', UK: '#88ccff',
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A glyph marker: emoji or symbol, tinted and glowing. */
const glyph = (g: string, color: string, size = 11, ring = false): MarkerStyle =>
  ({ glyph: g, color, size, ...(ring && { ring }) });

/** A plain filled dot — GlobeMap drew these as CSS circles. */
const dot = (color: string, size: number, ring = false): MarkerStyle =>
  ({ color, size, ...(ring && { ring }) });

/* ── The table ─────────────────────────────────────────────────────────── */

/**
 * Payload key (the string `CesiumGlobeMap.push()` uses) → what to draw.
 *
 * A payload absent from this table is recorded but not drawn, which is the
 * same answer GlobeMap gave: `setPositiveEvents`, `setKindnessData`,
 * `setHappinessScores`, `setSpeciesRecoveryZones`, `setRenewableInstallations`
 * and `setCableHealth` were all empty bodies there. They are country-level
 * choropleths and flow arcs with no marker form; drawing them needs polygon
 * and arc support, not another entry here.
 */
export const BRIDGE_SPECS: Record<string, BridgeSpec> = {
  hotspots: {
    layer: 'hotspots',
    parts: [{
      kind: 'hotspot',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `hotspot-${i}`),
      title: (r) => String(r.name ?? 'Hotspot'),
      // Diamond on the old globe; a dot is the closest Cesium primitive and
      // the escalation colour is what actually carried the meaning.
      style: (r) => dot(HOTSPOT_ESCALATION_COLORS[Number(r.escalationScore ?? 1)] ?? '#ffaa00', 10, true),
    }],
  },

  earthquakes: {
    // GlobeMap filed earthquakes under the Natural Events toggle rather than
    // giving them one of their own; the tray has no earthquakes row.
    layer: 'natural',
    parts: [{
      kind: 'earthquake',
      rows: (p) => p ?? [],
      skip: (r) => !r?.location,
      lat: (r) => num(r.location?.latitude), lon: (r) => num(r.location?.longitude),
      id: (r, i) => String(r.id ?? `quake-${i}`),
      title: (r) => `M${Number(r.magnitude ?? 0).toFixed(1)} — ${r.place ?? ''}`,
      style: (r) => {
        const m = Number(r.magnitude ?? 0);
        const color = m >= 6 ? '#ff2020' : m >= 4 ? '#ff8800' : '#ffcc00';
        return dot(color, Math.max(8, Math.min(18, Math.round(m * 2.5))));
      },
    }],
  },

  naturalEvents: {
    layer: 'natural',
    parts: [{
      kind: 'natural',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `natural-${i}`),
      title: (r) => String(r.title ?? ''),
      style: (r) => glyph(NATURAL_CATEGORY_ICONS[String(r.category ?? '')] ?? '⚠', '#ffcc66'),
    }],
  },

  weatherAlerts: {
    layer: 'weather',
    parts: [{
      kind: 'weather',
      rows: (p) => p ?? [],
      skip: (r) => !Array.isArray(r?.centroid),
      // NWS centroids are [lon, lat] — the one payload in World Monitor that
      // is GeoJSON-ordered. Getting this backwards puts every US alert in
      // the Indian Ocean, which is how GlobeMap's comment came to exist.
      lat: (r) => num(r.centroid?.[1]), lon: (r) => num(r.centroid?.[0]),
      id: (r, i) => String(r.id ?? `weather-${i}`),
      title: (r) => String(r.headline ?? r.event ?? ''),
      style: (r) => glyph('⚡', WEATHER_SEVERITY_COLORS[String(r.severity ?? 'Minor')] ?? '#88aaff', 9),
    }],
  },

  radiation: {
    layer: 'radiationWatch',
    parts: [{
      kind: 'radiation',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `rad-${i}`),
      title: (r) => `${r.location ?? ''} · ${r.severity ?? ''} · ${r.confidence ?? ''}`,
      style: (r) => glyph('☢', r.severity === 'spike' ? '#ff3030' : '#ffaa00', 11, r.severity === 'spike'),
    }],
  },

  outages: {
    layer: 'outages',
    parts: [{
      kind: 'outage',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `outage-${i}`),
      title: (r) => `${r.country ?? ''}: ${r.title ?? ''}`,
      style: (r) => glyph('\u{1F4E1}',
        r.severity === 'total' ? '#ff2020' : r.severity === 'major' ? '#ff8800' : '#ffcc00', 12),
    }],
  },

  trafficAnomalies: {
    // Shares the Internet Disruptions toggle with outages and DDoS.
    layer: 'outages',
    parts: [{
      kind: 'trafficAnomaly',
      rows: (p) => p ?? [],
      skip: (r) => Number(r.latitude ?? 0) === 0 && Number(r.longitude ?? 0) === 0,
      lat: (r) => num(r.latitude), lon: (r) => num(r.longitude),
      id: (r, i) => String(r.uuid || `ta-${r.locationCode ?? i}-${r.startDate ?? ''}`),
      title: (r) => `${r.type || 'Traffic Anomaly'}: ${r.locationName ?? ''}`,
      style: () => glyph('⚡', '#ffa000', 10),
    }],
  },

  ddosLocations: {
    layer: 'outages',
    parts: [{
      kind: 'ddosHit',
      rows: (p) => p ?? [],
      skip: (r) => Number(r.latitude ?? 0) === 0 && Number(r.longitude ?? 0) === 0,
      lat: (r) => num(r.latitude), lon: (r) => num(r.longitude),
      id: (r, i) => `ddos-${r.countryCode ?? i}`,
      title: (r) => `DDoS: ${r.countryName ?? ''} (${Number(r.percentage ?? 0).toFixed(1)}%)`,
      style: () => glyph('⚔', '#b400ff', 10),
    }],
  },

  cyberThreats: {
    layer: 'cyberThreats',
    parts: [{
      kind: 'cyber',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `cyber-${i}`),
      title: (r) => `${r.type ?? 'malware_host'}: ${r.indicator ?? ''}`,
      style: (r) => glyph('\u{1F6E1}',
        r.severity === 'critical' ? '#ff0044' : r.severity === 'high' ? '#ff4400'
          : r.severity === 'medium' ? '#ffaa00' : '#44aaff', 10),
    }],
  },

  fires: {
    layer: 'fires',
    parts: [{
      kind: 'fire',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `${r.lat},${r.lon}-${i}`),
      title: (r) => `Fire — ${r.region ?? ''}`,
      style: (r) => {
        const b = Number(r.brightness ?? 330);
        return glyph('\u{1F525}', b > 400 ? '#ff2020' : b > 330 ? '#ff6600' : '#ffaa00', 10);
      },
    }],
  },

  protests: {
    layer: 'protests',
    parts: [{
      kind: 'protest',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `protest-${i}`),
      title: (r) => String(r.title ?? ''),
      style: (r) => glyph('\u{1F4E2}', PROTEST_TYPE_COLORS[String(r.eventType ?? 'protest')] ?? '#ffaa00'),
    }],
  },

  ucdpEvents: {
    layer: 'ucdpEvents',
    parts: [{
      kind: 'ucdp',
      rows: (p) => p ?? [],
      lat: (r) => num(r.latitude), lon: (r) => num(r.longitude),
      id: (r, i) => String(r.id ?? `ucdp-${i}`),
      title: (r) => `${r.side_a ?? ''} vs ${r.side_b ?? ''}`,
      // Size carries fatality count, as it did on the old globe.
      style: (r) => dot('#ff6400', Math.min(10, 5 + Number(r.deaths_best ?? 0) * 0.3)),
    }],
  },

  displacementFlows: {
    layer: 'displacement',
    parts: [{
      kind: 'displacement',
      // Only the origin end is a marker; the flow itself is an arc, which
      // needs polyline support (see the note on BRIDGE_SPECS above).
      rows: (p) => p ?? [],
      lat: (r) => num(r.originLat), lon: (r) => num(r.originLon),
      id: (r, i) => `${r.originCode ?? i}-${r.asylumCode ?? ''}`,
      title: (r) => `${r.originName ?? r.originCode ?? ''} → ${r.asylumName ?? r.asylumCode ?? ''}`,
      style: () => glyph('\u{1F465}', '#88bbff'),
    }],
  },

  climateAnomalies: {
    layer: 'climate',
    parts: [{
      kind: 'climate',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => `${r.zone ?? i}-${r.period ?? ''}`,
      title: (r) => `${r.zone ?? ''} (${r.type ?? 'mixed'})`,
      style: (r) => glyph('\u{1F321}', CLIMATE_TYPE_COLORS[String(r.type ?? 'mixed')] ?? '#88ff88', 10),
    }],
  },

  gpsJamming: {
    layer: 'gpsJamming',
    parts: [{
      kind: 'gpsjam',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.h3 ?? `gpsjam-${i}`),
      title: (r) => `GPS Jamming (${r.level ?? ''})`,
      style: (r) => glyph('\u{1F4E1}', r.level === 'high' ? '#ff2020' : '#ff8800', 10),
    }],
  },

  iranEvents: {
    layer: 'iranAttacks',
    parts: [{
      kind: 'iran',
      rows: (p) => p ?? [],
      lat: (r) => num(r.latitude), lon: (r) => num(r.longitude),
      id: (r, i) => String(r.id ?? `iran-${i}`),
      title: (r) => String(r.title ?? ''),
      // getIranEventHexColor lives in @/services/conflict and is resolved by
      // the caller, which owns the import — see IRAN_EVENT_COLOR below.
      style: (r) => dot(iranEventColor(r), 9, true),
    }],
  },

  techEvents: {
    layer: 'techEvents',
    parts: [{
      kind: 'tech',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lng),
      id: (r, i) => String(r.id ?? `tech-${i}`),
      title: (r) => String(r.title ?? ''),
      style: () => glyph('\u{1F4BB}', '#44aaff', 10),
    }],
  },

  flightDelays: {
    layer: 'flights',
    parts: [
      {
        kind: 'flightDelay',
        rows: (p) => p ?? [],
        skip: (r) => r.severity === 'normal',
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => String(r.id ?? `delay-${i}`),
        title: (r) => `${r.iata ?? ''} — ${r.severity ?? ''}`,
        style: (r) => glyph('✈',
          // 'unknown' means no telemetry reached us. It is drawn desaturated
          // grey on purpose so it never reads as the green "all clear" tier.
          r.severity === 'severe' ? '#ff2020' : r.severity === 'major' ? '#ff6600'
            : r.severity === 'moderate' ? '#ffaa00'
            : r.severity === 'unknown' ? '#7d7d8a' : '#ffee44'),
      },
      {
        kind: 'notamRing',
        rows: (p) => p ?? [],
        skip: (r) => r.delayType !== 'closure',
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => `notam-${r.id ?? i}`,
        title: (r) => `NOTAM: ${r.name || r.iata || ''}`,
        style: () => glyph('⚠', '#ff2828', 12, true),
      },
    ],
  },

  ais: {
    layer: 'ais',
    parts: [{
      kind: 'aisDisruption',
      // Density zones need a heatmap, which the bridge has no primitive for;
      // GlobeMap dropped them for the same reason.
      rows: (p) => p?.disruptions ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `ais-${i}`),
      title: (r) => String(r.name ?? ''),
      style: (r) => glyph('⛴',
        r.severity === 'high' ? '#ff2020' : r.severity === 'elevated' ? '#ff8800' : '#44aaff'),
    }],
  },

  cableActivity: {
    layer: 'cables',
    parts: [
      {
        kind: 'cableAdvisory',
        rows: (p) => p?.advisories ?? [],
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => String(r.id ?? `cable-adv-${i}`),
        title: (r) => `${r.title ?? ''} (${r.severity ?? ''})`,
        style: (r) => glyph('\u{1F50C}', r.severity === 'fault' ? '#ff2020' : '#ff8800'),
      },
      {
        kind: 'repairShip',
        rows: (p) => p?.repairShips ?? [],
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => String(r.id ?? `repair-${i}`),
        title: (r) => String(r.name ?? ''),
        style: (r) => glyph('\u{1F6A2}', r.status === 'on-station' ? '#44ff88' : '#44aaff'),
      },
    ],
  },

  militaryFlights: {
    layer: 'military',
    parts: [{
      kind: 'flight',
      rows: (p) => p?.flights ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => String(r.id ?? `milflight-${i}`),
      title: (r) => `${r.callsign ?? ''} (${r.aircraftType ?? r.type ?? 'fighter'})`,
      style: (r) => glyph('✈',
        FLIGHT_TYPE_COLORS[String(r.aircraftType ?? r.type ?? 'fighter')] ?? '#cccccc'),
      // Aircraft belong in the air. GlobeMap lifted them 0.012 Earth radii
      // off the surface so they cleared terrain and read as airborne.
      height: () => 76_000,
    }],
  },

  militaryVessels: {
    layer: 'military',
    parts: [
      {
        kind: 'vessel',
        rows: (p) => p?.vessels ?? [],
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => String(r.id ?? `vessel-${i}`),
        title: (r) => {
          const type = String(r.vesselType ?? 'unknown');
          const label = VESSEL_TYPE_LABELS[type] ?? type;
          const hull = r.hullNumber ? ` (${r.hullNumber})` : '';
          const provenance = r.usniSource ? 'EST. POSITION' : 'AIS LIVE';
          return `${r.name ?? 'vessel'}${hull} · ${label} · ${provenance}`;
        },
        style: (r) => {
          const type = String(r.vesselType ?? 'unknown');
          const color = VESSEL_TYPE_COLORS[type] ?? '#44aaff';
          return glyph(VESSEL_TYPE_ICONS[type] ?? '⛴', color,
            type === 'carrier' ? 15 : 10, Boolean(r.isDark));
        },
      },
      {
        kind: 'cluster',
        rows: (p) => p?.clusters ?? [],
        lat: (r) => num(r.lat), lon: (r) => num(r.lon),
        id: (r, i) => String(r.id ?? `cluster-${i}`),
        title: (r) => {
          const n = Number(r.vesselCount ?? 0);
          return `${r.name ?? ''} · ${n} vessel${n === 1 ? '' : 's'}`;
        },
        style: (r) => dot(
          CLUSTER_ACTIVITY_COLORS[String(r.activityType ?? 'unknown')] ?? '#6688aa',
          Math.max(14, Math.min(26, 12 + Number(r.vesselCount ?? 0) * 2)), true),
      },
    ],
  },

  satellites: {
    layer: 'satellites',
    parts: [{
      kind: 'satellite',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lng),
      id: (r, i) => String(r.noradId ?? `sat-${i}`),
      title: (r) => String(r.name ?? ''),
      style: (r) => dot(SAT_COUNTRY_COLORS[String(r.country ?? '')] ?? '#ccccff', 5),
      // Real orbital altitude, in metres. This is the one tracker whose
      // height is data rather than presentation, and Cesium can show it
      // honestly where a 2D projection could not.
      height: (r) => Math.max(0, Number(r.alt ?? 0)) * 1000,
    }],
  },

  imageryScenes: {
    // Filed under Orbital Surveillance with the satellites themselves, as on
    // the old globe.
    layer: 'satellites',
    parts: [{
      kind: 'imageryScene',
      rows: (p) => p ?? [],
      skip: (r) => !sceneCentre(r),
      lat: (r) => sceneCentre(r)?.lat ?? null,
      lon: (r) => sceneCentre(r)?.lon ?? null,
      id: (r, i) => String(r.id ?? `${r.satellite ?? 'scene'}-${r.datetime ?? i}`),
      title: (r) => `${r.satellite ?? ''} ${r.datetime ?? ''}`,
      style: () => glyph('\u{1F6F0}', '#00b4ff'),
    }],
  },

  webcams: {
    layer: 'webcams',
    parts: [
      {
        kind: 'webcam',
        rows: (p) => (p ?? []).filter((m: any) => !('count' in m)),
        lat: (r) => num(r.lat), lon: (r) => num(r.lng),
        id: (r, i) => String(r.webcamId ?? `webcam-${i}`),
        title: (r) => String(r.title ?? ''),
        style: () => glyph('\u{1F4F7}', '#00d4ff', 12),
      },
      {
        kind: 'webcam-cluster',
        rows: (p) => (p ?? []).filter((m: any) => 'count' in m),
        lat: (r) => num(r.lat), lon: (r) => num(r.lng),
        id: (r, i) => `webcam-cluster-${r.lat}-${r.lng}-${i}`,
        title: (r) => `${r.count ?? 0} webcams`,
        style: (r) => dot('#00d4ff', Math.max(12, Math.min(24, 10 + Number(r.count ?? 0)))),
      },
    ],
  },

  newsLocations: {
    // The one ungated marker set: GlobeMap pushed these regardless of the
    // layer tray, because they are the map's read-out of the news feed the
    // rest of the dashboard is already showing.
    layer: null,
    parts: [{
      kind: 'newsLocation',
      rows: (p) => p ?? [],
      lat: (r) => num(r.lat), lon: (r) => num(r.lon),
      id: (r, i) => `news-${i}-${String(r.title ?? '').slice(0, 20)}`,
      title: (r) => String(r.title ?? ''),
      style: (r) => {
        const level = String(r.threatLevel ?? 'info');
        const color = level === 'critical' ? '#ff2020'
          : level === 'high' ? '#ff6600'
          : (level === 'elevated' || level === 'medium') ? '#ffaa00'
          : '#44aaff';
        return dot(color, 16, true);
      },
    }],
  },
};

/* ── Late-bound bits ───────────────────────────────────────────────────── */

/**
 * Iran event colouring is owned by `@/services/conflict`, which this module
 * must not import: the spec table is pure data and is unit-tested without a
 * DOM or a service graph. CesiumGlobeMap injects the real resolver at boot.
 */
let iranEventColorFn: ((row: any) => string) | null = null;

export function setIranEventColorResolver(fn: (row: any) => string): void {
  iranEventColorFn = fn;
}

function iranEventColor(row: any): string {
  return iranEventColorFn?.(row) ?? '#ff6600';
}

/** Centre of an imagery scene's GeoJSON footprint, or null if unparseable. */
function sceneCentre(scene: any): { lat: number; lon: number } | null {
  try {
    const geom = JSON.parse(scene?.geometryGeojson ?? '');
    if (geom?.type !== 'Polygon') return null;
    const ring = geom.coordinates?.[0] as number[][] | undefined;
    if (!ring?.length) return null;
    const lats = ring.map((c) => c[1] ?? 0);
    const lons = ring.map((c) => c[0] ?? 0);
    return {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    };
  } catch {
    return null;
  }
}
