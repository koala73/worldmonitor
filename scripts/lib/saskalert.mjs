/**
 * SaskAlert public JSON adapter (#6659).
 *
 * Official public mobile feed at emergencyalert.saskatchewan.ca/sapublic.
 * This is not Pelmorex LMD, NAAD, weather:alerts, or a roads feed.
 * The summary JSON carries lifecycle/level; CAP 1.2 JSON details carry
 * severity. Missing CAP severity fails closed at the record — colour/level
 * is not CAP. One bad enclosure degrades the tick; it does not abort SK.
 */

import { CHROME_UA, MAX_PAYLOAD_BYTES } from '../_seed-utils.mjs';

export const SASKALERT_HOST = 'emergencyalert.saskatchewan.ca';
export const SASKALERT_FEED_URL = 'https://emergencyalert.saskatchewan.ca/sapublic/feed.json';
export const SASKALERT_HOME_URL = 'https://emergencyalert.saskatchewan.ca/';
export const SASKALERT_SOURCE = 'saskalert';
export const SASKALERT_PROVINCE = 'SK';
/** Geographic centre of Saskatchewan as [lon, lat]. */
export const SASKATCHEWAN_CENTROID = Object.freeze([-106.45, 54]);
export const SASKALERT_MAX_CONTENT_AGE_MIN = 3 * 24 * 60;
export const MAX_ALERTS = 100;
export const MAX_CAP_FETCHES = 40;
/** Stop starting new CAP fetches after this many ms so the 60s bundle section can finish. */
export const CAP_PHASE_BUDGET_MS = 38_000;
export const CAP_CONCURRENCY = 6;

const DEFAULT_TIMEOUT_MS = 15_000;
const CAP_SEVERITY = Object.freeze({
  extreme: 'Extreme',
  severe: 'Severe',
  moderate: 'Moderate',
  minor: 'Minor',
});
const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });
const ENDED_TOKEN_RE = /\b(ended|cancelled|canceled|all\s*clear|allclear)\b/i;

export function isAllowedSaskAlertHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === SASKALERT_HOST
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * CAP severity only. Summary `level` (advisory/warning) is not a CAP value
 * and must not be invented into Extreme/Severe/Moderate/Minor.
 */
export function mapSaskAlertSeverity(capSeverity) {
  const cap = String(capSeverity || '').trim().toLowerCase();
  return CAP_SEVERITY[cap] || null;
}

export function parseDateMs(...raws) {
  for (const raw of raws) {
    if (!raw || typeof raw !== 'string') continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

export function isEndedSummaryEntry(entry = {}) {
  const state = String(entry.state || '').trim().toLowerCase();
  const type = String(entry.type_en || entry.type_fr || '').trim().toLowerCase();
  if (state === 'ended') return true;
  if (type === 'cancelled' || type === 'canceled' || type === 'ended' || type === 'terminé' || type === 'termine') {
    return true;
  }
  const blob = `${entry.summary_en || ''} ${entry.event_en || ''}`;
  return ENDED_TOKEN_RE.test(blob);
}

function pickEnglishInfo(alert) {
  const infos = Array.isArray(alert?.info) ? alert.info : [];
  return infos.find((info) => String(info?.language || '').toLowerCase().startsWith('en'))
    || infos[0]
    || null;
}

export function isEndedCapAlert(alert, info, nowMs = Date.now()) {
  if (!alert || typeof alert !== 'object') return true;
  const status = String(alert.status || '').trim().toLowerCase();
  const msgType = String(alert.msgType || '').trim().toLowerCase();
  const scope = String(alert.scope || '').trim().toLowerCase();
  const response = String(info?.responseType || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  const urgency = String(info?.urgency || '').trim().toLowerCase();
  const blob = `${info?.headline || ''} ${info?.description || ''}`;
  if (ENDED_TOKEN_RE.test(blob) || response === 'allclear' || urgency === 'past' || msgType === 'cancel') {
    return true;
  }
  const expiresMs = parseDateMs(info?.expires);
  if (expiresMs != null && expiresMs <= nowMs) return true;
  if (status && status !== 'actual') return true;
  if (scope && scope !== 'public') return true;
  if (msgType && !['alert', 'update'].includes(msgType)) return true;
  return false;
}

/** CAP polygons are "lat,lon lat,lon"; summary points are "lat lon". */
export function parseSaskAlertCoordinates(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  const pairs = raw.trim().split(/\s+/);
  for (const pair of pairs) {
    const parts = pair.split(',').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      const [lat, lon] = parts;
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) out.push([lon, lat]);
      continue;
    }
  }
  if (out.length === 0) {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const lat = nums[i];
      const lon = nums[i + 1];
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) out.push([lon, lat]);
    }
  }
  return out;
}

