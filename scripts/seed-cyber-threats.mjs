#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, verifySeedKey, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const ABUSEIPDB_RATE_KEY = 'rate:abuseipdb:last-call';
const ABUSEIPDB_CACHE_KEY = 'cache:abuseipdb:threats';
const ABUSEIPDB_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h — keeps daily calls under 100/day limit

const CANONICAL_KEY = 'cyber:threats:v2';
const BOOTSTRAP_KEY = 'cyber:threats-bootstrap:v2';
const CACHE_TTL = 10800; // 3h — survives 1 missed 2h cron cycle

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;
const C2INTEL_URL = 'https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv';
const OTX_INDICATORS_URL = 'https://otx.alienvault.com/api/v1/indicators/export?type=IPv4&modified_since=';
const ABUSEIPDB_BLACKLIST_URL = 'https://api.abuseipdb.com/api/v2/blacklist';

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_LIMIT = 1000;
const DEFAULT_DAYS = 14;
const MAX_CACHED_THREATS = 2000;
const GEO_MAX_UNRESOLVED = 200;
const GEO_CONCURRENCY = 12;
const GEO_OVERALL_TIMEOUT_MS = 15_000;
const GEO_PER_IP_TIMEOUT_MS = 2000;

const THREAT_TYPE_MAP = {
  c2_server: 'CYBER_THREAT_TYPE_C2_SERVER',
  malware_host: 'CYBER_THREAT_TYPE_MALWARE_HOST',
  phishing: 'CYBER_THREAT_TYPE_PHISHING',
  malicious_url: 'CYBER_THREAT_TYPE_MALICIOUS_URL',
};

const SOURCE_MAP = {
  feodo: 'CYBER_THREAT_SOURCE_FEODO',
  urlhaus: 'CYBER_THREAT_SOURCE_URLHAUS',
  c2intel: 'CYBER_THREAT_SOURCE_C2INTEL',
  otx: 'CYBER_THREAT_SOURCE_OTX',
  abuseipdb: 'CYBER_THREAT_SOURCE_ABUSEIPDB',
};

const INDICATOR_TYPE_MAP = {
  ip: 'CYBER_THREAT_INDICATOR_TYPE_IP',
  domain: 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN',
  url: 'CYBER_THREAT_INDICATOR_TYPE_URL',
};

const SEVERITY_MAP = {
  low: 'CRITICALITY_LEVEL_LOW',
  medium: 'CRITICALITY_LEVEL_MEDIUM',
  high: 'CRITICALITY_LEVEL_HIGH',
  critical: 'CRITICALITY_LEVEL_CRITICAL',
};

const SEVERITY_RANK = {
  CRITICALITY_LEVEL_CRITICAL: 4,
  CRITICALITY_LEVEL_HIGH: 3,
  CRITICALITY_LEVEL_MEDIUM: 2,
  CRITICALITY_LEVEL_LOW: 1,
  CRITICALITY_LEVEL_UNSPECIFIED: 0,
};

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

// ========================================================================
// Helpers
// ========================================================================

