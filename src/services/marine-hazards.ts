/**
 * NWS Marine Weather Hazards
 * High surf, storm surge, coastal flooding, rip currents, offshore warnings.
 * Data source: NWS Alerts API (direct — CORS enabled) + High Seas Forecasts
 */

export type MarineHazardType =
  | 'storm-surge'
  | 'high-surf'
  | 'coastal-flood'
  | 'rip-current'
  | 'gale'
  | 'storm'
  | 'hurricane-wind'
  | 'tsunami'
  | 'fog'
  | 'special-marine'
  | 'other';

export interface MarineHazard {
  id: string;
  event: string;
  hazardType: MarineHazardType;
  headline: string;
  description: string;
  areaDesc: string;
  onset: Date;
  expires: Date;
  severity: 'critical' | 'high' | 'medium' | 'low';
  waveHeight: string | null;
  windSpeed: string | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: { data: MarineHazard[]; ts: number } | null = null;

const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active' +
  '?status=actual' +
  '&message_type=alert,update' +
  '&event=High+Surf+Advisory,High+Surf+Warning,Coastal+Flood+Warning,Coastal+Flood+Watch,' +
  'Storm+Surge+Warning,Storm+Surge+Watch,Tsunami+Warning,Rip+Current+Statement,' +
  'Dangerous+Surf,Special+Marine+Warning,Gale+Warning,Storm+Warning,' +
  'Hurricane+Force+Wind+Warning,Dense+Fog+Advisory';

const NWS_HSF_URL = 'https://api.weather.gov/products?type=HSF&limit=3';

interface NWSAlertProperties {
  id?: string;
  event?: string;
  headline?: string | null;
  description?: string | null;
  areaDesc?: string | null;
  onset?: string | null;
  expires?: string | null;
  severity?: string | null;
}

interface NWSAlertFeature {
  id?: string;
  properties?: NWSAlertProperties;
}

interface NWSAlertsResponse {
  features?: NWSAlertFeature[];
}

interface NWSProductListItem {
  '@id'?: string;
  productCode?: string;
  productName?: string;
  issuanceTime?: string;
}

interface NWSProductListResponse {
  '@graph'?: NWSProductListItem[];
}

function classifyHazardType(event: string): MarineHazardType {
  const e = event.toLowerCase();
  if (e.includes('storm surge')) return 'storm-surge';
  if (e.includes('high surf') || e.includes('dangerous surf')) return 'high-surf';
  if (e.includes('coastal flood')) return 'coastal-flood';
  if (e.includes('rip current')) return 'rip-current';
  if (e.includes('gale')) return 'gale';
  if (e.includes('storm warning')) return 'storm';
  if (e.includes('hurricane force')) return 'hurricane-wind';
  if (e.includes('tsunami')) return 'tsunami';
  if (e.includes('fog')) return 'fog';
  if (e.includes('special marine')) return 'special-marine';
  return 'other';
}

function extractWaveHeight(text: string): string | null {
  const m = text.match(/(\d+)\s*(?:to\s*(\d+))?\s*f(?:ee)?t/i);
  if (!m) return null;
  return m[2] ? `${m[1]} to ${m[2]} ft` : `${m[1]} ft`;
}

function extractWindSpeed(text: string): string | null {
  const m = text.match(/(\d+)\s*(?:to\s*(\d+))?\s*mph/i);
  if (!m) return null;
  return m[2] ? `${m[1]} to ${m[2]} mph` : `${m[1]} mph`;
}

function parseWaveHeightValue(waveHeight: string | null): number {
  if (!waveHeight) return 0;
  const nums = waveHeight.match(/\d+/g);
  if (!nums) return 0;
  return Math.max(...nums.map(Number));
}

function computeSeverity(
  hazardType: MarineHazardType,
  waveHeight: string | null,
): MarineHazard['severity'] {
  const maxWave = parseWaveHeightValue(waveHeight);
  if (maxWave > 20) return 'critical';

  switch (hazardType) {
    case 'storm-surge':
    case 'tsunami':
      return 'critical';
    case 'gale':
    case 'storm':
    case 'hurricane-wind':
      return 'high';
    case 'high-surf':
    case 'coastal-flood':
      return 'medium';
    case 'fog':
    case 'rip-current':
      return 'low';
    case 'special-marine':
      return 'high';
    default:
      return 'low';
  }
}

function safeDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date() : d;
}

