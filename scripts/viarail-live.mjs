/**
 * VIA Rail Tracker unofficial live JSON parser (#6615).
 *
 * Endpoint: https://tsimobile.viarail.ca/data/allData.json
 * Undocumented, unauthenticated, not GTFS-RT. Best-effort only — no SLA.
 *
 * Tests import this module, not scripts/seed-viarail-live.mjs.
 */
import { CHROME_UA } from './_seed-utils.mjs';

export const VIA_RAIL_LIVE_URL = 'https://tsimobile.viarail.ca/data/allData.json';
export const VIA_RAIL_LIVE_HOST = 'tsimobile.viarail.ca';
export const VIA_RAIL_LIVE_ALLOWED_HOSTS = Object.freeze([VIA_RAIL_LIVE_HOST]);
/** Cache identity is the fetch URL itself — do not invent a second key. */
export const VIA_RAIL_LIVE_CACHE_KEY = VIA_RAIL_LIVE_URL;
export const VIA_RAIL_LIVE_KEY = 'transit:viarail:live';
export const VIA_RAIL_LIVE_META_KEY = 'seed-meta:transit:viarail-live';
export const VIA_RAIL_LIVE_SOURCE_VERSION = 'viarail-live-tsimobile-v1';
export const VIA_RAIL_LIVE_SCHEMA_VERSION = 1;
export const VIA_RAIL_LIVE_TTL_SECONDS = 3 * 60 * 60;
export const VIA_RAIL_LIVE_MAX_STALE_MIN = 45;
export const VIA_RAIL_LIVE_REQUEST_TIMEOUT_MS = 15_000;
export const VIA_RAIL_LIVE_MAX_BYTES = 2 * 1024 * 1024;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

export class ViaRailLiveUnavailableError extends Error {
  constructor(reason, { status = null, cause = undefined } = {}) {
    super(`VIA Rail live unavailable (${reason})`);
    this.name = 'ViaRailLiveUnavailableError';
    this.reason = reason;
    this.status = status;
    this.sourceState = 'unavailable';
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAllowedViaRailLiveHost(url, allowedHosts = VIA_RAIL_LIVE_ALLOWED_HOSTS) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return allowedHosts.some((host) => parsed.hostname === host);
  } catch {
    return false;
  }
}

/**
 * Absent is null, never 0. `Number(null)`, `Number('')` and `Number([])` are all
 * 0 and all finite, so a bare Number() coercion turned a train reporting no
 * position into a train at 0°N 0°E — which then satisfied the has-position gate
 * and overwrote last-good with a fleet parked in the Gulf of Guinea. Only real
 * numbers and non-blank numeric strings are values; everything else is absent.
 */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function bilingualText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const en = textOrNull(value.en);
  const fr = textOrNull(value.fr);
  if (!en && !fr) return null;
  return { en, fr };
}

function parseStationStop(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const diffMin = finiteNumber(raw.diffMin);
  if (diffMin == null) return null;
  const scheduled = textOrNull(raw.scheduled);
  const estimated = textOrNull(raw.estimated);
  const arrival = raw.arrival && typeof raw.arrival === 'object'
    ? {
      scheduled: textOrNull(raw.arrival.scheduled),
      estimated: textOrNull(raw.arrival.estimated),
    }
    : null;
  const departure = raw.departure && typeof raw.departure === 'object'
    ? {
      scheduled: textOrNull(raw.departure.scheduled),
      estimated: textOrNull(raw.departure.estimated),
    }
    : null;
  return {
    station: textOrNull(raw.station),
    code: textOrNull(raw.code),
    tz: textOrNull(raw.tz),
    scheduled,
    estimated,
    eta: textOrNull(raw.eta),
    diff: textOrNull(raw.diff),
    diffMin,
    arrival,
    departure,
  };
}

function parseAlert(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const header = bilingualText(raw.header);
  const description = bilingualText(raw.description);
  if (!header && !description) return null;
  return {
    header,
    description,
    url: bilingualText(raw.url),
  };
}

function parseTrain(id, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stations = Array.isArray(raw.times)
    ? raw.times.map(parseStationStop).filter(Boolean)
    : [];
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.map(parseAlert).filter(Boolean)
    : [];
  const lat = finiteNumber(raw.lat);
  const lng = finiteNumber(raw.lng);
  return {
    id: String(id),
    from: textOrNull(raw.from),
    to: textOrNull(raw.to),
    lat,
    lng,
    speed: finiteNumber(raw.speed),
    direction: finiteNumber(raw.direction),
    arrived: raw.arrived === true,
    departed: raw.departed === true,
    poll: textOrNull(raw.poll),
    pollMin: finiteNumber(raw.pollMin),
    instance: textOrNull(raw.instance),
    stations,
    alerts,
  };
}

/**
 * A snapshot is publishable only when it carries at least one live lat/lng
 * pair AND at least one per-station numeric diffMin. A 200 with the wrong
 * shape must not overwrite last-good.
 */
