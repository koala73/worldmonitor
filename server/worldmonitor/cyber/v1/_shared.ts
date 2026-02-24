/**
 * Shared helpers, constants, types, and enum mappings for the Cyber domain.
 *
 * Five upstream threat intelligence sources:
 *   - Feodo Tracker (abuse.ch C2 botnet IPs)
 *   - URLhaus (abuse.ch malicious URLs)
 *   - C2IntelFeeds (GitHub CSV of C2 IPs)
 *   - AlienVault OTX (threat indicators)
 *   - AbuseIPDB (IP blacklist)
 *
 * All source fetchers have graceful degradation: return empty on upstream failure.
 * No error logging on upstream failures (following established 2F-01 pattern).
 * No caching in handler (client-side polling manages refresh intervals).
 * GeoIP hydration uses in-memory cache for resolved IPs within a process lifetime.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  CyberThreat,
  CyberThreatType,
  CyberThreatSource,
  CyberThreatIndicatorType,
  CriticalityLevel,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 90;

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit: number) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;
const C2INTEL_URL = 'https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv';
const OTX_INDICATORS_URL = 'https://otx.alienvault.com/api/v1/indicators/export?type=IPv4&modified_since=';
const ABUSEIPDB_BLACKLIST_URL = 'https://api.abuseipdb.com/api/v2/blacklist';

const UPSTREAM_TIMEOUT_MS = 8000;
const GEO_MAX_UNRESOLVED = 250;
const GEO_CONCURRENCY = 16;
const GEO_OVERALL_TIMEOUT_MS = 15_000;
const GEO_PER_IP_TIMEOUT_MS = 3000;
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ========================================================================
// Helper utilities
// ========================================================================

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function cleanString(value: unknown, maxLen = 120): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidCoordinates(lat: number | null, lon: number | null): boolean {
  if (lat === null || lon === null) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isIPv4(value: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function isIPv6(value: string): boolean {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}

function isIpAddress(value: string): boolean {
  const candidate = cleanString(value, 80).toLowerCase();
  if (!candidate) return false;
  return isIPv4(candidate) || isIPv6(candidate);
}

function normalizeCountry(value: unknown): string {
  const raw = cleanString(String(value ?? ''), 64);
  if (!raw) return '';
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function toEpochMs(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  const raw = cleanString(String(value), 80);
  if (!raw) return 0;
  const normalized = raw.replace(' UTC', 'Z').replace(' GMT', 'Z').replace(' +00:00', 'Z').replace(' ', 'T');
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.getTime();
  const fallback = new Date(normalized);
  if (!Number.isNaN(fallback.getTime())) return fallback.getTime();
  return 0;
}

function normalizeTags(input: unknown, maxTags = 8): string[] {
  const tags: unknown[] = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? (input as string).split(/[;,|]/g)
      : [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const clean = cleanString(String(tag ?? ''), 40).toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
    if (normalized.length >= maxTags) break;
  }
  return normalized;
}

// ========================================================================
// Enum mappings (legacy string -> proto enum)
// ========================================================================

export const THREAT_TYPE_MAP: Record<string, CyberThreatType> = {
  c2_server: 'CYBER_THREAT_TYPE_C2_SERVER',
  malware_host: 'CYBER_THREAT_TYPE_MALWARE_HOST',
  phishing: 'CYBER_THREAT_TYPE_PHISHING',
  malicious_url: 'CYBER_THREAT_TYPE_MALICIOUS_URL',
};

export const SOURCE_MAP: Record<string, CyberThreatSource> = {
  feodo: 'CYBER_THREAT_SOURCE_FEODO',
  urlhaus: 'CYBER_THREAT_SOURCE_URLHAUS',
  c2intel: 'CYBER_THREAT_SOURCE_C2INTEL',
  otx: 'CYBER_THREAT_SOURCE_OTX',
  abuseipdb: 'CYBER_THREAT_SOURCE_ABUSEIPDB',
};

const INDICATOR_TYPE_MAP: Record<string, CyberThreatIndicatorType> = {
  ip: 'CYBER_THREAT_INDICATOR_TYPE_IP',
  domain: 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN',
  url: 'CYBER_THREAT_INDICATOR_TYPE_URL',
};

export const SEVERITY_MAP: Record<string, CriticalityLevel> = {
  low: 'CRITICALITY_LEVEL_LOW',
  medium: 'CRITICALITY_LEVEL_MEDIUM',
  high: 'CRITICALITY_LEVEL_HIGH',
  critical: 'CRITICALITY_LEVEL_CRITICAL',
};

export const SEVERITY_RANK: Record<string, number> = {
  CRITICALITY_LEVEL_CRITICAL: 4,
  CRITICALITY_LEVEL_HIGH: 3,
  CRITICALITY_LEVEL_MEDIUM: 2,
  CRITICALITY_LEVEL_LOW: 1,
  CRITICALITY_LEVEL_UNSPECIFIED: 0,
};

// ========================================================================
// Country centroids (fallback for IPs without geo data)
// ========================================================================

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US:[39.8,-98.6],CA:[56.1,-106.3],MX:[23.6,-102.6],BR:[-14.2,-51.9],AR:[-38.4,-63.6],
  GB:[55.4,-3.4],DE:[51.2,10.5],FR:[46.2,2.2],IT:[41.9,12.6],ES:[40.5,-3.7],
  NL:[52.1,5.3],BE:[50.5,4.5],SE:[60.1,18.6],NO:[60.5,8.5],FI:[61.9,25.7],
  DK:[56.3,9.5],PL:[51.9,19.1],CZ:[49.8,15.5],AT:[47.5,14.6],CH:[46.8,8.2],
  PT:[39.4,-8.2],IE:[53.1,-8.2],RO:[45.9,25.0],HU:[47.2,19.5],BG:[42.7,25.5],
  HR:[45.1,15.2],SK:[48.7,19.7],UA:[48.4,31.2],RU:[61.5,105.3],BY:[53.7,28.0],
  TR:[39.0,35.2],GR:[39.1,21.8],RS:[44.0,21.0],CN:[35.9,104.2],JP:[36.2,138.3],
  KR:[35.9,127.8],IN:[20.6,79.0],PK:[30.4,69.3],BD:[23.7,90.4],ID:[-0.8,113.9],
  TH:[15.9,101.0],VN:[14.1,108.3],PH:[12.9,121.8],MY:[4.2,101.9],SG:[1.4,103.8],
  TW:[23.7,121.0],HK:[22.4,114.1],AU:[-25.3,133.8],NZ:[-40.9,174.9],
  ZA:[-30.6,22.9],NG:[9.1,8.7],EG:[26.8,30.8],KE:[-0.02,37.9],ET:[9.1,40.5],
  MA:[31.8,-7.1],DZ:[28.0,1.7],TN:[33.9,9.5],GH:[7.9,-1.0],
  SA:[23.9,45.1],AE:[23.4,53.8],IL:[31.0,34.9],IR:[32.4,53.7],IQ:[33.2,43.7],
  KW:[29.3,47.5],QA:[25.4,51.2],BH:[26.0,50.6],JO:[30.6,36.2],LB:[33.9,35.9],
  CL:[-35.7,-71.5],CO:[4.6,-74.3],PE:[-9.2,-75.0],VE:[6.4,-66.6],
  KZ:[48.0,68.0],UZ:[41.4,64.6],GE:[42.3,43.4],AZ:[40.1,47.6],AM:[40.1,45.0],
  LT:[55.2,23.9],LV:[56.9,24.1],EE:[58.6,25.0],
  HN:[15.2,-86.2],GT:[15.8,-90.2],PA:[8.5,-80.8],CR:[9.7,-84.0],
  SN:[14.5,-14.5],CM:[7.4,12.4],CI:[7.5,-5.5],TZ:[-6.4,34.9],UG:[1.4,32.3],
};

function getCountryCentroid(countryCode: string): { lat: number; lon: number } | null {
  if (!countryCode) return null;
  const coords = COUNTRY_CENTROIDS[countryCode.toUpperCase()];
  if (!coords) return null;
  const jitter = () => (Math.random() - 0.5) * 2;
  return { lat: coords[0] + jitter(), lon: coords[1] + jitter() };
}

// ========================================================================
// Internal threat shape (intermediate before proto mapping)
// ========================================================================

export interface RawThreat {
  id: string;
  type: string;
  source: string;
  indicator: string;
  indicatorType: string;
  lat: number | null;
  lon: number | null;
  country: string;
  severity: string;
  malwareFamily: string;
  tags: string[];
  firstSeen: number; // epoch ms
  lastSeen: number;  // epoch ms
}

function sanitizeRawThreat(threat: Partial<RawThreat> & { indicator?: string }): RawThreat | null {
  const indicator = cleanString(threat.indicator, 255);
  if (!indicator) return null;

  const indicatorType = threat.indicatorType || 'ip';
  if (indicatorType === 'ip' && !isIpAddress(indicator)) return null;

  return {
    id: cleanString(threat.id, 255) || `${threat.source || 'feodo'}:${indicatorType}:${indicator}`,
    type: threat.type || 'malicious_url',
    source: threat.source || 'feodo',
    indicator,
    indicatorType,
    lat: threat.lat ?? null,
    lon: threat.lon ?? null,
    country: threat.country || '',
    severity: threat.severity || 'medium',
    malwareFamily: cleanString(threat.malwareFamily, 80),
    tags: threat.tags || [],
    firstSeen: threat.firstSeen || 0,
    lastSeen: threat.lastSeen || 0,
  };
}

// ========================================================================
// GeoIP hydration (in-memory cache only -- no Redis in handler layer)
// ========================================================================

const GEO_CACHE_MAX_SIZE = 2048;
const geoCache = new Map<string, { lat: number; lon: number; country: string; ts: number }>();

function getGeoCached(ip: string): { lat: number; lon: number; country: string } | null {
  const entry = geoCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > GEO_CACHE_TTL_MS) {
    geoCache.delete(ip);
    return null;
  }
  return entry;
}

function setGeoCached(ip: string, geo: { lat: number; lon: number; country: string }): void {
  // Evict oldest entries when cache exceeds max size (C-1 fix)
  if (geoCache.size >= GEO_CACHE_MAX_SIZE) {
    const keysToDelete = Array.from(geoCache.keys()).slice(0, Math.floor(GEO_CACHE_MAX_SIZE / 4));
    for (const key of keysToDelete) geoCache.delete(key);
  }
  geoCache.set(ip, { ...geo, ts: Date.now() });
}

async function fetchGeoIp(
  ip: string,
  signal?: AbortSignal,
): Promise<{ lat: number; lon: number; country: string } | null> {
  // Primary: ipinfo.io
  try {
    const resp = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: signal || AbortSignal.timeout(GEO_PER_IP_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = await resp.json() as { loc?: string; country?: string };
      const parts = (data.loc || '').split(',');
      const lat = toFiniteNumber(parts[0]);
      const lon = toFiniteNumber(parts[1]);
      if (hasValidCoordinates(lat, lon)) {
        return { lat: lat!, lon: lon!, country: normalizeCountry(data.country) };
      }
    }
  } catch { /* fall through */ }

  // Check if already aborted before fallback
  if (signal?.aborted) return null;

  // Fallback: freeipapi.com
  try {
    const resp = await fetch(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: signal || AbortSignal.timeout(GEO_PER_IP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { latitude?: number; longitude?: number; countryCode?: string; countryName?: string };
    const lat = toFiniteNumber(data.latitude);
    const lon = toFiniteNumber(data.longitude);
    if (!hasValidCoordinates(lat, lon)) return null;
    return { lat: lat!, lon: lon!, country: normalizeCountry(data.countryCode || data.countryName) };
  } catch {
    return null;
  }
}

async function geolocateIp(
  ip: string,
  signal?: AbortSignal,
): Promise<{ lat: number; lon: number; country: string } | null> {
  const cached = getGeoCached(ip);
  if (cached) return cached;
  const geo = await fetchGeoIp(ip, signal);
  if (geo) setGeoCached(ip, geo);
  return geo;
}

export async function hydrateThreatCoordinates(threats: RawThreat[]): Promise<RawThreat[]> {
  // Collect unique IPs needing resolution
  const unresolvedIps: string[] = [];
  const seenIps = new Set<string>();

  for (const threat of threats) {
    if (hasValidCoordinates(threat.lat, threat.lon)) continue;
    if (threat.indicatorType !== 'ip') continue;
    const ip = cleanString(threat.indicator, 80).toLowerCase();
    if (!isIpAddress(ip) || seenIps.has(ip)) continue;
    seenIps.add(ip);
    unresolvedIps.push(ip);
  }

  const capped = unresolvedIps.slice(0, GEO_MAX_UNRESOLVED);
  const resolvedByIp = new Map<string, { lat: number; lon: number; country: string }>();

  // AbortController cancels orphaned workers on timeout (M-16 fix)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEO_OVERALL_TIMEOUT_MS);

  // Concurrent workers
  const queue = [...capped];
  const workerCount = Math.min(GEO_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0 && !controller.signal.aborted) {
      const ip = queue.shift();
      if (!ip) continue;
      const geo = await geolocateIp(ip, controller.signal);
      if (geo) resolvedByIp.set(ip, geo);
    }
  });

  try {
    await Promise.all(workers);
  } catch { /* aborted — expected */ }
  clearTimeout(timeoutId);

  return threats.map((threat) => {
    if (hasValidCoordinates(threat.lat, threat.lon)) return threat;
    if (threat.indicatorType !== 'ip') return threat;

    const lookup = resolvedByIp.get(cleanString(threat.indicator, 80).toLowerCase());
    if (lookup) {
      return { ...threat, lat: lookup.lat, lon: lookup.lon, country: threat.country || lookup.country };
    }

    const centroid = getCountryCentroid(threat.country);
    if (centroid) {
      return { ...threat, lat: centroid.lat, lon: centroid.lon };
    }

    return threat;
  });
}

