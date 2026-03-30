/**
 * NOAA National Data Buoy Center (NDBC) — Ocean buoy and C-MAN station data
 * Public API — no authentication required
 * https://www.ndbc.noaa.gov/
 *
 * During tropical cyclones and severe oceanic events, NOAA buoys provide
 * the earliest real-time surface observations: wave heights, wind speeds,
 * pressure drops — often hours before aircraft reconnaissance can reach a storm.
 *
 * Also covers:
 *  - Significant wave height alerts (rogue waves, storm surge precursors)
 *  - Rapid pressure drops (bomb cyclogenesis)
 *  - Extreme wind events over open ocean
 *
 * NOAA Hurricane Reconnaissance (NOAA/AFRES WC-130J/P-3):
 *  - Flight tracks at https://www.nhc.noaa.gov/recon/
 *  - Real-time fixes via NHC Vortex Data Messages (VDMs)
 */

export interface BuoyObservation {
  stationId: string;
  stationName: string;
  lat: number;
  lon: number;
  observedAt: Date;
  // Meteorological
  windSpeedMs: number | null;      // m/s — multiply by 1.944 for knots
  windGustMs: number | null;
  windDirectionDeg: number | null;
  airPressureMb: number | null;
  pressureTendencyMb: number | null;  // change in last 3 hours
  airTempC: number | null;
  // Oceanic
  waveHeightM: number | null;          // significant wave height
  dominantWavePeriodS: number | null;
  waterTempC: number | null;
  // Status
  isAlertCondition: boolean;
  alertReason: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'normal';
}

export interface HurricaneReconFix {
  id: string;
  stormId: string;
  stormName: string;
  lat: number;
  lon: number;
  altitudeFt: number;
  flightLevelWindKts: number | null;
  surfaceWindKts: number | null;
  minPressureMb: number | null;
  eyewallDiameterNm: number | null;
  observedAt: Date;
  aircraft: string;    // e.g. "NOAA43", "AF303"
}

// NDBC real-time data (5-minute observations) — CORS-enabled
// Each station has: https://www.ndbc.noaa.gov/data/realtime2/{STATIONID}.txt
// Station list: https://www.ndbc.noaa.gov/stations/station_table.phtml
// Active buoy RSS: https://www.ndbc.noaa.gov/rss/active_buoys.rss

// High-value stations in hurricane-prone regions
const KEY_STATIONS = [
  // Atlantic/Caribbean
  '41047', '41048', '41049', '41044', '41046', '41043',
  // Gulf of Mexico
  '42001', '42002', '42003', '42036', '42040', '42055',
  // East Pacific
  '51000', '51001', '51002', '51003', '51004',
  // Western Pacific
  '52200', '52211', '52212',
];

const NDBC_REALTIME = 'https://www.ndbc.noaa.gov/data/realtime2';
const NDBC_ACTIVE_STATIONS_XML = 'https://www.ndbc.noaa.gov/activestations.xml';

// NHC recon: vortex data messages RSS
const NHC_VDM_RSS = 'https://www.nhc.noaa.gov/recon/recon.rss';

const CACHE_TTL_MS = 10 * 60 * 1000;
const STATION_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
let buoyCache: { observations: BuoyObservation[]; fetchedAt: number } | null = null;
let reconCache: { fixes: HurricaneReconFix[]; fetchedAt: number } | null = null;
let stationMetadataCache: { data: Map<string, BuoyStationMetadata>; fetchedAt: number } | null = null;

interface BuoyStationMetadata {
  lat: number;
  lon: number;
  name: string;
}

function parseBuoyLine(line: string, headers: string[]): Record<string, string> {
  const vals = line.trim().split(/\s+/);
  const obj: Record<string, string> = {};
  headers.forEach((h, i) => { obj[h] = vals[i] ?? 'MM'; });
  return obj;
}

function toNum(val: string | undefined): number | null {
  if (!val || val === 'MM' || val === 'N/A') return null;
  const n = Number.parseFloat(val);
  return isNaN(n) ? null : n;
}