async function fetchAlerts(): Promise<MarineHazard[]> {
  const res = await fetch(NWS_ALERTS_URL, {
    headers: { Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return [];

  const json: NWSAlertsResponse = await res.json();
  const features = json.features ?? [];
  const now = new Date();
  const results: MarineHazard[] = [];

  for (const feature of features) {
    const p = feature.properties ?? {};
    const id = feature.id ?? p.id ?? Math.random().toString(36).slice(2);
    const event = p.event ?? '';
    const expires = safeDate(p.expires);

    // Skip expired alerts
    if (expires < now) continue;

    const description = p.description ?? '';
    const headline = p.headline ?? event;
    const hazardType = classifyHazardType(event);
    const waveHeight = extractWaveHeight(description);
    const windSpeed = extractWindSpeed(description);
    const severity = computeSeverity(hazardType, waveHeight);

    results.push({
      id: `marine-${id}`,
      event,
      hazardType,
      headline,
      description,
      areaDesc: p.areaDesc ?? '',
      onset: safeDate(p.onset),
      expires,
      severity,
      waveHeight,
      windSpeed,
    });
  }

  return results;
}

async function checkHighSeasForecasts(): Promise<boolean> {
  try {
    const res = await fetch(NWS_HSF_URL, {
      headers: { Accept: 'application/ld+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return false;

    const json: NWSProductListResponse = await res.json();
    const products = json['@graph'] ?? [];
    if (products.length === 0) return false;

    // Fetch the first product text to check for extreme wave heights
    const first = products[0];
    if (!first) return false;
    const productId = first['@id'];
    if (!productId) return false;

    const textRes = await fetch(productId, {
      headers: { Accept: 'application/ld+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!textRes.ok) return false;

    const textJson = (await textRes.json()) as { productText?: string };
    const text = textJson.productText ?? '';

    // Check for wave heights > 20ft
    const waveMatches = text.matchAll(/(\d+)\s*(?:to\s*(\d+))?\s*f(?:ee)?t/gi);
    for (const m of waveMatches) {
      const high = m[2] ? parseInt(m[2], 10) : parseInt(m[1] ?? '0', 10);
      if (high > 20) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const SEVERITY_ORDER: Record<MarineHazard['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchMarineHazards(): Promise<MarineHazard[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;

  const [alertsResult, extremeHsfResult] = await Promise.allSettled([
    fetchAlerts(),
    checkHighSeasForecasts(),
  ]);

  const alerts = alertsResult.status === 'fulfilled' ? alertsResult.value : (cache?.data ?? []);
  const hasExtremeHsf = extremeHsfResult.status === 'fulfilled' ? extremeHsfResult.value : false;

  // If extreme offshore conditions found, ensure any offshore/storm hazards are promoted
  const data = alerts
    .map((hazard) => {
      if (
        hasExtremeHsf &&
        (hazard.hazardType === 'storm' || hazard.hazardType === 'gale' || hazard.hazardType === 'hurricane-wind')
      ) {
        return { ...hazard, severity: 'critical' as const };
      }
      return hazard;
    })
    .sort((a, b) => {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    })
    .slice(0, 50);

  cache = { data, ts: Date.now() };
  return data;
}

export function marineHazardSeverityClass(severity: MarineHazard['severity']): string {
  switch (severity) {
    case 'critical': return 'eq-row eq-major';
    case 'high': return 'eq-row eq-strong';
    case 'medium': return 'eq-row eq-moderate';
    case 'low': return 'eq-row';
  }
}