function centroidOf(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [...SASKATCHEWAN_CENTROID];
  const [lon, lat] = coords.reduce(
    (sum, coordinate) => [sum[0] + coordinate[0], sum[1] + coordinate[1]],
    [0, 0],
  );
  return [lon / coords.length, lat / coords.length];
}

function areaDescFrom(entry, info) {
  const areas = Array.isArray(info?.area) ? info.area : [];
  const fromCap = areas.map((area) => String(area?.areaDesc || '').trim()).filter(Boolean);
  if (fromCap.length > 0) return fromCap.join('; ');
  const fromSummary = Array.isArray(entry?.area)
    ? entry.area.map((area) => String(area?.name_en || '').trim()).filter(Boolean)
    : [];
  return fromSummary.join('; ') || String(entry?.coverage_en || '').trim();
}

export function normalizeSaskAlertRecord(entry, capDocument, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  if (isEndedSummaryEntry(entry)) return null;

  const alert = capDocument?.alert;
  const info = pickEnglishInfo(alert);
  if (!alert || !info) {
    throw new Error('saskalert: active entry is missing a CAP alert/info block');
  }
  if (isEndedCapAlert(alert, info, nowMs)) return null;

  const severity = mapSaskAlertSeverity(info.severity);
  if (!severity) {
    throw new Error(`saskalert: missing CAP severity (${info.severity || 'empty'})`);
  }

  const identifier = String(entry.identifier || alert.identifier || entry.id || '').trim();
  if (!identifier) {
    throw new Error('saskalert: active entry is missing identifier');
  }

  const polygons = (Array.isArray(info.area) ? info.area : [])
    .flatMap((area) => parseSaskAlertCoordinates(area?.polygon));
  const coords = polygons.length > 0
    ? polygons
    : parseSaskAlertCoordinates(entry.point);
  const centroid = centroidOf(coords);
  const updatedAt = parseDateMs(entry.updated, info.effective, entry.sent, alert.sent);
  const publishedAt = parseDateMs(entry.sent, alert.sent, info.effective, entry.updated);
  const headline = String(info.headline || entry.summary_en || '').trim();
  const event = String(info.event || entry.event_en || '').trim();

  return {
    id: `sk-saskalert-${identifier}`,
    province: SASKALERT_PROVINCE,
    severity,
    event,
    headline,
    description: String(info.description || entry.summary_en || '').replace(/\s+/g, ' ').trim().slice(0, 800),
    areaDesc: areaDescFrom(entry, info),
    onset: info.effective || entry.sent || entry.updated || '',
    expires: info.expires || '',
    updatedAt,
    publishedAt,
    lat: centroid[1],
    lon: centroid[0],
    centroid,
    url: String(entry.html_link || SASKALERT_HOME_URL).trim(),
    capUrl: String(entry.cap_link || '').trim(),
    source: SASKALERT_SOURCE,
  };
}

export function parseSaskAlertFeed(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('saskalert: body is not parseable JSON'); }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new Error('saskalert: body is not a SaskAlert feed');
  }
  return data.entries;
}

export function parseSaskAlertCap(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('saskalert: CAP body is not parseable JSON'); }
  }
  if (!data || typeof data !== 'object' || !data.alert || typeof data.alert !== 'object') {
    throw new Error('saskalert: CAP body is not a CAP 1.2 JSON alert');
  }
  return data;
}

