import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';
import { recordCacheTelemetry } from './_cache-telemetry.js';
import { createIpRateLimiter } from './_ip-rate-limit.js';

export const config = { runtime: 'edge' };

const BASE_CACHE_KEY = 'cyber-threats:v1';
const GEO_CACHE_KEY_PREFIX = 'cyber-threats:geoip:v1:';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

const CACHE_TTL_SECONDS = 10 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const STALE_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_TTL_SECONDS = 24 * 60 * 60;
const GEO_CACHE_TTL_MS = GEO_CACHE_TTL_SECONDS * 1000;

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;
const C2INTEL_URL = 'https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv';
const OTX_INDICATORS_URL = 'https://otx.alienvault.com/api/v1/indicators/export?type=IPv4&modified_since=';
const ABUSEIPDB_BLACKLIST_URL = 'https://api.abuseipdb.com/api/v2/blacklist';

const UPSTREAM_TIMEOUT_MS = 8000;
const GEO_MAX_UNRESOLVED_PER_RUN = 250;
const GEO_CONCURRENCY = 16;
const GEO_OVERALL_TIMEOUT_MS = 15_000;
const GEO_PER_IP_TIMEOUT_MS = 3000;

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;
const rateLimiter = createIpRateLimiter({
  limit: RATE_LIMIT,
  windowMs: RATE_WINDOW_MS,
  maxEntries: 8000,
});

const ALLOWED_TYPES = new Set(['c2_server', 'malware_host', 'phishing', 'malicious_url']);
const ALLOWED_SOURCES = new Set(['feodo', 'urlhaus', 'c2intel', 'otx', 'abuseipdb']);
const ALLOWED_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const ALLOWED_INDICATOR_TYPES = new Set(['ip', 'domain', 'url']);

const responseMemoryCache = new Map();
const staleFallbackCache = new Map();
const geoMemoryCache = new Map();

function clampInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getClientIp(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown_error');
}