function computeAlertCondition(obs: Partial<BuoyObservation>): { isAlert: boolean; reason: string; severity: BuoyObservation['severity'] } {
  const reasons: string[] = [];
  let severity: BuoyObservation['severity'] = 'normal';

  const windKts = obs.windSpeedMs == undefined ? null : obs.windSpeedMs * 1.944;
  const gust = obs.windGustMs == undefined ? null : obs.windGustMs * 1.944;

  if (obs.waveHeightM != undefined) {
    if (obs.waveHeightM >= 14) { reasons.push(`Extreme waves ${obs.waveHeightM.toFixed(1)}m`); severity = 'critical'; }
    else if (obs.waveHeightM >= 9) { reasons.push(`Very high waves ${obs.waveHeightM.toFixed(1)}m`); if (severity === 'normal') severity = 'high'; }
    else if (obs.waveHeightM >= 6) { reasons.push(`High waves ${obs.waveHeightM.toFixed(1)}m`); if (severity === 'normal') severity = 'medium'; }
  }

  if (windKts != undefined) {
    if (windKts >= 64) { reasons.push(`Hurricane-force winds ${windKts.toFixed(0)}kt`); severity = 'critical'; }
    else if (windKts >= 48) { reasons.push(`Storm-force winds ${windKts.toFixed(0)}kt`); if (severity !== 'critical') severity = 'high'; }
    else if (windKts >= 34) { reasons.push(`Gale-force winds ${windKts.toFixed(0)}kt`); if (severity === 'normal') severity = 'medium'; }
  }

  if (gust != undefined && gust >= 64 && !reasons.some(r => r.includes('winds'))) {
    reasons.push(`Hurricane-force gusts ${gust.toFixed(0)}kt`);
    severity = 'critical';
  }

  if (obs.airPressureMb != undefined) {
    if (obs.airPressureMb < 960) { reasons.push(`Extreme low pressure ${obs.airPressureMb}mb`); severity = 'critical'; }
    else if (obs.airPressureMb < 980) { reasons.push(`Very low pressure ${obs.airPressureMb}mb`); if (severity === 'normal') severity = 'high'; }
  }

  if (obs.pressureTendencyMb != undefined && obs.pressureTendencyMb <= -6) {
    reasons.push(`Rapid pressure fall ${obs.pressureTendencyMb}mb/3h`);
    if (severity === 'normal') severity = 'high';
  }

  return { isAlert: reasons.length > 0, reason: reasons.join('; '), severity };
}

function parseStationMetadata(xml: string): Map<string, BuoyStationMetadata> {
  const stationMetadata = new Map<string, BuoyStationMetadata>();

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (!doc.querySelector('parsererror')) {
      doc.querySelectorAll('station').forEach((station) => {
        const id = station.getAttribute('id')?.trim();
        const lat = Number.parseFloat(station.getAttribute('lat') ?? '');
        const lon = Number.parseFloat(station.getAttribute('lon') ?? '');
        const name = station.getAttribute('name')?.trim() ?? id ?? '';
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        stationMetadata.set(id, { lat, lon, name });
      });
      if (stationMetadata.size > 0) return stationMetadata;
    }
  } catch {}

  const stationMatches = xml.matchAll(/<station\b[^>]*\bid="([^"]+)"[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*\bname="([^"]*)"/gi);
  for (const match of stationMatches) {
    const id = match[1]?.trim();
    const lat = Number.parseFloat(match[2] ?? '');
    const lon = Number.parseFloat(match[3] ?? '');
    const name = match[4]?.trim() ?? id ?? '';
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stationMetadata.set(id, { lat, lon, name });
  }

  return stationMetadata;
}

