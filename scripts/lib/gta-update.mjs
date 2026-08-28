/**
 * GTA Update third-party TPS/TFS dispatch mirror (#7012).
 *
 * Unofficial, delayed, incomplete, entertainment-only. WorldMonitor holds
 * reuse permission, confirmed by the repository owner on 2026-08-21. The
 * private grant is not stored in this public repository. Parser + denylist +
 * ID contracts are locked here; the production writer stays disabled until
 * upstream provenance and the remaining product activation gates are accepted.
 *
 * Do not geocode location strings. Do not fold into canadaAlerts /
 * canadaRoads / weather / news / official live-CAD (#6682).
 */

import { CHROME_UA } from '../_seed-utils.mjs';

export const GTA_UPDATE_HOST = 'gtaupdate.com';
export const GTA_UPDATE_SITE_URL = 'https://gtaupdate.com/';
export const GTA_UPDATE_ABOUT_URL = 'https://gtaupdate.com/about.php';
export const GTA_UPDATE_LAST_INGEST_URL = 'https://gtaupdate.com/cache/last_ingest.txt';
export const GTA_UPDATE_ALLOWED_HOSTS = Object.freeze([GTA_UPDATE_HOST]);

export const GTA_POLICE_WINDOWS = Object.freeze([1, 3, 6, 12, 18, 24]);
export const GTA_FIRE_WINDOWS = Object.freeze([1, 3, 6, 12, 18, 24]);

export function gtaPoliceSnapshotUrl(hours = 1) {
  if (!GTA_POLICE_WINDOWS.includes(Number(hours))) {
    throw new Error(`gta-update: unsupported police window ${hours}`);
  }
  return `https://gtaupdate.com/cache/gta_police_${hours}.json`;
}

export function gtaFireSnapshotUrl(hours = 1) {
  if (!GTA_FIRE_WINDOWS.includes(Number(hours))) {
    throw new Error(`gta-update: unsupported fire window ${hours}`);
  }
  return `https://gtaupdate.com/cache/gta_fire_${hours}.json`;
}

export const GTA_UPDATE_WRITER_ENABLED = false;
export const GTA_UPDATE_PRODUCTION_ENABLED = false;
export const GTA_UPDATE_RIGHTS_STATUS = 'permission-held';
export const GTA_UPDATE_ACTIVATION_BLOCKER = [
  'WorldMonitor holds reuse permission; the private grant is not stored in',
  'this public repository. Production remains disabled while official TPS/TFS',
  'upstream provenance is unidentified and the remaining safety, cadence,',
  'capacity, and product activation gates in issue #7012 are unaccepted.',
  'Prefer #6682 when official endpoints can provide the requested signal.',
].join(' ');

export const GTA_SEMANTIC = 'live_dispatch';
export const GTA_POLICE_SOURCE = 'gta-update-police';
export const GTA_FIRE_SOURCE = 'gta-update-fire';
export const GTA_POLICE_KEY = 'safety:toronto:gta-update:police:v1';
export const GTA_FIRE_KEY = 'safety:toronto:gta-update:fire:v1';
export const GTA_POLICE_META_KEY = 'seed-meta:safety:gta-update-police';
export const GTA_FIRE_META_KEY = 'seed-meta:safety:gta-update-fire';
export const GTA_POLICE_ID_NS = 'gta-police';
export const GTA_FIRE_ID_NS = 'gta-fire';
export const GTA_UPDATE_SCHEMA_VERSION = 1;
export const GTA_UPDATE_SOURCE_VERSION = 'gta-update-disabled-v1';
export const GTA_UPDATE_TTL_SECONDS = 3600;
export const GTA_UPDATE_MAX_STALE_MIN = 90;
export const GTA_UPDATE_DEFAULT_WINDOW_HOURS = 1;
export const GTA_UPDATE_REQUEST_TIMEOUT_MS = 15_000;
export const GTA_UPDATE_MAX_BYTES = 2 * 1024 * 1024;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

const DENY_PATTERNS = Object.freeze([
  { reason: 'medical', re: /\b(?:medical(?:\s+assist)?|see\s+ambulance|sick\s+person|overdose|cardiac|chest\s+pain)\b/i },
  { reason: 'suicide_pic', re: /\b(?:suicide|person\s+in\s+crisis|\bpic\b|threatened\s+suicide|jumped)\b/i },
  { reason: 'sexual_violence', re: /\b(?:sexual\s+(?:assault|violence|offence|offense)|rape|indecent\s+assault)\b/i },
  { reason: 'domestic_violence', re: /\b(?:domestic(?:\s+assault|\s+violence)?|\bdv\b|intimate\s+partner|family\s+violence)\b/i },
]);