function cleanString(value, maxLen = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidCoordinates(latValue, lonValue) {
  const lat = toFiniteNumber(latValue);
  const lon = toFiniteNumber(lonValue);
  if (lat === null || lon === null) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const raw = cleanString(String(value), 80);
  if (!raw) return null;

  const normalized = raw
    .replace(' UTC', 'Z')
    .replace(' GMT', 'Z')
    .replace(' +00:00', 'Z')
    .replace(' ', 'T');

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const fallback = new Date(normalized);
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();

  return null;
}

function isIPv4(value) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function isIPv6(value) {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}

function isIpAddress(value) {
  const candidate = cleanString(value, 80).toLowerCase();
  if (!candidate) return false;
  return isIPv4(candidate) || isIPv6(candidate);
}

function normalizeCountry(value) {
  const raw = cleanString(String(value ?? ''), 64);
  if (!raw) return undefined;
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

const COUNTRY_CENTROIDS = {
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

function getCountryCentroid(countryCode, seed = '') {
  if (!countryCode) return null;
  const code = countryCode.toUpperCase();
  const coords = COUNTRY_CENTROIDS[code];
  if (!coords) return null;
  // Deterministic jitter: hash the seed so the same input always yields the
  // same offset, preventing markers from "jumping" across requests.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  const jitterLat = ((h & 0xffff) / 0xffff - 0.5) * 2;
  const jitterLon = ((h >>> 16) / 0xffff - 0.5) * 2;
  return { lat: coords[0] + jitterLat, lon: coords[1] + jitterLon };
}

function normalizeTags(input, maxTags = 8) {
  const tags = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[;,|]/g)
      : [];

  const normalized = [];
  const seen = new Set();
  for (const tag of tags) {
    const clean = cleanString(String(tag ?? ''), 40).toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
    if (normalized.length >= maxTags) break;
  }
  return normalized;
}

function normalizeEnum(value, allowlist, fallback) {
  const normalized = cleanString(String(value ?? ''), 40).toLowerCase();
  if (allowlist.has(normalized)) return normalized;
  return fallback;
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function inferFeodoSeverity(record, malwareFamily) {
  const malware = cleanString(malwareFamily, 80).toLowerCase();
  const status = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();

  if (/emotet|qakbot|trickbot|dridex|ransom/i.test(malware)) return 'critical';
  if (status === 'online') return 'high';
  return 'medium';
}

function inferUrlhausType(record, tags) {
  const threat = cleanString(record?.threat || record?.threat_type || '', 40).toLowerCase();
  const allTags = tags.join(' ');

  if (threat.includes('phish') || allTags.includes('phish')) return 'phishing';
  if (threat.includes('malware') || threat.includes('payload') || allTags.includes('malware')) return 'malware_host';
  return 'malicious_url';
}

function inferUrlhausSeverity(type, tags) {
  if (type === 'phishing') return 'medium';
  if (tags.includes('ransomware') || tags.includes('botnet')) return 'critical';
  if (type === 'malware_host') return 'high';
  return 'medium';
}

function sanitizeThreat(threat) {
  const indicator = cleanString(threat?.indicator, 255);
  if (!indicator) return null;

  const indicatorType = normalizeEnum(threat?.indicatorType, ALLOWED_INDICATOR_TYPES, 'ip');
  if (indicatorType === 'ip' && !isIpAddress(indicator)) return null;

  const source = normalizeEnum(threat?.source, ALLOWED_SOURCES, 'feodo');
  const type = normalizeEnum(threat?.type, ALLOWED_TYPES, source === 'feodo' ? 'c2_server' : 'malicious_url');
  const severity = normalizeEnum(threat?.severity, ALLOWED_SEVERITIES, 'medium');

  const firstSeen = toIsoDate(threat?.firstSeen);
  const lastSeen = toIsoDate(threat?.lastSeen);

  const rawLat = toFiniteNumber(threat?.lat);
  const rawLon = toFiniteNumber(threat?.lon);
  const lat = hasValidCoordinates(rawLat, rawLon) ? rawLat : null;
  const lon = hasValidCoordinates(rawLat, rawLon) ? rawLon : null;

  return {
    id: cleanString(threat?.id, 255) || `${source}:${indicatorType}:${indicator}`,
    type,
    source,
    indicator,
    indicatorType,
    lat,
    lon,
    country: normalizeCountry(threat?.country),
    severity,
    malwareFamily: cleanString(threat?.malwareFamily, 80) || undefined,
    tags: normalizeTags(threat?.tags),
    firstSeen: firstSeen || undefined,
    lastSeen: lastSeen || undefined,
  };
}

function parseFeodoRecord(record, cutoffMs) {
  const ip = cleanString(
    record?.ip_address
      || record?.dst_ip
      || record?.ip
      || record?.ioc
      || record?.host,
    80,
  ).toLowerCase();

  if (!isIpAddress(ip)) return null;

  const statusRaw = cleanString(record?.status || record?.c2_status || '', 30).toLowerCase();
  // Accept both online and recently-offline (still threat-relevant)
  if (statusRaw && statusRaw !== 'online' && statusRaw !== 'offline') return null;

  const firstSeen = toIsoDate(record?.first_seen || record?.first_seen_utc || record?.dateadded);
  const lastSeen = toIsoDate(record?.last_online || record?.last_seen || record?.last_seen_utc || record?.first_seen || record?.first_seen_utc);

  const activityIso = lastSeen || firstSeen;
  if (activityIso) {
    const activityMs = Date.parse(activityIso);
    if (Number.isFinite(activityMs) && activityMs < cutoffMs) return null;
  }

  const malwareFamily = cleanString(record?.malware || record?.malware_family || record?.family, 80);
  const tags = normalizeTags(record?.tags);

  const sanitized = sanitizeThreat({
    id: `feodo:${ip}`,
    type: 'c2_server',
    source: 'feodo',
    indicator: ip,
    indicatorType: 'ip',
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: record?.country || record?.country_code,
    severity: statusRaw === 'online' ? inferFeodoSeverity(record, malwareFamily) : 'medium',
    malwareFamily,
    tags: ['botnet', 'c2', ...tags],
    firstSeen,
    lastSeen,
  });

  return sanitized;
}

function parseUrlhausRecord(record, cutoffMs) {
  const rawUrl = cleanString(record?.url || record?.ioc || '', 1024);
  const statusRaw = cleanString(record?.url_status || record?.status || '', 30).toLowerCase();
  if (statusRaw && statusRaw !== 'online') return null;

  const tags = normalizeTags(record?.tags);

  let hostname = '';
  if (rawUrl) {
    try {
      hostname = cleanString(new URL(rawUrl).hostname, 255).toLowerCase();
    } catch {
      hostname = '';
    }
  }

  const recordIp = cleanString(record?.host || record?.ip_address || record?.ip, 80).toLowerCase();
  const ipCandidate = isIpAddress(recordIp)
    ? recordIp
    : (isIpAddress(hostname) ? hostname : '');

  const indicatorType = ipCandidate
    ? 'ip'
    : (hostname ? 'domain' : 'url');

  const indicator = ipCandidate || hostname || rawUrl;
  if (!indicator) return null;

  const firstSeen = toIsoDate(record?.dateadded || record?.firstseen || record?.first_seen);
  const lastSeen = toIsoDate(record?.last_online || record?.last_seen || record?.dateadded);

  const activityIso = lastSeen || firstSeen;
  if (activityIso) {
    const activityMs = Date.parse(activityIso);
    if (Number.isFinite(activityMs) && activityMs < cutoffMs) return null;
  }

  const type = inferUrlhausType(record, tags);

  return sanitizeThreat({
    id: `urlhaus:${indicatorType}:${indicator}`,
    type,
    source: 'urlhaus',
    indicator,
    indicatorType,
    lat: toFiniteNumber(record?.latitude ?? record?.lat),
    lon: toFiniteNumber(record?.longitude ?? record?.lon),
    country: record?.country || record?.country_code,
    severity: inferUrlhausSeverity(type, tags),
    malwareFamily: record?.threat,
    tags,
    firstSeen,
    lastSeen,
  });
}

function parseC2IntelCsvLine(line) {
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

  return sanitizeThreat({
    id: `c2intel:${ip}`,
    type: 'c2_server',
    source: 'c2intel',
    indicator: ip,
    indicatorType: 'ip',
    lat: null,
    lon: null,
    country: undefined,
    severity,
    malwareFamily,
    tags: normalizeTags(tags),
    firstSeen: undefined,
    lastSeen: undefined,
  });
}

export function __testParseFeodoRecords(records, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const safeRecords = Array.isArray(records) ? records : [];
  return safeRecords
    .map((record) => parseFeodoRecord(record, cutoffMs))
    .filter(Boolean);
}

export function __testParseUrlhausRecords(records, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const safeRecords = Array.isArray(records) ? records : [];
  return safeRecords
    .map((record) => parseUrlhausRecord(record, cutoffMs))
    .filter(Boolean);
}

export function __testDedupeThreats(threats) {
  const deduped = new Map();
  for (const threat of Array.isArray(threats) ? threats : []) {
    const sanitized = sanitizeThreat(threat);
    if (!sanitized) continue;
    const key = `${sanitized.source}:${sanitized.indicatorType}:${sanitized.indicator}`;
    if (!deduped.has(key)) {
      deduped.set(key, sanitized);
      continue;
    }

    const existing = deduped.get(key);
    const existingSeen = Date.parse(existing.lastSeen || existing.firstSeen || '1970-01-01T00:00:00.000Z');
    const candidateSeen = Date.parse(sanitized.lastSeen || sanitized.firstSeen || '1970-01-01T00:00:00.000Z');

    if (candidateSeen >= existingSeen) {
      deduped.set(key, {
        ...existing,
        ...sanitized,
        tags: normalizeTags([...(existing.tags || []), ...(sanitized.tags || [])]),
      });
    }
  }
  return Array.from(deduped.values());
}

function hasFreshResponseCache(cacheKey) {
  const entry = responseMemoryCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    return null;
  }

  return entry.data;
}

function getStaleResponseCache(cacheKey) {
  const entry = staleFallbackCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > STALE_FALLBACK_MAX_AGE_MS) {
    staleFallbackCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setResponseCaches(cacheKey, data) {
  const entry = { data, timestamp: Date.now() };
  responseMemoryCache.set(cacheKey, entry);
  staleFallbackCache.set(cacheKey, entry);
}

function getGeoMemory(ip) {
  const entry = geoMemoryCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > GEO_CACHE_TTL_MS) {
    geoMemoryCache.delete(ip);
    return null;
  }
  return entry.value;
}

function setGeoMemory(ip, value) {
  geoMemoryCache.set(ip, { value, timestamp: Date.now() });
}

function isValidGeo(value) {
  if (!value || typeof value !== 'object') return false;
  return hasValidCoordinates(value.lat, value.lon);
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getGeoFromCache(ip) {
  const fromMemory = getGeoMemory(ip);
  if (isValidGeo(fromMemory)) return fromMemory;

  const cacheKey = `${GEO_CACHE_KEY_PREFIX}${ip}`;
  const fromRedis = await getCachedJson(cacheKey);
  if (isValidGeo(fromRedis)) {
    setGeoMemory(ip, fromRedis);
    return fromRedis;
  }

  return null;
}

async function setGeoCache(ip, geo) {
  setGeoMemory(ip, geo);
  const cacheKey = `${GEO_CACHE_KEY_PREFIX}${ip}`;
  void setCachedJson(cacheKey, geo, GEO_CACHE_TTL_SECONDS);
}

async function fetchGeoIp(ip) {
  // Primary: ipinfo.io (HTTPS, works from Edge runtime & Node.js, 50K/mo free)
  try {
    const primary = await fetchJsonWithTimeout(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {}, GEO_PER_IP_TIMEOUT_MS);
    if (primary.ok) {
      const data = await primary.json();
      const locParts = (data?.loc || '').split(',');
      const lat = toFiniteNumber(locParts[0]);
      const lon = toFiniteNumber(locParts[1]);
      if (hasValidCoordinates(lat, lon)) {
        return {
          lat,
          lon,
          country: normalizeCountry(data?.country),
        };
      }
    }
  } catch { /* fall through to backup */ }

  // Fallback: freeipapi.com (HTTPS, works from Edge runtime, 60/min)
  try {
    const fallback = await fetchJsonWithTimeout(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, {}, GEO_PER_IP_TIMEOUT_MS);
    if (!fallback.ok) return null;

    const data = await fallback.json();
    const lat = toFiniteNumber(data?.latitude);
    const lon = toFiniteNumber(data?.longitude);
    if (!hasValidCoordinates(lat, lon)) return null;

    return {
      lat,
      lon,
      country: normalizeCountry(data?.countryCode || data?.countryName),
    };
  } catch {
    return null;
  }
}

async function geolocateIp(ip) {
  const cached = await getGeoFromCache(ip);
  if (cached) return cached;

  try {
    const geo = await fetchGeoIp(ip);
    if (!geo) return null;
    await setGeoCache(ip, geo);
    return geo;
  } catch {
    return null;
  }
}

async function hydrateThreatCoordinates(threats) {
  const unresolvedIps = [];
  const seenIps = new Set();

  for (const threat of threats) {
    const hasCoords = hasValidCoordinates(threat.lat, threat.lon);
    if (hasCoords) continue;
    if (threat.indicatorType !== 'ip') continue;

    const ip = cleanString(threat.indicator, 80).toLowerCase();
    if (!isIpAddress(ip) || seenIps.has(ip)) continue;
    seenIps.add(ip);
    unresolvedIps.push(ip);
  }

  const cappedIps = unresolvedIps.slice(0, GEO_MAX_UNRESOLVED_PER_RUN);
  const resolvedByIp = new Map();

  const queue = [...cappedIps];
  const workerCount = Math.min(GEO_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const ip = queue.shift();
      if (!ip) continue;
      const geo = await geolocateIp(ip);
      if (geo) {
        resolvedByIp.set(ip, geo);
      }
    }
  });

  await Promise.race([
    Promise.all(workers),
    new Promise((resolve) => setTimeout(resolve, GEO_OVERALL_TIMEOUT_MS)),
  ]);

  return threats.map((threat) => {
    const hasCoords = hasValidCoordinates(threat.lat, threat.lon);
    if (hasCoords || threat.indicatorType !== 'ip') return threat;

    const lookup = resolvedByIp.get(cleanString(threat.indicator, 80).toLowerCase());
    if (lookup) {
      return {
        ...threat,
        lat: lookup.lat,
        lon: lookup.lon,
        country: threat.country || lookup.country,
      };
    }

    const centroid = getCountryCentroid(threat.country, threat.indicator || '');
    if (centroid) {
      return { ...threat, lat: centroid.lat, lon: centroid.lon };
    }

    return threat;
  });
}

async function fetchFeodoSource(limit, cutoffMs) {
  try {
    const response = await fetchJsonWithTimeout(FEODO_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        ok: false,
        threats: [],
        reason: `feodo_http_${response.status}`,
      };
    }

    const payload = await response.json();
    const records = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = records
      .map((record) => parseFeodoRecord(record, cutoffMs))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch (error) {
    return {
      ok: false,
      threats: [],
      reason: `feodo_error:${cleanString(toErrorMessage(error), 120)}`,
    };
  }
}

async function fetchUrlhausSource(limit, cutoffMs) {
  const authKey = cleanString(process.env.URLHAUS_AUTH_KEY || '', 200);
  if (!authKey) {
    return {
      ok: false,
      threats: [],
      reason: 'missing_auth_key',
      enabled: false,
    };
  }

  try {
    const response = await fetchJsonWithTimeout(URLHAUS_RECENT_URL(limit), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Auth-Key': authKey,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        threats: [],
        reason: `urlhaus_http_${response.status}`,
        enabled: true,
      };
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.urls)
      ? payload.urls
      : (Array.isArray(payload?.data) ? payload.data : []);

    const parsed = rows
      .map((record) => parseUrlhausRecord(record, cutoffMs))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    return {
      ok: true,
      threats: parsed,
      enabled: true,
    };
  } catch (error) {
    return {
      ok: false,
      threats: [],
      reason: `urlhaus_error:${cleanString(toErrorMessage(error), 120)}`,
      enabled: true,
    };
  }
}

