import { readBoundedJsonResponse } from '../_china-exchange-transport.mjs';
import { GRID_CLOCK_REGIONS } from '../shared/grid-disruption-clock.js';

const MASSOUTAGE_URL = 'https://massoutage.com/api/v1/live/summary';
const CAISO_URL = 'https://wwwmobile.caiso.com/TodaysOutlookApi/api/EmergencyNotices/v2/ActiveEvents';
const CAISO = { kind: 'grid', sourceName: 'California ISO', sourceUrl: 'https://www.caiso.com/emergency-notifications' };
const TVA = { kind: 'grid', sourceName: 'Tennessee Valley Authority', sourceUrl: 'https://www.tva.com/news-media/releases/press-release-archive' };
const HALF_HOUR = 30 * 60_000;

const pacificClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
});

function zonedMs(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/i.test(raw)) return NaN;
  return Date.parse(raw);
}

// CAISO names these fields _PT and does not include a UTC offset. Reject a
// missing or repeated local hour at the DST transition instead of guessing.
function pacificMs(raw) {
  const iso = typeof raw === 'string' && raw.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?$/)?.[1];
  if (!iso) return NaN;
  const candidates = ['-07:00', '-08:00'].map(offset => Date.parse(iso + offset));
  const valid = candidates.filter(ms => Number.isFinite(ms) && pacificClock.format(ms).replace(' ', 'T') === iso);
  return valid.length === 1 ? valid[0] : NaN;
}

function isRecent(time, nowMs) {
  return Number.isFinite(time) && time <= nowMs && nowMs - time <= HALF_HOUR;
}

function impactPoints(payload, nowMs) {
  const points = {};
  const { national, states } = payload?.data ?? {};
  const live = payload?.meta?.live;
  // as_of is the oldest regional contribution nationally. Never relabel it
  // as a precise measurement of this state's customers.
  const observedAt = zonedMs(national?.updated_at);
  const oldestAt = zonedMs(national?.as_of);
  if (live?.status !== 'ok' || typeof national?.stale !== 'boolean'
    || !Number.isSafeInteger(national.stale_out) || national.stale_out < 0
    || !isRecent(zonedMs(live.last_poll_ts), nowMs) || !Number.isFinite(oldestAt) || oldestAt > observedAt
    || !isRecent(observedAt, nowMs) || !Array.isArray(states)) return points;
  const partial = national.stale || national.stale_out > 0 || !isRecent(oldestAt, nowMs);

  for (const [code, { name, fips, slug }] of Object.entries(GRID_CLOCK_REGIONS)) {
    const rows = states.filter(row => row?.abbr === code);
    const row = rows[0];
    if (rows.length !== 1 || row.state_fips !== fips
      || !Number.isSafeInteger(row.customers_out) || row.customers_out < 0) continue;
    points[code] = {
      observedAt, customersOut: row.customers_out, customersTracked: null,
      coverageKey: 'massoutage:' + code,
      coverageLabel: 'Reporting utilities in ' + name + '. Statewide coverage is incomplete.',
      sourceName: 'MassOutage (massoutage.com)', sourceUrl: 'https://massoutage.com/' + slug,
      partial,
      detail: partial
        ? 'The national report includes older observations. It does not identify which states are affected.'
        : 'At the published aggregate time. The contributing utilities can change between reports.',
    };
  }
  return points;
}

function readWeather(payload, nowMs, source) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.pagination?.next
    || !isRecent(zonedMs(payload.updated), nowMs)) throw new Error('Incomplete NWS warning collection');
  const warnings = [];
  for (const feature of payload.features) {
    const p = feature?.properties;
    if (typeof p?.event !== 'string' || typeof p.status !== 'string' || typeof p.messageType !== 'string') {
      throw new Error('Invalid NWS warning properties');
    }
    if (p.status !== 'Actual' || !['Alert', 'Update'].includes(p.messageType)
      || !['Severe', 'Extreme'].includes(p.severity)
      || !/\b(?:Watch|Warning)\b/i.test(p.event)) continue;
    const issuedAt = zonedMs(p.sent);
    const expiresAt = Math.min(zonedMs(p.expires), p.ends ? zonedMs(p.ends) : Infinity);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw new Error('Undated NWS warning');
    if (issuedAt > nowMs || expiresAt <= nowMs) continue;
    const fullArea = typeof p.areaDesc === 'string' ? p.areaDesc.trim() : '';
    const area = fullArea.length > 115 ? fullArea.slice(0, 114).trimEnd() + '…' : fullArea;
    const title = p.event.slice(0, 100) + (area ? ' · ' + area : '');
    const url = typeof feature.id === 'string' && /^https:\/\/api\.weather\.gov\/alerts\/[a-zA-Z0-9.:%_-]+$/.test(feature.id)
      ? feature.id : source.sourceUrl;
    warnings.push({ ...source, title, issuedAt, expiresAt, sourceUrl: url });
  }
  return warnings;
}