function clean(value, maxLen = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function toNum(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

function validCoords(lat, lon) {
  return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isIPv4(v) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return false;
  return v.split('.').map(Number).every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function isIPv6(v) { return /^[0-9a-f:]+$/i.test(v) && v.includes(':'); }

function isIp(v) {
  const c = clean(v, 80).toLowerCase();
  return c && (isIPv4(c) || isIPv6(c));
}

function normCountry(v) {
  const r = clean(String(v ?? ''), 64);
  if (!r) return '';
  return /^[a-z]{2}$/i.test(r) ? r.toUpperCase() : r;
}

function toEpochMs(v) {
  if (!v) return 0;
  const raw = clean(String(v), 80);
  if (!raw) return 0;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const norm = raw.replace(' UTC', 'Z').replace(' GMT', 'Z').replace(' +00:00', 'Z').replace(' ', 'T');
  const d2 = new Date(norm);
  return Number.isNaN(d2.getTime()) ? 0 : d2.getTime();
}

function normTags(input, max = 8) {
  const tags = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[;,|]/g) : [];
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    const c = clean(String(t ?? ''), 40).toLowerCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
  return h;
}

function countryCentroid(cc, seed) {
  if (!cc) return null;
  const coords = COUNTRY_CENTROIDS[cc.toUpperCase()];
  if (!coords) return null;
  const k = seed || cc;
  const latOff = (((djb2(k) & 0xffff) / 0xffff) - 0.5) * 2;
  const lonOff = (((djb2(k + ':lon') & 0xffff) / 0xffff) - 0.5) * 2;
  return { lat: coords[0] + latOff, lon: coords[1] + lonOff };
}

function sanitize(t) {
  const indicator = clean(t.indicator, 255);
  if (!indicator) return null;
  if ((t.indicatorType || 'ip') === 'ip' && !isIp(indicator)) return null;
  return {
    id: clean(t.id, 255) || `${t.source || 'feodo'}:${t.indicatorType || 'ip'}:${indicator}`,
    type: t.type || 'malicious_url',
    source: t.source || 'feodo',
    indicator,
    indicatorType: t.indicatorType || 'ip',
    lat: t.lat ?? null,
    lon: t.lon ?? null,
    country: t.country || '',
    severity: t.severity || 'medium',
    malwareFamily: clean(t.malwareFamily, 80),
    tags: t.tags || [],
    firstSeen: t.firstSeen || 0,
    lastSeen: t.lastSeen || 0,
  };
}

// ========================================================================
// GeoIP hydration
// ========================================================================

async function fetchGeoIp(ip, signal) {
  try {
    const resp = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: signal || AbortSignal.timeout(GEO_PER_IP_TIMEOUT_MS),
    });
    if (resp.ok) {
      const d = await resp.json();
      const parts = (d.loc || '').split(',');
      const lat = toNum(parts[0]);
      const lon = toNum(parts[1]);
      if (validCoords(lat, lon)) return { lat, lon, country: normCountry(d.country) };
    }
  } catch { /* fall through */ }
  if (signal?.aborted) return null;
  try {
    const resp = await fetch(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: signal || AbortSignal.timeout(GEO_PER_IP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const lat = toNum(d.latitude);
    const lon = toNum(d.longitude);
    if (!validCoords(lat, lon)) return null;
    return { lat, lon, country: normCountry(d.countryCode || d.countryName) };
  } catch { return null; }
}

async function hydrateCoordinates(threats) {
  const unresolvedIps = [];
  const seen = new Set();
  for (const t of threats) {
    if (validCoords(t.lat, t.lon)) continue;
    if (t.indicatorType !== 'ip') continue;
    const ip = clean(t.indicator, 80).toLowerCase();
    if (!isIp(ip) || seen.has(ip)) continue;
    seen.add(ip);
    unresolvedIps.push(ip);
  }

  const capped = unresolvedIps.slice(0, GEO_MAX_UNRESOLVED);
  const resolved = new Map();
  const controller = new AbortController();
  if (typeof controller.signal.setMaxListeners === 'function') {
    controller.signal.setMaxListeners(capped.length * 2 + 20);
  }
  const timeout = setTimeout(() => controller.abort(), GEO_OVERALL_TIMEOUT_MS);

  const queue = [...capped];
  const workerCount = Math.min(GEO_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0 && !controller.signal.aborted) {
      const ip = queue.shift();
      if (!ip) continue;
      const geo = await fetchGeoIp(ip, controller.signal);
      if (geo) resolved.set(ip, geo);
    }
  });

  try { await Promise.all(workers); } catch { /* aborted */ }
  clearTimeout(timeout);

  console.log(`  GeoIP: resolved ${resolved.size}/${capped.length} IPs`);

  return threats.map((t) => {
    if (validCoords(t.lat, t.lon)) return t;
    if (t.indicatorType !== 'ip') return t;
    const lookup = resolved.get(clean(t.indicator, 80).toLowerCase());
    if (lookup) return { ...t, lat: lookup.lat, lon: lookup.lon, country: t.country || lookup.country };
    const cent = countryCentroid(t.country, t.indicator);
    if (cent) return { ...t, lat: cent.lat, lon: cent.lon };
    return t;
  });
}