async function fetchOtxSource(limit, days) {
  const apiKey = cleanString(process.env.OTX_API_KEY || '', 200);
  if (!apiKey) {
    return { ok: false, threats: [], reason: 'missing_api_key', enabled: false };
  }

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await fetchJsonWithTimeout(
      `${OTX_INDICATORS_URL}${encodeURIComponent(since)}`,
      {
        headers: {
          Accept: 'application/json',
          'X-OTX-API-KEY': apiKey,
        },
      },
    );

    if (!response.ok) {
      return { ok: false, threats: [], reason: `otx_http_${response.status}`, enabled: true };
    }

    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);

    const parsed = [];
    for (const record of results) {
      const ip = cleanString(record?.indicator || record?.ip || '', 80).toLowerCase();
      if (!isIpAddress(ip)) continue;

      const title = cleanString(record?.title || record?.description || '', 200);
      const tags = normalizeTags(record?.tags || []);

      const severity = tags.some((t) => /ransomware|apt|c2|botnet/.test(t)) ? 'high' : 'medium';

      const sanitized = sanitizeThreat({
        id: `otx:${ip}`,
        type: tags.some((t) => /c2|botnet/.test(t)) ? 'c2_server' : 'malware_host',
        source: 'otx',
        indicator: ip,
        indicatorType: 'ip',
        lat: null,
        lon: null,
        country: undefined,
        severity,
        malwareFamily: title || undefined,
        tags,
        firstSeen: toIsoDate(record?.created),
        lastSeen: toIsoDate(record?.modified || record?.created),
      });
      if (sanitized) parsed.push(sanitized);
      if (parsed.length >= limit) break;
    }

    return { ok: true, threats: parsed, enabled: true };
  } catch (error) {
    return { ok: false, threats: [], reason: `otx_error:${cleanString(toErrorMessage(error), 120)}`, enabled: true };
  }
}

