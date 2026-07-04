// TODO: Phase 2 — Orbital Surveillance Analysis Panel
// - Overhead Pass Prediction: compute next pass times over user-selected locations
//   (hotspots, conflict zones, bases). "GAOFEN-12 will be overhead Tartus in 14 min"
// - Revisit Time Analysis: how often a location is observed by hostile/friendly sats
// - Imaging Window Alerts: notify when SAR/optical sats are overhead a watched region
// - Sensor Swath Visualization: show ground coverage cone (FOV-based) not just nadir dot
// - Cross-Layer Correlation: satellite overhead + GPS jamming zone = EW context;
//   satellite overhead + conflict zone = battlefield ISR; satellite + AIS gap = maritime recon
// - Satellite Intel Summary Panel: table of tracked sats with orbit type, operator,
//   sensor capability, current position, next pass over user POI
// - Historical Pass Log: which sats passed over a location in the last 24h
//   (useful for identifying imaging windows after events)

import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';

import type { SatRec } from 'satellite.js';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

// satellite.js (~20KB) is only needed once the satellite layer fetches TLEs — never at
// boot. Lazy-load + cache the module so it ships off the eager main entry. initSatRecs
// (async) resolves the lib before propagatePositions (sync) runs in the loop.
type SatelliteLib = typeof import('satellite.js');
let satLib: SatelliteLib | null = null;
let satLibPromise: Promise<SatelliteLib> | null = null;
async function ensureSatelliteLib(): Promise<SatelliteLib> {
  if (satLib) return satLib;
  if (!satLibPromise) {
    satLibPromise = import('satellite.js')
      .then((m) => { satLib = m; return m; })
      .catch((err) => { satLibPromise = null; throw err; });
  }
  return satLibPromise;
}

const getIntelligenceClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

export interface SatelliteTLE {
  noradId: string;
  name: string;
  line1: string;
  line2: string;
  type: string;
  country: string;
}

export interface SatellitePosition {
  noradId: string;
  name: string;
  lat: number;
  lng: number;
  alt: number;
  type: string;
  country: string;
  velocity: number;
  inclination: number;
  trail: [number, number, number][];
}

export interface SatRecEntry {
  satrec: SatRec;
  meta: { noradId: string; name: string; type: string; country: string };
}

let cachedData: SatelliteTLE[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

let failures = 0;
let cooldownUntil = 0;
const MAX_FAILURES = 3;
const COOLDOWN_MS = 10 * 60 * 1000;

export async function fetchSatelliteTLEs(): Promise<SatelliteTLE[] | null> {
  const now = Date.now();
  if (now < cooldownUntil) return cachedData;
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);
    let resp;
    try {
      resp = await getIntelligenceClient().listSatellites({ country: '' }, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    // Proto returns `id` (the NORAD identifier); local SatelliteTLE uses `noradId`.
    // `alt`/`velocity`/`inclination` in the proto are unused by the propagation
    // client — we compute them ourselves from the TLE via satellite.js.
    const satellites: SatelliteTLE[] = (resp.satellites ?? []).map((s) => ({
      noradId: s.id,
      name: s.name,
      line1: s.line1,
      line2: s.line2,
      type: s.type,
      country: s.country,
    }));
    cachedData = satellites;
    cachedAt = now;
    failures = 0;
    return cachedData;
  } catch {
    failures++;
    if (failures >= MAX_FAILURES) {
      cooldownUntil = now + COOLDOWN_MS;
    }
    return cachedData;
  }
}

export async function initSatRecs(tles: SatelliteTLE[]): Promise<SatRecEntry[]> {
  const { twoline2satrec } = await ensureSatelliteLib();
  const entries: SatRecEntry[] = [];
  for (const tle of tles) {
    try {
      const satrec = twoline2satrec(tle.line1, tle.line2);
      entries.push({
        satrec,
        meta: { noradId: tle.noradId, name: tle.name, type: tle.type, country: tle.country },
      });
    } catch { /* skip malformed */ }
  }
  return entries;
}

export function propagatePositions(satRecs: SatRecEntry[], date?: Date): SatellitePosition[] {
  // satellite.js is loaded by initSatRecs before any propagation runs; if it has not
  // resolved yet (propagatePositions called before init), yield no positions this tick.
  if (!satLib) return [];
  const { gstime, propagate, eciToGeodetic, degreesLat, degreesLong } = satLib;
  const now = date || new Date();
  const gmst = gstime(now);
  const positions: SatellitePosition[] = [];

  for (const { satrec, meta } of satRecs) {
    try {
      const pv = propagate(satrec, now);
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
      const geo = eciToGeodetic(pv.position, gmst);
      const lat = degreesLat(geo.latitude);
      const lng = degreesLong(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const alt = geo.height;

      let velocity = 0;
      if (pv.velocity && typeof pv.velocity !== 'boolean') {
        const { x, y, z } = pv.velocity;
        velocity = Math.sqrt(x * x + y * y + z * z);
      }

      const trail: [number, number, number][] = [];
      for (let t = 1; t <= 15; t++) {
        const pastDate = new Date(now.getTime() - t * 60_000);
        const pastGmst = gstime(pastDate);
        try {
          const pastPv = propagate(satrec, pastDate);
          if (!pastPv || !pastPv.position || typeof pastPv.position === 'boolean') continue;
          const pastGeo = eciToGeodetic(pastPv.position, pastGmst);
          const tLat = degreesLat(pastGeo.latitude);
          const tLng = degreesLong(pastGeo.longitude);
          if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) continue;
          trail.push([tLng, tLat, pastGeo.height]);
        } catch { /* skip */ }
      }

      const inclination = satrec.inclo * (180 / Math.PI);
      positions.push({ ...meta, lat, lng, alt, velocity, inclination, trail });
    } catch { /* skip propagation errors */ }
  }
  return positions;
}

export function startPropagationLoop(
  satRecs: SatRecEntry[],
  callback: (positions: SatellitePosition[]) => void,
  intervalMs = 3000,
): () => void {
  const id = setInterval(() => {
    const positions = propagatePositions(satRecs);
    callback(positions);
  }, intervalMs);
  return () => clearInterval(id);
}

export function getSatelliteStatus(): string {
  if (Date.now() < cooldownUntil) return 'cooldown';
  if (failures > 0) return 'degraded';
  return 'ok';
}