// ========================================================================
// Source fetchers
// ========================================================================

async function fetchFeodo(cutoffMs) {
  try {
    const resp = await fetch(FEODO_URL, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, threats: [] };
    const payload = await resp.json();
    const records = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    const threats = [];
    for (const r of records) {
      const ip = clean(r?.ip_address || r?.dst_ip || r?.ip || r?.ioc || r?.host, 80).toLowerCase();
      if (!isIp(ip)) continue;
      const status = clean(r?.status || r?.c2_status || '', 30).toLowerCase();
      if (status && status !== 'online' && status !== 'offline') continue;
      const firstSeen = toEpochMs(r?.first_seen || r?.first_seen_utc || r?.dateadded);
      const lastSeen = toEpochMs(r?.last_online || r?.last_seen || r?.last_seen_utc || r?.first_seen || r?.first_seen_utc);
      if ((lastSeen || firstSeen) && (lastSeen || firstSeen) < cutoffMs) continue;
      const mf = clean(r?.malware || r?.malware_family || r?.family, 80);
      const sev = status === 'online' && /emotet|qakbot|trickbot|dridex|ransom/i.test(mf) ? 'critical'
        : status === 'online' ? 'high' : 'medium';
      const t = sanitize({
        id: `feodo:${ip}`, type: 'c2_server', source: 'feodo', indicator: ip, indicatorType: 'ip',
        lat: toNum(r?.latitude ?? r?.lat), lon: toNum(r?.longitude ?? r?.lon),
        country: normCountry(r?.country || r?.country_code), severity: sev, malwareFamily: mf,
        tags: normTags(['botnet', 'c2', ...(normTags(r?.tags))]), firstSeen, lastSeen,
      });
      if (t) threats.push(t);
      if (threats.length >= MAX_LIMIT) break;
    }
    console.log(`  Feodo: ${threats.length} threats`);
    return { ok: true, threats };
  } catch (e) {
    console.warn(`  Feodo: failed — ${e.message}`);
    return { ok: false, threats: [] };
  }
}