async function fetchAbuseIpDbSource(limit) {
  const apiKey = cleanString(process.env.ABUSEIPDB_API_KEY || '', 200);
  if (!apiKey) {
    return { ok: false, threats: [], reason: 'missing_api_key', enabled: false };
  }

  try {
    const url = `${ABUSEIPDB_BLACKLIST_URL}?confidenceMinimum=90&limit=${Math.min(limit, 500)}`;
    const response = await fetchJsonWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        Key: apiKey,
      },
    });

    if (!response.ok) {
      return { ok: false, threats: [], reason: `abuseipdb_http_${response.status}`, enabled: true };
    }

    const payload = await response.json();
    const records = Array.isArray(payload?.data) ? payload.data : [];

    const parsed = [];
    for (const record of records) {
      const ip = cleanString(record?.ipAddress || record?.ip || '', 80).toLowerCase();
      if (!isIpAddress(ip)) continue;

      const score = toFiniteNumber(record?.abuseConfidenceScore) ?? 0;
      const severity = score >= 95 ? 'critical' : (score >= 80 ? 'high' : 'medium');

      const sanitized = sanitizeThreat({
        id: `abuseipdb:${ip}`,
        type: 'malware_host',
        source: 'abuseipdb',
        indicator: ip,
        indicatorType: 'ip',
        lat: toFiniteNumber(record?.latitude ?? record?.lat),
        lon: toFiniteNumber(record?.longitude ?? record?.lon),
        country: record?.countryCode || record?.country,
        severity,
        malwareFamily: undefined,
        tags: normalizeTags([`score:${score}`]),
        firstSeen: undefined,
        lastSeen: toIsoDate(record?.lastReportedAt),
      });
      if (sanitized) parsed.push(sanitized);
      if (parsed.length >= limit) break;
    }

    return { ok: true, threats: parsed, enabled: true };
  } catch (error) {
    return { ok: false, threats: [], reason: `abuseipdb_error:${cleanString(toErrorMessage(error), 120)}`, enabled: true };
  }
}