// ========================================================================
// Source result type
// ========================================================================

export interface SourceResult {
  ok: boolean;
  threats: RawThreat[];
}

// ========================================================================
// Source 1: Feodo Tracker
// ========================================================================

function inferFeodoSeverity(record: any, malwareFamily: string): string {
  if (/emotet|qakbot|trickbot|dridex|ransom/i.test(malwareFamily)) return 'critical';
  const status = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();
  if (status === 'online') return 'high';
  return 'medium';
}

function parseFeodoRecord(record: any, cutoffMs: number): RawThreat | null {
  const ip = cleanString(
    record?.ip_address || record?.dst_ip || record?.ip || record?.ioc || record?.host,
    80,
  ).toLowerCase();
  if (!isIpAddress(ip)) return null;

  const statusRaw = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();
  if (statusRaw && statusRaw !== 'online' && statusRaw !== 'offline') return null;

  const firstSeen = toEpochMs(record?.first_seen || record?.first_seen_utc || record?.dateadded);
  const lastSeen = toEpochMs(record?.last_online || record?.last_seen || record?.last_seen_utc || record?.first_seen || record?.first_seen_utc);

  const activityMs = lastSeen || firstSeen;
  if (activityMs && activityMs < cutoffMs) return null;

  const malwareFamily = cleanString(record?.malware || record?.malware_family || record?.family, 80);
  const tags = normalizeTags(record?.tags);

  return sanitizeRawThreat({
    id: `feodo:${ip}`,
    type: 'c2_server',
    source: 'feodo',
    indicator: ip,
    indicatorType: 'ip',
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: normalizeCountry(record?.country || record?.country_code),
    severity: statusRaw === 'online' ? inferFeodoSeverity(record, malwareFamily) : 'medium',
    malwareFamily,
    tags: normalizeTags(['botnet', 'c2', ...tags]),
    firstSeen,
    lastSeen,
  });
}