async function readLimitedJson(resp, maxBytes, label) {
  const contentLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`saskalert: ${label} exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`saskalert: ${label} exceeds ${maxBytes} bytes`);
  }
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error(`saskalert: ${label} is not parseable JSON`); }
}

export async function fetchSaskAlertCap(url, opts = {}) {
  if (!isAllowedSaskAlertHost(url)) {
    throw new Error(`saskalert: CAP host is not on the allowlist (${SASKALERT_HOST})`);
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const resp = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)),
    redirect: 'error',
  });
  if (!resp.ok) throw new Error(`saskalert: CAP HTTP ${resp.status}`);
  return parseSaskAlertCap(await readLimitedJson(resp, maxBytes, 'CAP body'));
}

export async function fetchSaskAlerts(opts = {}) {
  const url = opts.url || SASKALERT_FEED_URL;
  if (!isAllowedSaskAlertHost(url)) {
    throw new Error(`saskalert: host is not on the allowlist (${SASKALERT_HOST})`);
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const nowMs = opts.nowMs ?? Date.now();

  const resp = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) throw new Error(`saskalert: HTTP ${resp.status}`);
  const entries = parseSaskAlertFeed(await readLimitedJson(resp, maxBytes, 'feed'));

  const active = entries.filter((entry) => !isEndedSummaryEntry(entry));
  if (active.length > MAX_CAP_FETCHES) {
    throw new Error(`saskalert: active entry count exceeds ${MAX_CAP_FETCHES}`);
  }

  const verification = { attempted: 0, failed: 0, skippedDeadline: 0 };
  const alerts = [];
  const seen = new Set();
  const seenCapLinks = new Set();
  const wallStart = opts.nowWallMs ?? Date.now();
  const budgetMs = opts.capBudgetMs ?? CAP_PHASE_BUDGET_MS;
  const concurrency = Math.max(1, opts.capConcurrency ?? CAP_CONCURRENCY);
  let nextIndex = 0;

  async function hydrateOne(entry) {
    if ((opts.nowWallMs ?? Date.now()) - wallStart >= budgetMs) {
      verification.skippedDeadline += 1;
      return;
    }
    const capLink = String(entry?.cap_link || '').trim();
    if (!capLink) {
      verification.failed += 1;
      return;
    }
    if (seenCapLinks.has(capLink)) return;
    seenCapLinks.add(capLink);
    verification.attempted += 1;
    try {
      const capDocument = await fetchSaskAlertCap(capLink, { fetchFn, timeoutMs, maxBytes, userAgent });
      const record = normalizeSaskAlertRecord(entry, capDocument, nowMs);
      if (!record || seen.has(record.id)) return;
      seen.add(record.id);
      alerts.push(record);
    } catch {
      verification.failed += 1;
    }
  }

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= active.length) return;
      await hydrateOne(active[index]);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(active.length, 1)) },
    () => worker(),
  ));

  if (alerts.length > MAX_ALERTS) {
    throw new Error(`saskalert: normalized alert count exceeds ${MAX_ALERTS}`);
  }

  alerts.sort((a, b) => (
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  ));
  return { alerts, _capVerification: verification };
}

export function saskAlertPublishTransform(data) {
  return { alerts: Array.isArray(data?.alerts) ? data.alerts : [] };
}

export function saskAlertAfterPublish(data) {
  const failed = Math.min(100, Math.max(0, Number(data?._capVerification?.failed) || 0));
  const skippedDeadline = Math.min(100, Math.max(0, Number(data?._capVerification?.skippedDeadline) || 0));
  if (failed > 0 || skippedDeadline > 0) {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'CAP_VERIFICATION_FAILED',
        capVerificationFailed: failed,
        capSkippedDeadline: skippedDeadline,
      },
    };
  }
  return { freshnessMetaPatch: { sourceState: 'ok' } };
}

export function validateSaskAlertEnvelope(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.alerts);
}

export function declareSaskAlertRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

export function saskAlertContentMeta(data, nowMs = Date.now()) {
  const timestamps = (data?.alerts ?? [])
    .map((alert) => alert.updatedAt ?? alert.publishedAt)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= nowMs + 60 * 60 * 1000);
  if (timestamps.length === 0) return null;
  return { newestItemAt: Math.max(...timestamps), oldestItemAt: Math.min(...timestamps) };
}