const DROP_PATTERNS = Object.freeze([
  { reason: 'cancelled', re: /\b(?:cancel+ed|unfounded|no\s+further\s+action|\bnfa\b)\b/i },
  { reason: 'reclassified', re: /\breclassif(?:y|ied|ication)\b/i },
]);

export class GtaUpdateUnavailableError extends Error {
  constructor(reason, { status = null, cause = undefined } = {}) {
    super(`GTA Update unavailable (${reason})`);
    this.name = 'GtaUpdateUnavailableError';
    this.reason = reason;
    this.status = status;
    this.sourceState = 'unavailable';
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAllowedGtaUpdateHost(url, allowedHosts = GTA_UPDATE_ALLOWED_HOSTS) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && allowedHosts.includes(parsed.hostname.toLowerCase())
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function unixSecondsToIso(value) {
  const seconds = finiteNumber(value);
  if (seconds == null || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function classifyGtaDescription(description) {
  const text = textOrNull(description);
  if (!text) return { action: 'drop', reason: 'missing_description' };
  for (const { reason, re } of DENY_PATTERNS) {
    if (re.test(text)) return { action: 'deny', reason };
  }
  for (const { reason, re } of DROP_PATTERNS) {
    if (re.test(text)) return { action: 'drop', reason };
  }
  return { action: 'allow', reason: null };
}

export function policeCanonicalId(id) {
  const value = finiteNumber(id);
  if (value == null) return null;
  return `${GTA_POLICE_ID_NS}:${value}`;
}

export function fireCanonicalId(eventId) {
  const value = textOrNull(eventId);
  if (!value) return null;
  return `${GTA_FIRE_ID_NS}:${value}`;
}

export function isPoliceNamespaceId(id) {
  return typeof id === 'string' && id.startsWith(`${GTA_POLICE_ID_NS}:`);
}

export function isFireNamespaceId(id) {
  return typeof id === 'string' && id.startsWith(`${GTA_FIRE_ID_NS}:`);
}

/**
 * Publisher change-marker. last_ingest.txt is a naive `YYYY-MM-DD HH:MM:SS`
 * clock. Health must use this (or the row publisher timestamp), never fetch
 * time alone.
 */
export function parseGtaLastIngest(text) {
  const raw = textOrNull(typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '');
  if (!raw) return null;
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw);
  if (naive) {
    const iso = `${naive[1]}T${naive[2]}Z`;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return { raw, publisherTime: iso, publisherTimeMs: ms };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return { raw, publisherTime: new Date(ms).toISOString(), publisherTimeMs: ms };
}

function locationStringOnly(value) {
  const location = textOrNull(value);
  return {
    location,
    lat: null,
    lon: null,
    geocoded: false,
  };
}

export function normalizeGtaPoliceRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { action: 'drop', reason: 'missing_row' };
  const id = policeCanonicalId(raw.id);
  if (!id) return { action: 'drop', reason: 'missing_id' };
  const description = textOrNull(raw.description);
  const verdict = classifyGtaDescription(description);
  if (verdict.action !== 'allow') return { ...verdict, id };
  const observedAt = unixSecondsToIso(raw.timestamp);
  return {
    action: 'allow',
    record: {
      id,
      namespace: GTA_POLICE_ID_NS,
      semantic: GTA_SEMANTIC,
      source: GTA_POLICE_SOURCE,
      official: false,
      verified: false,
      agency: 'tps',
      description,
      ...locationStringOnly(raw.location),
      division: textOrNull(raw.division),
      divisionId: finiteNumber(raw.division_id),
      displayTime: textOrNull(raw.time),
      observedAt,
      observedAtUnix: finiteNumber(raw.timestamp),
      highlight: raw.highlight === true,
      keyword: textOrNull(raw.keyword),
    },
  };
}

export function normalizeGtaFireRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { action: 'drop', reason: 'missing_row' };
  const id = fireCanonicalId(raw.event_id);
  if (!id) return { action: 'drop', reason: 'missing_id' };
  const description = textOrNull(raw.description);
  const verdict = classifyGtaDescription(description);
  if (verdict.action !== 'allow') return { ...verdict, id };
  const observedAt = unixSecondsToIso(raw.time_unix);
  return {
    action: 'allow',
    record: {
      id,
      namespace: GTA_FIRE_ID_NS,
      semantic: GTA_SEMANTIC,
      source: GTA_FIRE_SOURCE,
      official: false,
      verified: false,
      agency: 'tfs',
      description,
      ...locationStringOnly(raw.location),
      division: textOrNull(raw.division),
      divisionId: finiteNumber(raw.division_id),
      displayTime: textOrNull(raw.time_str),
      displayDate: textOrNull(raw.date_str),
      observedAt,
      observedAtUnix: finiteNumber(raw.time_unix),
      cad: finiteNumber(raw.cad),
      alarmLevel: finiteNumber(raw.alarm_level),
      isUpdated: raw.is_updated === 1 || raw.is_updated === true,
      units: textOrNull(raw.units),
      cityName: textOrNull(raw.city_name),
      cityCode: textOrNull(raw.city_code),
      highlight: raw.highlight === true,
    },
  };
}

function parseRowList(input, normalize, label) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error(`gta-update: ${label} body is not parseable JSON`); }
  }
  if (!Array.isArray(data)) {
    throw new Error(`gta-update: ${label} body is not a JSON array`);
  }
  const records = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of data) {
    const result = normalize(raw);
    if (result.action !== 'allow') {
      dropped.push({ id: result.id ?? null, reason: result.reason });
      continue;
    }
    if (seen.has(result.record.id)) continue;
    seen.add(result.record.id);
    records.push(result.record);
  }
  return { records, dropped };
}