export function validateViaRailLiveSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (snapshot.schemaVersion !== VIA_RAIL_LIVE_SCHEMA_VERSION) return false;
  if (!Array.isArray(snapshot.trains) || snapshot.trains.length === 0) return false;
  let hasPosition = false;
  let hasDiffMin = false;
  for (const train of snapshot.trains) {
    if (!train || typeof train !== 'object') return false;
    if (finiteNumber(train.lat) != null && finiteNumber(train.lng) != null) hasPosition = true;
    if (Array.isArray(train.stations)) {
      for (const stop of train.stations) {
        if (finiteNumber(stop?.diffMin) != null) hasDiffMin = true;
      }
    }
  }
  return hasPosition && hasDiffMin;
}

export function parseViaRailLive(raw, { fetchedAt = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ViaRailLiveUnavailableError('shape_break');
  }
  const trains = [];
  for (const [id, value] of Object.entries(raw)) {
    const train = parseTrain(id, value);
    if (train) trains.push(train);
  }
  const snapshot = {
    schemaVersion: VIA_RAIL_LIVE_SCHEMA_VERSION,
    source: VIA_RAIL_LIVE_HOST,
    fetchedAt,
    trains,
  };
  if (!validateViaRailLiveSnapshot(snapshot)) {
    throw new ViaRailLiveUnavailableError('shape_break');
  }
  return snapshot;
}

export function viaRailLiveRecordCount(snapshot) {
  return Array.isArray(snapshot?.trains) ? snapshot.trains.length : 0;
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ViaRailLiveUnavailableError('response_too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new ViaRailLiveUnavailableError('response_too_large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ViaRailLiveUnavailableError('response_too_large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch + parse. Never throws SEED_ERROR — 404 and shape-break resolve to
 * `{ ok: false, sourceState: 'unavailable' }`.
 */
export async function fetchViaRailLive({
  fetchImpl = DEFAULT_FETCH,
  url = VIA_RAIL_LIVE_URL,
  allowedHosts = VIA_RAIL_LIVE_ALLOWED_HOSTS,
  timeoutMs = VIA_RAIL_LIVE_REQUEST_TIMEOUT_MS,
  maxBytes = VIA_RAIL_LIVE_MAX_BYTES,
  now = Date.now(),
} = {}) {
  if (!isAllowedViaRailLiveHost(url, allowedHosts)) {
    return { ok: false, sourceState: 'unavailable', reason: 'host_not_allowlisted' };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = `${err?.message || err}`;
    if (/redirect/i.test(message) || err?.cause?.code === 'UNDICI_REDIRECT') {
      return { ok: false, sourceState: 'unavailable', reason: 'redirect_rejected' };
    }
    return {
      ok: false,
      sourceState: 'unavailable',
      reason: 'fetch_failed',
      error: message,
    };
  }
  if (response.redirected) {
    return { ok: false, sourceState: 'unavailable', reason: 'redirect_rejected' };
  }
  if (typeof response.url === 'string' && response.url && !isAllowedViaRailLiveHost(response.url, allowedHosts)) {
    return { ok: false, sourceState: 'unavailable', reason: 'host_not_allowlisted' };
  }
  if (response.status === 404) {
    return { ok: false, sourceState: 'unavailable', reason: 'http_404', status: 404 };
  }
  if (!response.ok) {
    return {
      ok: false,
      sourceState: 'unavailable',
      reason: `http_${response.status}`,
      status: response.status,
    };
  }
  let text;
  try {
    text = await readBoundedBody(response, maxBytes);
  } catch (err) {
    if (err instanceof ViaRailLiveUnavailableError) {
      return { ok: false, sourceState: 'unavailable', reason: err.reason };
    }
    return { ok: false, sourceState: 'unavailable', reason: 'read_failed' };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
  }
  try {
    const snapshot = parseViaRailLive(raw, { fetchedAt: now });
    return { ok: true, snapshot };
  } catch (err) {
    if (err instanceof ViaRailLiveUnavailableError) {
      return { ok: false, sourceState: 'unavailable', reason: err.reason };
    }
    return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
  }
}

/**
 * Decide whether to publish. Failure ≠ miss: last-good is kept. A 404 or
 * shape-break with no last-good is `sourceState: 'unavailable'` so health
 * grades NOT_CONFIGURED rather than SEED_ERROR / EMPTY.
 */
export function resolveViaRailLivePublish(fetchResult, lastGood) {
  if (fetchResult?.ok && validateViaRailLiveSnapshot(fetchResult.snapshot)) {
    return { persist: true, snapshot: fetchResult.snapshot, sourceState: 'ok' };
  }
  if (validateViaRailLiveSnapshot(lastGood)) {
    return {
      persist: false,
      keepLastGood: true,
      sourceState: null,
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

export async function ingestViaRailLive({
  fetchImpl = DEFAULT_FETCH,
  readLastGood = async () => null,
  persist = async () => {},
  writeUnavailableMeta = async () => {},
  url = VIA_RAIL_LIVE_URL,
  allowedHosts = VIA_RAIL_LIVE_ALLOWED_HOSTS,
  now = Date.now(),
} = {}) {
  const fetchResult = await fetchViaRailLive({ fetchImpl, url, allowedHosts, now });
  const lastGood = await readLastGood();
  const decision = resolveViaRailLivePublish(fetchResult, lastGood);
  if (decision.persist) {
    await persist(decision.snapshot);
    return decision;
  }
  if (decision.sourceState === 'unavailable') {
    await writeUnavailableMeta({ reason: decision.reason });
  }
  return decision;
}

export { CHROME_UA, DEFAULT_FETCH };