async function fetchC2IntelSource(limit) {
  try {
    const response = await fetchJsonWithTimeout(C2INTEL_URL, {
      headers: { Accept: 'text/plain' },
    });

    if (!response.ok) {
      return {
        ok: false,
        threats: [],
        reason: `c2intel_http_${response.status}`,
      };
    }

    const text = await response.text();
    const lines = text.split('\n');

    const parsed = lines
      .map((line) => parseC2IntelCsvLine(line))
      .filter(Boolean)
      .slice(0, limit);

    return { ok: true, threats: parsed };
  } catch (error) {
    return {
      ok: false,
      threats: [],
      reason: `c2intel_error:${cleanString(toErrorMessage(error), 120)}`,
    };
  }
}

export function __resetCyberThreatsState() {
  responseMemoryCache.clear();
  staleFallbackCache.clear();
  geoMemoryCache.clear();
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    if (isDisallowedOrigin(req)) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed', data: [] }, {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (isDisallowedOrigin(req)) {
    return Response.json({ error: 'Origin not allowed', data: [] }, {
      status: 403,
      headers: corsHeaders,
    });
  }

  const ip = getClientIp(req);
  if (!rateLimiter.check(ip)) {
    return Response.json({ error: 'Rate limited', data: [] }, {
      status: 429,
      headers: {
        ...corsHeaders,
        'Retry-After': '60',
      },
    });
  }

  const requestUrl = new URL(req.url);
  const limit = clampInt(requestUrl.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = clampInt(requestUrl.searchParams.get('days'), DEFAULT_DAYS, 1, MAX_DAYS);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const cacheKey = `${BASE_CACHE_KEY}:limit=${limit}:days=${days}`;

  const redisCached = await getCachedJson(cacheKey);
  if (redisCached && typeof redisCached === 'object' && Array.isArray(redisCached.data)) {
    setResponseCaches(cacheKey, redisCached);
    recordCacheTelemetry('/api/cyber-threats', 'REDIS-HIT');
    return Response.json(redisCached, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=300',
        'X-Cache': 'REDIS-HIT',
      },
    });
  }

  const memoryCached = hasFreshResponseCache(cacheKey);
  if (memoryCached && Array.isArray(memoryCached.data)) {
    recordCacheTelemetry('/api/cyber-threats', 'MEMORY-HIT');
    return Response.json(memoryCached, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=300',
        'X-Cache': 'MEMORY-HIT',
      },
    });
  }

  try {
    const [feodo, urlhaus, c2intel, otx, abuseipdb] = await Promise.all([
      fetchFeodoSource(limit, cutoffMs),
      fetchUrlhausSource(limit, cutoffMs),
      fetchC2IntelSource(limit),
      fetchOtxSource(limit, days),
      fetchAbuseIpDbSource(limit),
    ]);

    const anySuceeded = feodo.ok || urlhaus.ok || c2intel.ok || otx.ok || abuseipdb.ok;
    if (!anySuceeded) {
      throw new Error('all_sources_failed');
    }

    const combined = __testDedupeThreats([
      ...feodo.threats,
      ...urlhaus.threats,
      ...c2intel.threats,
      ...otx.threats,
      ...abuseipdb.threats,
    ]);

    const withGeo = await hydrateThreatCoordinates(combined);

    const mapData = withGeo
      .filter((threat) => hasValidCoordinates(threat.lat, threat.lon))
      .map((threat) => ({
        ...threat,
        lat: Number(threat.lat),
        lon: Number(threat.lon),
      }))
      .sort((a, b) => {
        const bySeverity = severityRank(b.severity) - severityRank(a.severity);
        if (bySeverity !== 0) return bySeverity;
        const aTime = Date.parse(a.lastSeen || a.firstSeen || '1970-01-01T00:00:00.000Z');
        const bTime = Date.parse(b.lastSeen || b.firstSeen || '1970-01-01T00:00:00.000Z');
        return bTime - aTime;
      })
      .slice(0, limit);

    const enabledButFailed = (src) => src.enabled !== false && !src.ok;
    const partial = !feodo.ok || enabledButFailed(urlhaus) || !c2intel.ok
      || enabledButFailed(otx) || enabledButFailed(abuseipdb);

    const sourceStatus = (src) => ({
      ok: src.ok,
      count: src.threats.length,
      ...(src.reason ? { reason: src.reason } : {}),
    });

    const result = {
      success: true,
      count: mapData.length,
      partial,
      sources: {
        feodo: sourceStatus(feodo),
        urlhaus: sourceStatus(urlhaus),
        c2intel: sourceStatus(c2intel),
        otx: sourceStatus(otx),
        abuseipdb: sourceStatus(abuseipdb),
      },
      data: mapData,
      cachedAt: new Date().toISOString(),
    };

    setResponseCaches(cacheKey, result);
    void setCachedJson(cacheKey, result, CACHE_TTL_SECONDS);
    recordCacheTelemetry('/api/cyber-threats', 'MISS');

    return Response.json(result, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=300',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    const stale = getStaleResponseCache(cacheKey);
    if (stale && Array.isArray(stale.data)) {
      recordCacheTelemetry('/api/cyber-threats', 'STALE');
      return Response.json(stale, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=120',
          'X-Cache': 'STALE',
        },
      });
    }

    recordCacheTelemetry('/api/cyber-threats', 'ERROR');
    return Response.json({
      error: `Fetch failed: ${toErrorMessage(error)}`,
      data: [],
    }, {
      status: 502,
      headers: corsHeaders,
    });
  }
}