async function fetchStationMetadata(): Promise<Map<string, BuoyStationMetadata>> {
  if (stationMetadataCache && Date.now() - stationMetadataCache.fetchedAt < STATION_METADATA_TTL_MS) {
    return stationMetadataCache.data;
  }

  try {
    const res = await fetch(NDBC_ACTIVE_STATIONS_XML, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return stationMetadataCache?.data ?? new Map();
    const xml = await res.text();
    const stationMetadata = parseStationMetadata(xml);
    stationMetadataCache = { data: stationMetadata, fetchedAt: Date.now() };
    return stationMetadata;
  } catch {
    return stationMetadataCache?.data ?? new Map();
  }
}

async function fetchBuoyData(
  stationId: string,
  stationMeta?: BuoyStationMetadata | null,
): Promise<BuoyObservation | null> {
  try {
    const url = `${NDBC_REALTIME}/${stationId}.txt`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length < 2) return null;

    // First non-# line is the header row, second is units, then data
    const headerLines = text.split('\n').filter(l => l.startsWith('#'));
    const rawHeader = headerLines[0]?.replace(/^#\s*/, '') ?? lines[0] ?? '';
    const headers = rawHeader.trim().split(/\s+/).map(h => h.replace(/^#/, '').toUpperCase());
    const dataLines = lines.filter(l => !l.startsWith('#'));
    if (dataLines.length < 2) return null;
    const dataLine = dataLines[1] ?? dataLines[0] ?? ''; // most recent observation (after unit row)

    const row = parseBuoyLine(dataLine, headers);

    const year = row.YY ?? row.YYYY ?? '';
    const mm = (row.MM ?? '').padStart(2, '0');
    const dd = (row.DD ?? '').padStart(2, '0');
    const hh = (row.HH ?? row.HR ?? '00').padStart(2, '0');
    const mn = (row.MN ?? row.MIN ?? '00').padStart(2, '0');
    const dateStr = `20${year.length === 2 ? year : year.slice(2)}-${mm}-${dd}T${hh}:${mn}:00Z`;

    const obs: Partial<BuoyObservation> = {
      stationId,
      stationName: stationMeta?.name ?? stationId,
      lat: stationMeta?.lat ?? 0,
      lon: stationMeta?.lon ?? 0,
      observedAt: new Date(dateStr),
      windSpeedMs: toNum(row.WSPD ?? row.WS),
      windGustMs: toNum(row.GST ?? row.WGST),
      windDirectionDeg: toNum(row.WDIR),
      airPressureMb: toNum(row.PRES ?? row.BAR),
      pressureTendencyMb: toNum(row.PTDY),
      airTempC: toNum(row.ATMP),
      waveHeightM: toNum(row.WVHT),
      dominantWavePeriodS: toNum(row.DPD),
      waterTempC: toNum(row.WTMP),
    };

    const { isAlert, reason, severity } = computeAlertCondition(obs);
    return { ...(obs as BuoyObservation), isAlertCondition: isAlert, alertReason: reason, severity };
  } catch {
    return null;
  }
}

export async function fetchBuoyAlerts(): Promise<BuoyObservation[]> {
  if (buoyCache && Date.now() - buoyCache.fetchedAt < CACHE_TTL_MS) return buoyCache.observations;

  const stationMetadata = await fetchStationMetadata();
  const results = await Promise.allSettled(
    KEY_STATIONS.map((id) => fetchBuoyData(id, stationMetadata.get(id) ?? null)),
  );
  const observations: BuoyObservation[] = results
    .filter((r): r is PromiseFulfilledResult<BuoyObservation> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .filter(o => o.isAlertCondition)
    .sort((a, b) => {
      const sOrder: Record<BuoyObservation['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, normal: 4 };
      return sOrder[a.severity] - sOrder[b.severity];
    });

  buoyCache = { observations, fetchedAt: Date.now() };
  return observations;
}

async function fetchReconRss(): Promise<HurricaneReconFix[]> {
  if (reconCache && Date.now() - reconCache.fetchedAt < CACHE_TTL_MS) return reconCache.fixes;

  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(NHC_VDM_RSS)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return reconCache?.fixes ?? [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return reconCache?.fixes ?? [];

    const items = doc.querySelectorAll('item');
    const fixes: HurricaneReconFix[] = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, ' ').trim();
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const guid = item.querySelector('guid')?.textContent?.trim() ?? '';

      const fullText = title + ' ' + description;

      const latMatch = /(\d+\.\d+)\s*[Nn]/.exec(fullText);
      const lonMatch = /(\d+\.\d+)\s*[Ww]/.exec(fullText);
      const pressMatch = /MSLP[:\s]+(\d+)\s*MB/i.exec(fullText);
      const surfWindMatch = /SFC\s+WND[:\s]+(\d+)\s*KT/i.exec(fullText);
      const flWindMatch = /(?:FL|FLVL)\s+WND[:\s]+(\d+)\s*KT/i.exec(fullText);
      const altMatch = /(\d{3,5})\s*FT/i.exec(fullText);
      const aircraftMatch = /\b(NOAA\d+|AF\d+|N[A-Z0-9]{3,6})\b/.exec(fullText);
      const stormMatch = /\b([A-Z]{2}AL\d{2}|[A-Z]{2}EP\d{2}|[A-Z]{2}WP\d{2}|HURRICANE\s+[A-Z]+|TROPICAL\s+STORM\s+[A-Z]+)\b/i.exec(fullText);

      if (!latMatch?.[1] || !lonMatch?.[1]) continue;

      fixes.push({
        id: `recon-${guid || `${pubDateStr}-${latMatch[1]}`}`,
        stormId: stormMatch?.[1] ?? 'unknown',
        stormName: stormMatch?.[1]?.replace(/^(HURRICANE|TROPICAL STORM)\s+/i, '') ?? 'Unknown',
        lat: Number.parseFloat(latMatch[1]),
        lon: -Number.parseFloat(lonMatch[1]), // West longitude
        altitudeFt: altMatch?.[1] ? Number.parseInt(altMatch[1], 10) : 10_000,
        flightLevelWindKts: flWindMatch?.[1] ? Number.parseInt(flWindMatch[1], 10) : null,
        surfaceWindKts: surfWindMatch?.[1] ? Number.parseInt(surfWindMatch[1], 10) : null,
        minPressureMb: pressMatch?.[1] ? Number.parseInt(pressMatch[1], 10) : null,
        eyewallDiameterNm: null,
        observedAt: pubDateStr ? new Date(pubDateStr) : new Date(),
        aircraft: aircraftMatch?.[1] ?? 'Unknown',
      });
    }

    reconCache = { fixes, fetchedAt: Date.now() };
    return fixes;
  } catch {
    return reconCache?.fixes ?? [];
  }
}

export async function fetchHurricaneRecon(): Promise<HurricaneReconFix[]> {
  return fetchReconRss();
}

export function buoySeverityClass(severity: BuoyObservation['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
    normal: 'eq-row',
  }[severity] ?? 'eq-row';
}