async function fetchUrlhaus(cutoffMs) {
  const authKey = clean(process.env.URLHAUS_AUTH_KEY || '', 200);
  if (!authKey) { console.log('  URLhaus: skipped (no URLHAUS_AUTH_KEY)'); return { ok: false, threats: [] }; }
  try {
    const resp = await fetch(URLHAUS_RECENT_URL(MAX_LIMIT), {
      method: 'GET',
      headers: { Accept: 'application/json', 'Auth-Key': authKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, threats: [] };
    const payload = await resp.json();
    const rows = Array.isArray(payload?.urls) ? payload.urls : (Array.isArray(payload?.data) ? payload.data : []);
    const threats = [];
    for (const r of rows) {
      const rawUrl = clean(r?.url || r?.ioc || '', 1024);
      const status = clean(r?.url_status || r?.status || '', 30).toLowerCase();
      if (status && status !== 'online') continue;
      const tags = normTags(r?.tags);
      let hostname = '';
      if (rawUrl) { try { hostname = clean(new URL(rawUrl).hostname, 255).toLowerCase(); } catch {} }
      const recordIp = clean(r?.host || r?.ip_address || r?.ip, 80).toLowerCase();
      const ipCand = isIp(recordIp) ? recordIp : (isIp(hostname) ? hostname : '');
      const indType = ipCand ? 'ip' : (hostname ? 'domain' : 'url');
      const indicator = ipCand || hostname || rawUrl;
      if (!indicator) continue;
      const firstSeen = toEpochMs(r?.dateadded || r?.firstseen || r?.first_seen);
      const lastSeen = toEpochMs(r?.last_online || r?.last_seen || r?.dateadded);
      if ((lastSeen || firstSeen) && (lastSeen || firstSeen) < cutoffMs) continue;
      const threat = clean(r?.threat || r?.threat_type || '', 40).toLowerCase();
      const allTags = tags.join(' ');
      const type = threat.includes('phish') || allTags.includes('phish') ? 'phishing'
        : threat.includes('malware') || threat.includes('payload') || allTags.includes('malware') ? 'malware_host'
        : 'malicious_url';
      const sev = type === 'phishing' ? 'medium'
        : tags.includes('ransomware') || tags.includes('botnet') ? 'critical'
        : type === 'malware_host' ? 'high' : 'medium';
      const t = sanitize({
        id: `urlhaus:${indType}:${indicator}`, type, source: 'urlhaus', indicator, indicatorType: indType,
        lat: toNum(r?.latitude ?? r?.lat), lon: toNum(r?.longitude ?? r?.lon),
        country: normCountry(r?.country || r?.country_code), severity: sev,
        malwareFamily: clean(r?.threat, 80), tags, firstSeen, lastSeen,
      });
      if (t) threats.push(t);
      if (threats.length >= MAX_LIMIT) break;
    }
    console.log(`  URLhaus: ${threats.length} threats`);
    return { ok: true, threats };
  } catch (e) {
    console.warn(`  URLhaus: failed — ${e.message}`);
    return { ok: false, threats: [] };
  }
}

async function fetchC2Intel() {
  try {
    const resp = await fetch(C2INTEL_URL, {
      headers: { Accept: 'text/plain', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, threats: [] };
    const text = await resp.text();
    const threats = [];
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const ci = line.indexOf(',');
      if (ci < 0) continue;
      const ip = clean(line.slice(0, ci), 80).toLowerCase();
      if (!isIp(ip)) continue;
      const desc = clean(line.slice(ci + 1), 200);
      const mf = desc.replace(/^Possible\s+/i, '').replace(/\s+C2\s+IP$/i, '').trim() || 'Unknown';
      const tags = ['c2'];
      const dl = desc.toLowerCase();
      if (dl.includes('cobaltstrike') || dl.includes('cobalt strike')) tags.push('cobaltstrike');
      if (dl.includes('metasploit')) tags.push('metasploit');
      if (dl.includes('sliver')) tags.push('sliver');
      if (dl.includes('brute ratel') || dl.includes('bruteratel')) tags.push('bruteratel');
      const sev = /cobaltstrike|cobalt.strike|brute.?ratel/i.test(desc) ? 'high' : 'medium';
      const t = sanitize({
        id: `c2intel:${ip}`, type: 'c2_server', source: 'c2intel', indicator: ip, indicatorType: 'ip',
        lat: null, lon: null, country: '', severity: sev, malwareFamily: mf, tags: normTags(tags),
        firstSeen: 0, lastSeen: 0,
      });
      if (t) threats.push(t);
      if (threats.length >= MAX_LIMIT) break;
    }
    console.log(`  C2Intel: ${threats.length} threats`);
    return { ok: true, threats };
  } catch (e) {
    console.warn(`  C2Intel: failed — ${e.message}`);
    return { ok: false, threats: [] };
  }
}

async function fetchOtx(days) {
  const apiKey = clean(process.env.OTX_API_KEY || '', 200);
  if (!apiKey) { console.log('  OTX: skipped (no OTX_API_KEY)'); return { ok: false, threats: [] }; }
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const resp = await fetch(`${OTX_INDICATORS_URL}${encodeURIComponent(since)}`, {
      headers: { Accept: 'application/json', 'X-OTX-API-KEY': apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, threats: [] };
    const payload = await resp.json();
    const results = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);
    const threats = [];
    for (const r of results) {
      const ip = clean(r?.indicator || r?.ip || '', 80).toLowerCase();
      if (!isIp(ip)) continue;
      const tags = normTags(r?.tags || []);
      const sev = tags.some((t) => /ransomware|apt|c2|botnet/.test(t)) ? 'high' : 'medium';
      const type = tags.some((t) => /c2|botnet/.test(t)) ? 'c2_server' : 'malware_host';
      const title = clean(r?.title || r?.description || '', 200);
      const t = sanitize({
        id: `otx:${ip}`, type, source: 'otx', indicator: ip, indicatorType: 'ip',
        lat: null, lon: null, country: '', severity: sev, malwareFamily: title, tags,
        firstSeen: toEpochMs(r?.created), lastSeen: toEpochMs(r?.modified || r?.created),
      });
      if (t) threats.push(t);
      if (threats.length >= MAX_LIMIT) break;
    }
    console.log(`  OTX: ${threats.length} threats`);
    return { ok: true, threats };
  } catch (e) {
    console.warn(`  OTX: failed — ${e.message}`);
    return { ok: false, threats: [] };
  }
}

async function fetchAbuseIpDb() {
  const apiKey = clean(process.env.ABUSEIPDB_API_KEY || '', 200);
  if (!apiKey) { console.log('  AbuseIPDB: skipped (no ABUSEIPDB_API_KEY)'); return { ok: false, threats: [] }; }

  try {
    const lastCall = await verifySeedKey(ABUSEIPDB_RATE_KEY);
    const lastTs = lastCall?.calledAt || 0;
    if (Date.now() - lastTs < ABUSEIPDB_MIN_INTERVAL_MS) {
      const cached = await verifySeedKey(ABUSEIPDB_CACHE_KEY);
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`  AbuseIPDB: ${cached.length} threats (cached, called ${Math.round((Date.now() - lastTs) / 60000)}m ago)`);
        return { ok: true, threats: cached };
      }
      console.log('  AbuseIPDB: skipped (rate limit, no cache)');
      return { ok: false, threats: [] };
    }
  } catch (e) {
    console.warn('  AbuseIPDB: rate-limit check failed (Redis) — proceeding with caution:', e?.message || e);
    // Proceed to API call: a transient Redis blip should not permanently disable
    // the source. The 2h rate-limit interval + 10-min cron means at most 1 extra
    // call per Redis outage window, well within the 100/day free-plan budget.
  }

  try {
    const url = `${ABUSEIPDB_BLACKLIST_URL}?confidenceMinimum=90&limit=${Math.min(MAX_LIMIT, 500)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', Key: apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, threats: [] };
    const payload = await resp.json();
    const records = Array.isArray(payload?.data) ? payload.data : [];
    const threats = [];
    for (const r of records) {
      const ip = clean(r?.ipAddress || r?.ip || '', 80).toLowerCase();
      if (!isIp(ip)) continue;
      const score = toNum(r?.abuseConfidenceScore) ?? 0;
      const sev = score >= 95 ? 'critical' : (score >= 80 ? 'high' : 'medium');
      const t = sanitize({
        id: `abuseipdb:${ip}`, type: 'malware_host', source: 'abuseipdb', indicator: ip, indicatorType: 'ip',
        lat: toNum(r?.latitude ?? r?.lat), lon: toNum(r?.longitude ?? r?.lon),
        country: normCountry(r?.countryCode || r?.country), severity: sev, malwareFamily: '',
        tags: normTags([`score:${score}`]), firstSeen: 0, lastSeen: toEpochMs(r?.lastReportedAt),
      });
      if (t) threats.push(t);
      if (threats.length >= MAX_LIMIT) break;
    }
    console.log(`  AbuseIPDB: ${threats.length} threats`);
    await writeExtraKey(ABUSEIPDB_CACHE_KEY, threats, 86400).catch(() => {});
    await writeExtraKey(ABUSEIPDB_RATE_KEY, { calledAt: Date.now() }, 86400).catch(() => {});
    return { ok: true, threats };
  } catch (e) {
    console.warn(`  AbuseIPDB: failed — ${e.message}`);
    return { ok: false, threats: [] };
  }
}

// ========================================================================
// Dedup + proto mapping
// ========================================================================

function dedupeThreats(threats) {
  const map = new Map();
  for (const t of threats) {
    const key = `${t.source}:${t.indicatorType}:${t.indicator}`;
    const existing = map.get(key);
    if (!existing) { map.set(key, t); continue; }
    const eSeen = existing.lastSeen || existing.firstSeen;
    const cSeen = t.lastSeen || t.firstSeen;
    if (cSeen >= eSeen) {
      map.set(key, { ...existing, ...t, tags: normTags([...existing.tags, ...t.tags]) });
    }
  }
  return Array.from(map.values());
}

function toProto(raw) {
  return {
    id: raw.id,
    type: THREAT_TYPE_MAP[raw.type] || 'CYBER_THREAT_TYPE_UNSPECIFIED',
    source: SOURCE_MAP[raw.source] || 'CYBER_THREAT_SOURCE_UNSPECIFIED',
    indicator: raw.indicator,
    indicatorType: INDICATOR_TYPE_MAP[raw.indicatorType] || 'CYBER_THREAT_INDICATOR_TYPE_UNSPECIFIED',
    location: validCoords(raw.lat, raw.lon) ? { latitude: raw.lat, longitude: raw.lon } : undefined,
    country: raw.country,
    severity: SEVERITY_MAP[raw.severity] || 'CRITICALITY_LEVEL_UNSPECIFIED',
    malwareFamily: raw.malwareFamily,
    tags: raw.tags,
    firstSeenAt: raw.firstSeen,
    lastSeenAt: raw.lastSeen,
  };
}

// ========================================================================
// Main fetch function
// ========================================================================

async function fetchAllThreats() {
  const now = Date.now();
  const cutoffMs = now - DEFAULT_DAYS * 86400000;

  const [feodo, urlhaus, c2intel, otx, abuseipdb] = await Promise.all([
    fetchFeodo(cutoffMs),
    fetchUrlhaus(cutoffMs),
    fetchC2Intel(),
    fetchOtx(DEFAULT_DAYS),
    fetchAbuseIpDb(),
  ]);

  const anyOk = feodo.ok || urlhaus.ok || c2intel.ok || otx.ok || abuseipdb.ok;
  if (!anyOk) throw new Error('All 5 IOC sources failed');

  const combined = dedupeThreats([
    ...feodo.threats, ...urlhaus.threats, ...c2intel.threats, ...otx.threats, ...abuseipdb.threats,
  ]);

  console.log(`  Combined (deduped): ${combined.length}`);

  const hydrated = await hydrateCoordinates(combined);

  // Keep all threats — geo-resolved first, then unresolved (so the seed never returns 0
  // when GeoIP APIs are rate-limited). Frontend handles missing location gracefully.
  const results = hydrated.slice();
  const geoCount = results.filter((t) => validCoords(t.lat, t.lon)).length;
  console.log(`  Geo resolved: ${geoCount}/${results.length}`);

  results.sort((a, b) => {
    const bySev = (SEVERITY_RANK[SEVERITY_MAP[b.severity] || ''] || 0) - (SEVERITY_RANK[SEVERITY_MAP[a.severity] || ''] || 0);
    if (bySev !== 0) return bySev;
    return (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen);
  });

  const threats = results.slice(0, MAX_CACHED_THREATS).map(toProto);
  console.log(`  Final threats (with coords): ${threats.length}`);

  return { threats };
}

function validate(data) {
  return Array.isArray(data?.threats) && data.threats.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.threats) ? data.threats.length : 0;
}

runSeed('cyber', 'threats', CANONICAL_KEY, fetchAllThreats, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'multi-ioc-v2',
  extraKeys: [{ key: BOOTSTRAP_KEY, declareRecords }],

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 240,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