export function parseGtaPoliceSnapshot(input) {
  return parseRowList(input, normalizeGtaPoliceRow, 'police');
}

export function parseGtaFireSnapshot(input) {
  return parseRowList(input, normalizeGtaFireRow, 'fire');
}

export function buildGtaSnapshot({
  kind,
  records,
  dropped = [],
  lastIngest = null,
  fetchedAt = new Date().toISOString(),
  windowHours = GTA_UPDATE_DEFAULT_WINDOW_HOURS,
} = {}) {
  const source = kind === 'fire' ? GTA_FIRE_SOURCE : GTA_POLICE_SOURCE;
  const canonicalKey = kind === 'fire' ? GTA_FIRE_KEY : GTA_POLICE_KEY;
  const feedUrl = kind === 'fire' ? gtaFireSnapshotUrl(windowHours) : gtaPoliceSnapshotUrl(windowHours);
  return {
    schemaVersion: GTA_UPDATE_SCHEMA_VERSION,
    semantic: GTA_SEMANTIC,
    source,
    canonicalKey,
    feedUrl,
    official: false,
    verified: false,
    writerEnabled: GTA_UPDATE_WRITER_ENABLED,
    rightsStatus: GTA_UPDATE_RIGHTS_STATUS,
    activationBlocker: GTA_UPDATE_ACTIVATION_BLOCKER,
    windowHours,
    fetchedAt,
    publisherTime: lastIngest?.publisherTime ?? null,
    publisherTimeMs: lastIngest?.publisherTimeMs ?? null,
    publisherTimeRaw: lastIngest?.raw ?? null,
    records: Array.isArray(records) ? records : [],
    dropped: Array.isArray(dropped) ? dropped : [],
  };
}

export function validateGtaSnapshot(snapshot, kind) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== GTA_UPDATE_SCHEMA_VERSION) return false;
  if (snapshot.semantic !== GTA_SEMANTIC) return false;
  if (snapshot.official !== false || snapshot.verified !== false) return false;
  if (snapshot.writerEnabled !== false) return false;
  if (!Array.isArray(snapshot.records)) return false;
  const expectedSource = kind === 'fire' ? GTA_FIRE_SOURCE : kind === 'police' ? GTA_POLICE_SOURCE : snapshot.source;
  if (snapshot.source !== expectedSource) return false;
  const idCheck = expectedSource === GTA_FIRE_SOURCE ? isFireNamespaceId : isPoliceNamespaceId;
  return snapshot.records.every((record) => record && idCheck(record.id) && record.lat == null && record.lon == null && record.geocoded === false);
}

export function declareGtaRecords(snapshot) {
  return Array.isArray(snapshot?.records) ? snapshot.records.length : 0;
}

/**
 * Health uses publisher/change-marker time, not fetch time.
 */
export function gtaUpdateContentMeta(snapshot) {
  if (Number.isFinite(snapshot?.publisherTimeMs) && snapshot.publisherTimeMs > 0) {
    return { newestItemAt: snapshot.publisherTimeMs, oldestItemAt: snapshot.publisherTimeMs };
  }
  const timestamps = (snapshot?.records ?? [])
    .map((record) => record.observedAtUnix)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => value * 1000);
  if (timestamps.length === 0) return null;
  return { newestItemAt: Math.max(...timestamps), oldestItemAt: Math.min(...timestamps) };
}