export async function fetchFeodoSource(limit: number, cutoffMs: number): Promise<SourceResult> {
  try {
    const response = await fetch(FEODO_URL, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, threats: [] };

    const payload = await response.json();
    const records: any[] = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = records
      .map((r) => parseFeodoRecord(r, cutoffMs))
      .filter((t): t is RawThreat => t !== null)
      .sort((a, b) => (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen))
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch {
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Source 2: URLhaus
// ========================================================================

function inferUrlhausType(record: any, tags: string[]): string {
  const threat = cleanString(record?.threat || record?.threat_type || '', 40).toLowerCase();
  const allTags = tags.join(' ');
  if (threat.includes('phish') || allTags.includes('phish')) return 'phishing';
  if (threat.includes('malware') || threat.includes('payload') || allTags.includes('malware')) return 'malware_host';
  return 'malicious_url';
}

function inferUrlhausSeverity(type: string, tags: string[]): string {
  if (type === 'phishing') return 'medium';
  if (tags.includes('ransomware') || tags.includes('botnet')) return 'critical';
  if (type === 'malware_host') return 'high';
  return 'medium';
}

function parseUrlhausRecord(record: any, cutoffMs: number): RawThreat | null {
  const rawUrl = cleanString(record?.url || record?.ioc || '', 1024);
  const statusRaw = cleanString(record?.url_status || record?.status || '', 30).toLowerCase();
  if (statusRaw && statusRaw !== 'online') return null;

  const tags = normalizeTags(record?.tags);

  let hostname = '';
  if (rawUrl) {
    try { hostname = cleanString(new URL(rawUrl).hostname, 255).toLowerCase(); } catch { /* ignore */ }
  }

  const recordIp = cleanString(record?.host || record?.ip_address || record?.ip, 80).toLowerCase();
  const ipCandidate = isIpAddress(recordIp) ? recordIp : (isIpAddress(hostname) ? hostname : '');

  const indicatorType = ipCandidate ? 'ip' : (hostname ? 'domain' : 'url');
  const indicator = ipCandidate || hostname || rawUrl;
  if (!indicator) return null;

  const firstSeen = toEpochMs(record?.dateadded || record?.firstseen || record?.first_seen);
  const lastSeen = toEpochMs(record?.last_online || record?.last_seen || record?.dateadded);

  const activityMs = lastSeen || firstSeen;
  if (activityMs && activityMs < cutoffMs) return null;

  const type = inferUrlhausType(record, tags);

  return sanitizeRawThreat({
    id: `urlhaus:${indicatorType}:${indicator}`,
    type,
    source: 'urlhaus',
    indicator,
    indicatorType,
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: normalizeCountry(record?.country || record?.country_code),
    severity: inferUrlhausSeverity(type, tags),
    malwareFamily: cleanString(record?.threat, 80),
    tags,
    firstSeen,
    lastSeen,
  });
}

export async function fetchUrlhausSource(limit: number, cutoffMs: number): Promise<SourceResult> {
  const authKey = cleanString(process.env.URLHAUS_AUTH_KEY || '', 200);
  if (!authKey) return { ok: false, threats: [] };

  try {
    const response = await fetch(URLHAUS_RECENT_URL(limit), {
      method: 'GET',
      headers: { Accept: 'application/json', 'Auth-Key': authKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, threats: [] };

    const payload = await response.json();
    const rows: any[] = Array.isArray(payload?.urls) ? payload.urls : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = rows
      .map((r) => parseUrlhausRecord(r, cutoffMs))
      .filter((t): t is RawThreat => t !== null)
      .sort((a, b) => (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen))
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch {
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Source 3: C2IntelFeeds (CSV)
// ========================================================================

function parseC2IntelCsvLine(line: string): RawThreat | null {
  if (!line || line.startsWith('#')) return null;
  const commaIdx = line.indexOf(',');
  if (commaIdx < 0) return null;

  const ip = cleanString(line.slice(0, commaIdx), 80).toLowerCase();
  if (!isIpAddress(ip)) return null;

  const description = cleanString(line.slice(commaIdx + 1), 200);
  const malwareFamily = description
    .replace(/^Possible\s+/i, '')
    .replace(/\s+C2\s+IP$/i, '')
    .trim() || 'Unknown';

  const tags = ['c2'];
  const descLower = description.toLowerCase();
  if (descLower.includes('cobaltstrike') || descLower.includes('cobalt strike')) tags.push('cobaltstrike');
  if (descLower.includes('metasploit')) tags.push('metasploit');
  if (descLower.includes('sliver')) tags.push('sliver');
  if (descLower.includes('brute ratel') || descLower.includes('bruteratel')) tags.push('bruteratel');

  const severity = /cobaltstrike|cobalt.strike|brute.?ratel/i.test(description) ? 'high' : 'medium';

  return sanitizeRawThreat({
    id: `c2intel:${ip}`,
    type: 'c2_server',
    source: 'c2intel',
    indicator: ip,
    indicatorType: 'ip',
    lat: null,
    lon: null,
    country: '',
    severity,
    malwareFamily,
    tags: normalizeTags(tags),
    firstSeen: 0,
    lastSeen: 0,
  });
}

export async function fetchC2IntelSource(limit: number): Promise<SourceResult> {
  try {
    const response = await fetch(C2INTEL_URL, {
      headers: { Accept: 'text/plain', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, threats: [] };

    const text = await response.text();
    const parsed = text.split('\n')
      .map((line) => parseC2IntelCsvLine(line))
      .filter((t): t is RawThreat => t !== null)
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch {
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Source 4: AlienVault OTX
// ========================================================================

export async function fetchOtxSource(limit: number, days: number): Promise<SourceResult> {
  const apiKey = cleanString(process.env.OTX_API_KEY || '', 200);
  if (!apiKey) return { ok: false, threats: [] };

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await fetch(
      `${OTX_INDICATORS_URL}${encodeURIComponent(since)}`,
      {
        headers: { Accept: 'application/json', 'X-OTX-API-KEY': apiKey, 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { ok: false, threats: [] };

    const payload = await response.json();
    const results: any[] = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);

    const parsed: RawThreat[] = [];
    for (const record of results) {
      const ip = cleanString(record?.indicator || record?.ip || '', 80).toLowerCase();
      if (!isIpAddress(ip)) continue;

      const title = cleanString(record?.title || record?.description || '', 200);
      const tags = normalizeTags(record?.tags || []);
      const severity = tags.some((t) => /ransomware|apt|c2|botnet/.test(t)) ? 'high' : 'medium';

      const threat = sanitizeRawThreat({
        id: `otx:${ip}`,
        type: tags.some((t) => /c2|botnet/.test(t)) ? 'c2_server' : 'malware_host',
        source: 'otx',
        indicator: ip,
        indicatorType: 'ip',
        lat: null,
        lon: null,
        country: '',
        severity,
        malwareFamily: title,
        tags,
        firstSeen: toEpochMs(record?.created),
        lastSeen: toEpochMs(record?.modified || record?.created),
      });
      if (threat) parsed.push(threat);
      if (parsed.length >= limit) break;
    }

    return { ok: true, threats: parsed };
  } catch {
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Source 5: AbuseIPDB
// ========================================================================

export async function fetchAbuseIpDbSource(limit: number): Promise<SourceResult> {
  const apiKey = cleanString(process.env.ABUSEIPDB_API_KEY || '', 200);
  if (!apiKey) return { ok: false, threats: [] };

  try {
    const url = `${ABUSEIPDB_BLACKLIST_URL}?confidenceMinimum=90&limit=${Math.min(limit, 500)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Key: apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, threats: [] };

    const payload = await response.json();
    const records: any[] = Array.isArray(payload?.data) ? payload.data : [];

    const parsed: RawThreat[] = [];
    for (const record of records) {
      const ip = cleanString(record?.ipAddress || record?.ip || '', 80).toLowerCase();
      if (!isIpAddress(ip)) continue;

      const score = toFiniteNumber(record?.abuseConfidenceScore) ?? 0;
      const severity = score >= 95 ? 'critical' : (score >= 80 ? 'high' : 'medium');

      const threat = sanitizeRawThreat({
        id: `abuseipdb:${ip}`,
        type: 'malware_host',
        source: 'abuseipdb',
        indicator: ip,
        indicatorType: 'ip',
        lat: toFiniteNumber(record?.latitude ?? record?.lat),
        lon: toFiniteNumber(record?.longitude ?? record?.lon),
        country: normalizeCountry(record?.countryCode || record?.country),
        severity,
        malwareFamily: '',
        tags: normalizeTags([`score:${score}`]),
        firstSeen: 0,
        lastSeen: toEpochMs(record?.lastReportedAt),
      });
      if (threat) parsed.push(threat);
      if (parsed.length >= limit) break;
    }

    return { ok: true, threats: parsed };
  } catch {
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Deduplication
// ========================================================================

export function dedupeThreats(threats: RawThreat[]): RawThreat[] {
  const deduped = new Map<string, RawThreat>();
  for (const threat of threats) {
    const key = `${threat.source}:${threat.indicatorType}:${threat.indicator}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, threat);
      continue;
    }

    const existingSeen = existing.lastSeen || existing.firstSeen;
    const candidateSeen = threat.lastSeen || threat.firstSeen;
    if (candidateSeen >= existingSeen) {
      deduped.set(key, {
        ...existing,
        ...threat,
        tags: normalizeTags([...existing.tags, ...threat.tags]),
      });
    }
  }
  return Array.from(deduped.values());
}

// ========================================================================
// RawThreat -> Proto CyberThreat mapping
// ========================================================================

export function toProtoCyberThreat(raw: RawThreat): CyberThreat {
  return {
    id: raw.id,
    type: THREAT_TYPE_MAP[raw.type] || 'CYBER_THREAT_TYPE_UNSPECIFIED',
    source: SOURCE_MAP[raw.source] || 'CYBER_THREAT_SOURCE_UNSPECIFIED',
    indicator: raw.indicator,
    indicatorType: INDICATOR_TYPE_MAP[raw.indicatorType] || 'CYBER_THREAT_INDICATOR_TYPE_UNSPECIFIED',
    location: hasValidCoordinates(raw.lat, raw.lon)
      ? { latitude: raw.lat!, longitude: raw.lon! }
      : undefined,
    country: raw.country,
    severity: SEVERITY_MAP[raw.severity] || 'CRITICALITY_LEVEL_UNSPECIFIED',
    malwareFamily: raw.malwareFamily,
    tags: raw.tags,
    firstSeenAt: raw.firstSeen,
    lastSeenAt: raw.lastSeen,
  };
}