function readCaiso(payload, nowMs) {
  const { CurrentEvents, UpcomingEvents, CurrentEventsCount, UpcommingEventsCount } = payload ?? {};
  if (!Array.isArray(CurrentEvents) || !Array.isArray(UpcomingEvents)
    || CurrentEvents.length !== CurrentEventsCount || UpcomingEvents.length !== UpcommingEventsCount) {
    throw new Error('Incomplete CAISO emergency event list');
  }
  const warnings = [];
  for (const event of [...CurrentEvents, ...UpcomingEvents]) {
    if (typeof event?.EventType !== 'string') throw new Error('Invalid CAISO event');
    if (!/^(?:EEA\s*(?:Watch|[123])|Energy Emergency Alert (?:Watch|[123])(?:\s*\(EEA\s*[123]\))?|Flex Alert|Transmission Emergency|Restricted Maintenance Operations)$/i.test(event.EventType)) continue;
    const expiresAt = pacificMs(event.EndDateTime_PT);
    const startsAt = pacificMs(event.StartDateTime_PT);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || startsAt >= expiresAt) throw new Error('Undated CAISO event');
    if (expiresAt <= nowMs) continue;
    const messages = event.EventMessages;
    if (!Array.isArray(messages) || !messages.length) throw new Error('Missing CAISO messages');
    const dates = messages.map(m => pacificMs(m?.PostDate_PT));
    if (!dates.every(date => Number.isFinite(date) && date <= nowMs)) throw new Error('Invalid CAISO publication time');
    const latest = messages[dates.indexOf(Math.max(...dates))];
    if (/^(?:end(?:ed)?|cancel(?:led|ed|lation)?)$/i.test(latest?.MessageType)) continue;
    if (!/^(?:initiation|start|update|extension|extended)$/i.test(latest?.MessageType)) {
      throw new Error('Unrecognized CAISO message type');
    }
    const issuedAt = Math.max(...dates);
    warnings.push({ ...CAISO, title: event.EventType + (startsAt > nowMs ? ' (upcoming)' : ''), issuedAt, expiresAt });
  }
  return warnings;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'WorldMonitor/1.0 (+https://www.worldmonitor.app)', Accept: 'application/geo+json, application/json' },
    signal: AbortSignal.timeout(12_000), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('HTTP ' + response.status);
  }
  return readBoundedJsonResponse(response, 2 * 1024 * 1024);
}

async function collectWarnings(source, fetchImpl, url, normalize, nowMs) {
  try {
    const warnings = normalize(await fetchJson(fetchImpl, url), nowMs, source);
    return { warnings, health: { ...source, checkedAt: nowMs, status: 'available' } };
  } catch (error) {
    console.warn('[grid-clock]', source.sourceName, error.message);
    return { warnings: [], health: { ...source, checkedAt: null, status: 'unavailable' } };
  }
}

export async function fetchGridClockSources({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const regionCodes = Object.keys(GRID_CLOCK_REGIONS);
  const [points, caiso, weather] = await Promise.all([
    fetchJson(fetchImpl, MASSOUTAGE_URL).then(payload => impactPoints(payload, nowMs)).catch(error => {
      console.warn('[grid-clock] MassOutage', error.message);
      return {};
    }),
    collectWarnings(CAISO, fetchImpl, CAISO_URL, readCaiso, nowMs),
    Promise.all(regionCodes.map(code => {
      const url = 'https://api.weather.gov/alerts/active?area=' + code + '&status=actual&severity=Severe,Extreme';
      const source = { kind: 'weather', sourceName: 'National Weather Service', sourceUrl: url };
      return collectWarnings(source, fetchImpl, url, readWeather, nowMs);
    })),
  ]);
  return regionCodes.map((code, idx) => {
    const grid = code === 'CA' ? caiso : code === 'TN'
      ? { warnings: [], health: { ...TVA, checkedAt: null, status: 'not_monitored' } } : null;
    const warningSources = [...(grid ? [grid.health] : []), weather[idx].health];
    return {
      code, current: points[code] ?? null,
      warnings: [...(grid?.warnings ?? []), ...weather[idx].warnings], warningSources,
      warningsCheckedAt: warningSources.some(source => source.status === 'unavailable') ? null : nowMs,
    };
  });
}
