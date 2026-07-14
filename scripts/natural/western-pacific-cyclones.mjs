import { CHROME_UA } from '../_seed-utils.mjs';

export const HKO_WARNING_SUMMARY_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en';
export const HKO_WARNING_SOURCE_URL = 'https://www.weather.gov.hk/en/wxinfo/currwx/warn.htm';
export const HKO_COORDINATES = Object.freeze({ lat: 22.3193, lon: 114.1694 });
export const MAX_APPROVED_RESPONSE_BYTES = 256 * 1024;

const JMA_PREFLIGHT_DECISION = Object.freeze({
  source: 'JMA RSMC Tokyo',
  host: 'www.jma.go.jp',
  status: 'blocked',
  reason: 'EXPERIMENTAL_CAP_NOT_OPERATIONAL',
  optional: false,
  requestCount: 0,
});

const JTWC_PREFLIGHT_DECISION = Object.freeze({
  source: 'JTWC',
  host: 'www.metoc.navy.mil',
  status: 'blocked',
  reason: 'NOT_ENABLED_PENDING_RAILWAY_PREFLIGHT',
  optional: true,
  requestCount: 0,
});

const AGENCY_PRIORITY = Object.freeze({ JMA: 0, JTWC: 1, HKO: 2, GDACS: 3, NHC: 4 });
const ALIAS_MATCH_MAX_DISTANCE_KM = 750;
const ALIAS_MATCH_MAX_AGE_MS = 18 * 60 * 60 * 1000;
const PROXIMITY_MATCH_MAX_DISTANCE_KM = 90;
const PROXIMITY_MATCH_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampTimestamp(value, fallback) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function normalizeAlias(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(?:typhoon|tropical\s+storm|tropical\s+depression|cyclone|storm)\s+/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function aliasesFor(observation) {
  return new Set([
    observation.stormName,
    ...(Array.isArray(observation.aliases) ? observation.aliases : []),
  ].map(normalizeAlias).filter(Boolean));
}

function haversineKm(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(a.lat - b.lat);
  const dLon = toRad(a.lon - b.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function validCoordinates(observation) {
  return Number.isFinite(observation?.lat) && Number.isFinite(observation?.lon)
    && observation.lat >= -90 && observation.lat <= 90
    && observation.lon >= -180 && observation.lon <= 180;
}

function agencyRank(agency) {
  return AGENCY_PRIORITY[String(agency || '').toUpperCase()] ?? 99;
}

function observationOrder(a, b) {
  return agencyRank(a.agency) - agencyRank(b.agency)
    || String(a.agency).localeCompare(String(b.agency))
    || String(a.agencyId).localeCompare(String(b.agencyId));
}

function normalizedObservation(input, now) {
  const lat = asFiniteNumber(input?.lat);
  const lon = asFiniteNumber(input?.lon);
  if (String(input?.basin || '').toUpperCase() !== 'WP' || lat == null || lon == null || !validCoordinates({ lat, lon })) return null;
  const observedAt = clampTimestamp(input.observedAt, now);
  const aliases = [...aliasesFor(input)];
  return {
    agency: String(input.agency || '').toUpperCase(),
    agencyId: String(input.agencyId || '').trim(),
    basin: 'WP',
    season: Number.isInteger(input.season) ? input.season : new Date(observedAt).getUTCFullYear(),
    aliases,
    stormName: String(input.stormName || input.name || '').trim(),
    lat,
    lon,
    observedAt,
    windKt: asFiniteNumber(input.windKt),
    windAveragingPeriodMinutes: Number.isInteger(input.windAveragingPeriodMinutes) && input.windAveragingPeriodMinutes > 0
      ? input.windAveragingPeriodMinutes
      : undefined,
    pressureMb: asFiniteNumber(input.pressureMb),
    classification: String(input.classification || '').trim(),
    sourceName: String(input.sourceName || input.agency || '').trim(),
    sourceUrl: String(input.sourceUrl || '').trim(),
    status: input.status === 'cancelled' ? 'cancelled' : 'active',
    sourceEventId: String(input.sourceEventId || '').trim(),
  };
}

function collapseAgencyObservations(observations) {
  const latestByAgencyIdentifier = new Map();
  for (const observation of observations) {
    const key = `${observation.agency}:${observation.agencyId}`;
    const existing = latestByAgencyIdentifier.get(key);
    if (!existing || observation.observedAt >= existing.observedAt) latestByAgencyIdentifier.set(key, observation);
  }
  return [...latestByAgencyIdentifier.values()].sort(observationOrder);
}

function matchObservations(left, right) {
  const ageMs = Math.abs(left.observedAt - right.observedAt);
  const distanceKm = haversineKm(left, right);
  const leftAliases = aliasesFor(left);
  const rightAliases = aliasesFor(right);
  const sharesAlias = [...leftAliases].some((alias) => rightAliases.has(alias));

  if (sharesAlias && ageMs <= ALIAS_MATCH_MAX_AGE_MS && distanceKm <= ALIAS_MATCH_MAX_DISTANCE_KM) {
    return 'alias-bounded';
  }

  // Proximity is a deliberately narrow fallback for unnamed source records only.
  // Named systems with different aliases must remain distinct even when adjacent.
  if (leftAliases.size === 0 && rightAliases.size === 0
    && ageMs <= PROXIMITY_MATCH_MAX_AGE_MS && distanceKm <= PROXIMITY_MATCH_MAX_DISTANCE_KM) {
    return 'proximity-bounded';
  }
  return null;
}

function canonicalIdFor(observations) {
  const authority = observations.find((observation) => observation.agency === 'JMA' && observation.agencyId)
    || observations.find((observation) => observation.agencyId)
    || observations[0];
  return `wp:${authority.season}:${authority.agency.toLowerCase()}:${authority.agencyId.toLowerCase()}`;
}

function toCanonicalCyclone(observations, confidence) {
  const active = observations.filter((observation) => observation.status !== 'cancelled');
  const primary = [...(active.length > 0 ? active : observations)].sort(observationOrder)[0];
  const allAliases = [...new Set(observations.flatMap((observation) => observation.aliases))].sort();
  return {
    id: `cyclone:${canonicalIdFor(observations)}`,
    canonicalId: canonicalIdFor(observations),
    matchingConfidence: confidence || 'single-source',
    basin: 'WP',
    season: primary.season,
    stormName: primary.stormName || observations.find((observation) => observation.stormName)?.stormName || '',
    canonicalAliases: allAliases,
    lat: primary.lat,
    lon: primary.lon,
    observedAt: primary.observedAt,
    windKt: primary.windKt,
    windAveragingPeriodMinutes: primary.windAveragingPeriodMinutes,
    pressureMb: primary.pressureMb,
    classification: primary.classification,
    sourceName: primary.sourceName,
    sourceUrl: primary.sourceUrl,
    closed: active.length === 0,
    agencyObservations: observations.map((observation) => ({
      agency: observation.agency,
      agencyId: observation.agencyId,
      observedAt: observation.observedAt,
      lat: observation.lat,
      lon: observation.lon,
      windKt: observation.windKt,
      windAveragingPeriodMinutes: observation.windAveragingPeriodMinutes,
      pressureMb: observation.pressureMb,
      classification: observation.classification,
      status: observation.status,
      sourceName: observation.sourceName,
      sourceUrl: observation.sourceUrl,
    })),
  };
}

export function canonicalizeWesternPacificCyclones(rawObservations, { now = Date.now() } = {}) {
  const observations = collapseAgencyObservations((Array.isArray(rawObservations) ? rawObservations : [])
    .map((input) => normalizedObservation(input, now))
    .filter(Boolean));
  const groups = [];

  for (const observation of observations) {
    let matched = null;
    for (const group of groups) {
      const confidence = group.observations
        .map((member) => matchObservations(member, observation))
        .find(Boolean);
      if (confidence) {
        matched = { group, confidence };
        break;
      }
    }
    if (matched) {
      matched.group.observations.push(observation);
      if (matched.group.confidence !== 'alias-bounded') matched.group.confidence = matched.confidence;
    } else {
      groups.push({ observations: [observation], confidence: 'single-source' });
    }
  }

  return groups
    .map((group) => toCanonicalCyclone(group.observations.sort(observationOrder), group.confidence))
    .sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
}

function warningStatus(actionCode) {
  return /cancel/i.test(String(actionCode || '')) ? 'cancelled' : 'active';
}

export function parseHkoWarningSummary(payload, { now = Date.now() } = {}) {
  const warning = payload?.WTCSGNL;
  if (!warning || typeof warning !== 'object') return [];
  const observedAt = clampTimestamp(warning.updateTime || warning.issueTime, now);
  return [{
    agency: 'HKO',
    agencyId: String(warning.code || 'WTCSGNL'),
    status: warningStatus(warning.actionCode),
    observedAt,
    sourceName: 'HKO',
    sourceUrl: HKO_WARNING_SOURCE_URL,
    title: `Hong Kong ${String(warning.name || 'Tropical Cyclone Warning Signal').trim()}`,
    description: String(warning.details || warning.contents || '').trim(),
    lat: HKO_COORDINATES.lat,
    lon: HKO_COORDINATES.lon,
  }];
}

async function readResponseLimited(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return JSON.parse(text);
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
}

export async function fetchApprovedJson(url, {
  allowedHosts,
  maxBytes = MAX_APPROVED_RESPONSE_BYTES,
  fetchFn = globalThis.fetch,
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const response = await fetchFn(parsed.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  return readResponseLimited(response, maxBytes);
}

function decision(entry, checkedAt) {
  return { ...entry, checkedAt };
}

export async function fetchHkoWarnings({ now = Date.now(), fetchFn = globalThis.fetch, onDecision = () => {} } = {}) {
  const checkedAt = new Date(now).toISOString();
  try {
    const payload = await fetchApprovedJson(HKO_WARNING_SUMMARY_URL, {
      allowedHosts: ['data.weather.gov.hk'],
      fetchFn,
    });
    const result = {
      warnings: parseHkoWarningSummary(payload, { now }),
      dataAvailable: true,
      sourceDecision: decision({ source: 'HKO warning summary', host: 'data.weather.gov.hk', status: 'accepted', reason: 'OK', optional: false, requestCount: 1 }, checkedAt),
    };
    onDecision(result.sourceDecision);
    return result;
  } catch (error) {
    const reason = Number.isInteger(error?.status) ? `HTTP_${error.status}` : String(error?.message || 'FETCH_FAILED');
    const result = {
      warnings: [],
      dataAvailable: false,
      sourceDecision: decision({ source: 'HKO warning summary', host: 'data.weather.gov.hk', status: 'blocked', reason, optional: false, requestCount: 1 }, checkedAt),
    };
    onDecision(result.sourceDecision);
    return result;
  }
}

export function buildWesternPacificCycloneSnapshot({ storms = [], hkoWarnings = [], hkoDataAvailable = true, sourceDecisions = [], now = Date.now() } = {}) {
  const cyclones = canonicalizeWesternPacificCyclones(storms, { now });
  const warnings = (Array.isArray(hkoWarnings) ? hkoWarnings : []).map((warning) => ({
    id: `hko-warning:${warning.agencyId}`,
    title: warning.title || 'Hong Kong Tropical Cyclone Warning Signal',
    description: warning.description || '',
    category: 'severeStorms',
    categoryTitle: 'Tropical Cyclone Warning',
    lat: warning.lat ?? HKO_COORDINATES.lat,
    lon: warning.lon ?? HKO_COORDINATES.lon,
    date: warning.observedAt ?? now,
    magnitude: 0,
    magnitudeUnit: '',
    sourceUrl: warning.sourceUrl || HKO_WARNING_SOURCE_URL,
    sourceName: 'HKO',
    closed: warning.status === 'cancelled',
    agencyObservations: [{
      agency: 'HKO', agencyId: warning.agencyId, observedAt: warning.observedAt ?? now,
      lat: warning.lat ?? HKO_COORDINATES.lat, lon: warning.lon ?? HKO_COORDINATES.lon,
      status: warning.status || 'active', sourceName: 'HKO', sourceUrl: warning.sourceUrl || HKO_WARNING_SOURCE_URL,
    }],
  }));
  const events = [
    ...cyclones.map((cyclone) => ({
      id: cyclone.id,
      title: `${cyclone.classification || 'Tropical Cyclone'} ${cyclone.stormName}`.trim(),
      description: `${cyclone.stormName || 'Unnamed tropical cyclone'} · ${cyclone.agencyObservations.length} agency observation${cyclone.agencyObservations.length === 1 ? '' : 's'}`,
      category: 'severeStorms',
      categoryTitle: 'Tropical Cyclone',
      lat: cyclone.lat, lon: cyclone.lon, date: cyclone.observedAt,
      magnitude: cyclone.windKt ?? 0, magnitudeUnit: cyclone.windKt == null ? '' : 'kt',
      sourceUrl: cyclone.sourceUrl, sourceName: cyclone.sourceName, closed: cyclone.closed,
      stormId: cyclone.canonicalId, stormName: cyclone.stormName, basin: cyclone.basin,
      classification: cyclone.classification, windKt: cyclone.windKt, pressureMb: cyclone.pressureMb,
      canonicalId: cyclone.canonicalId, matchingConfidence: cyclone.matchingConfidence,
      canonicalAliases: cyclone.canonicalAliases,
      windAveragingPeriodMinutes: cyclone.windAveragingPeriodMinutes,
      agencyObservations: cyclone.agencyObservations,
      forecastTrack: [], conePolygon: [], pastTrack: [],
    })),
    ...warnings,
  ];
  const latestObservationAt = events.reduce((latest, event) => Math.max(latest, Number(event.date) || 0), 0) || now;
  const checkedAt = new Date(now).toISOString();
  return {
    events,
    evaluatedAt: checkedAt,
    latestObservationAt,
    dataAvailable: hkoDataAvailable,
    sourceDecisions: [
      decision(JMA_PREFLIGHT_DECISION, checkedAt),
      decision(JTWC_PREFLIGHT_DECISION, checkedAt),
      ...sourceDecisions,
    ],
  };
}