export function resolveGtaPublish(fetchResult, lastGood) {
  if (fetchResult?.ok && validateGtaSnapshot(fetchResult.snapshot)) {
    return { persist: true, snapshot: fetchResult.snapshot, sourceState: 'ok' };
  }
  if (validateGtaSnapshot(lastGood)) {
    return {
      persist: false,
      keepLastGood: true,
      sourceState: 'degraded',
      reason: fetchResult?.reason || 'shape_break',
    };
  }
  return {
    persist: false,
    keepLastGood: false,
    sourceState: 'unavailable',
    reason: fetchResult?.reason || 'shape_break',
  };
}

export function assertGtaWriterDisabled() {
  if (GTA_UPDATE_WRITER_ENABLED || GTA_UPDATE_PRODUCTION_ENABLED) {
    throw new Error('gta-update: production writer must stay disabled until the activation gates clear (#7012)');
  }
}

export function refuseGtaProductionWrite() {
  assertGtaWriterDisabled();
  throw new Error('gta-update: production writer is disabled (upstream-provenance / activation gates #7012)');
}

async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new GtaUpdateUnavailableError('response_too_large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) {
    throw new GtaUpdateUnavailableError('response_too_large');
  }
  return text;
}

async function fetchAllowed(url, { fetchImpl, timeoutMs, accept }) {
  if (!isAllowedGtaUpdateHost(url)) {
    return { ok: false, sourceState: 'unavailable', reason: 'host_not_allowlisted' };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': CHROME_UA },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = `${err?.message || err}`;
    if (/redirect/i.test(message)) {
      return { ok: false, sourceState: 'unavailable', reason: 'redirect_rejected' };
    }
    if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
      return { ok: false, sourceState: 'unavailable', reason: 'timeout' };
    }
    return { ok: false, sourceState: 'unavailable', reason: 'fetch_failed', error: message };
  }
  if (response.redirected) {
    return { ok: false, sourceState: 'unavailable', reason: 'redirect_rejected' };
  }
  if (typeof response.url === 'string' && response.url && !isAllowedGtaUpdateHost(response.url)) {
    return { ok: false, sourceState: 'unavailable', reason: 'host_not_allowlisted' };
  }
  if (!response.ok) {
    return {
      ok: false,
      sourceState: 'unavailable',
      reason: `http_${response.status}`,
      status: response.status,
    };
  }
  return { ok: true, response };
}

export async function fetchGtaLastIngest({
  fetchImpl = DEFAULT_FETCH,
  timeoutMs = GTA_UPDATE_REQUEST_TIMEOUT_MS,
  maxBytes = 4096,
} = {}) {
  const result = await fetchAllowed(GTA_UPDATE_LAST_INGEST_URL, {
    fetchImpl,
    timeoutMs,
    accept: 'text/plain, */*',
  });
  if (!result.ok) return result;
  try {
    const text = await readBoundedText(result.response, maxBytes);
    const parsed = parseGtaLastIngest(text);
    if (!parsed) return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
    return { ok: true, lastIngest: parsed };
  } catch (err) {
    if (err instanceof GtaUpdateUnavailableError) {
      return { ok: false, sourceState: 'unavailable', reason: err.reason };
    }
    return { ok: false, sourceState: 'unavailable', reason: 'read_failed' };
  }
}

export async function fetchGtaSnapshot(kind, {
  fetchImpl = DEFAULT_FETCH,
  windowHours = GTA_UPDATE_DEFAULT_WINDOW_HOURS,
  timeoutMs = GTA_UPDATE_REQUEST_TIMEOUT_MS,
  maxBytes = GTA_UPDATE_MAX_BYTES,
  lastIngest = null,
  now = Date.now(),
} = {}) {
  const url = kind === 'fire' ? gtaFireSnapshotUrl(windowHours) : gtaPoliceSnapshotUrl(windowHours);
  const result = await fetchAllowed(url, {
    fetchImpl,
    timeoutMs,
    accept: 'application/json',
  });
  if (!result.ok) return result;
  let text;
  try {
    text = await readBoundedText(result.response, maxBytes);
  } catch (err) {
    if (err instanceof GtaUpdateUnavailableError) {
      return { ok: false, sourceState: 'unavailable', reason: err.reason };
    }
    return { ok: false, sourceState: 'unavailable', reason: 'read_failed' };
  }
  try {
    const parsed = kind === 'fire' ? parseGtaFireSnapshot(text) : parseGtaPoliceSnapshot(text);
    const snapshot = buildGtaSnapshot({
      kind,
      records: parsed.records,
      dropped: parsed.dropped,
      lastIngest,
      fetchedAt: new Date(now).toISOString(),
      windowHours,
    });
    if (!validateGtaSnapshot(snapshot, kind)) {
      return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
    }
    return { ok: true, snapshot };
  } catch {
    return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
  }
}
