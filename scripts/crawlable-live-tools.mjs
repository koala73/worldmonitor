const REQUEST_TIMEOUT_MS = 8_000;
const MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_LIVE_SNAPSHOT_AGE_MS = 48 * 60 * 60 * 1_000;
const MAX_AIRSPACE_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_RENDERED_ROWS = 5;

const SCORE_BANDS = [
  { min: 81, label: 'Critical' },
  { min: 66, label: 'High' },
  { min: 51, label: 'Elevated' },
  { min: 31, label: 'Normal' },
  { min: 0, label: 'Low' },
];

const ADVISORY_LABELS = {
  'do-not-travel': 'Do Not Travel',
  reconsider: 'Reconsider Travel',
  caution: 'Exercise Increased Caution',
  normal: 'Exercise Normal Precautions',
  info: 'Information Only',
};

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value);
}

function humanizeToken(value, prefixes = []) {
  let token = String(value || '').trim();
  for (const prefix of prefixes) {
    token = token.replace(new RegExp(`^${prefix}`, 'i'), '');
  }
  return token
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function validTimestamp(value, now = Date.now(), maxAgeMs = null) {
  const numeric = finiteNumber(value);
  const timestamp = numeric ?? (typeof value === 'string' ? Date.parse(value) : Number.NaN);
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp < MIN_VALID_TIMESTAMP_MS || timestamp > now + MAX_FUTURE_SKEW_MS) return null;
  if (maxAgeMs !== null && timestamp < now - maxAgeMs) return null;
  return timestamp;
}

function requireTimestamp(value, now, label, maxAgeMs = null) {
  const timestamp = validTimestamp(value, now, maxAgeMs);
  if (timestamp === null) throw new Error(`${label} timestamp is unavailable, stale, or invalid`);
  return timestamp;
}

export function instabilityBand(score) {
  const numeric = finiteNumber(score);
  if (numeric === null || numeric < 0 || numeric > 100) return null;
  return SCORE_BANDS.find((band) => numeric >= band.min)?.label ?? null;
}

export function formatAdvisory(value) {
  const token = String(value || '').trim().toLowerCase();
  if (ADVISORY_LABELS[token]) return ADVISORY_LABELS[token];
  const normalized = humanizeToken(token);
  return normalized || 'Not present';
}

export function formatTrend(dynamicScore, trend) {
  const delta = finiteNumber(dynamicScore);
  if (delta !== null) {
    if (delta > 0) return `Rising +${formatNumber(delta)}`;
    if (delta < 0) return `Falling ${formatNumber(delta)}`;
  }

  const normalized = humanizeToken(trend, ['TREND_DIRECTION_']);
  if (normalized && normalized !== 'Unspecified') return normalized;
  return 'Stable / unavailable';
}

export function liveRiskViewModel(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Country risk response is not an object');
  }
  if (payload.upstreamUnavailable === true) {
    throw new Error('Country risk upstream is temporarily unavailable');
  }

  const cii = payload.cii;
  const score = finiteNumber(cii?.combinedScore);
  const band = instabilityBand(score);
  const sanctionsCount = Math.max(0, finiteNumber(payload.sanctionsCount) ?? 0);
  const sanctions = sanctionsCount > 0
    ? `${formatNumber(sanctionsCount, 0)} designated ${sanctionsCount === 1 ? 'entity' : 'entities'}`
    : payload.sanctionsActive
      ? 'Active designations'
      : 'None in feed';

  if (score === null || band === null) {
    // No combined instability score — render a labelled partial result when
    // an independent sub-signal (advisory or sanctions feed) is present
    // instead of discarding the whole response. Fail closed only when the
    // response carries nothing at all.
    const hasSubSignal = String(payload.advisoryLevel || '').trim() !== ''
      || sanctionsCount > 0
      || payload.sanctionsActive === true;
    if (!hasSubSignal) {
      throw new Error('No current instability score is available for this country');
    }
    return {
      partial: true,
      score: null,
      band: null,
      trend: null,
      advisory: formatAdvisory(payload.advisoryLevel),
      sanctions,
      // Sub-signals are served live at request time; the payload timestamp
      // may be absent (fetchedAt: 0) when no CII was computed.
      computedAt: validTimestamp(
        finiteNumber(payload.fetchedAt) ?? finiteNumber(cii?.computedAt),
        now,
        MAX_LIVE_SNAPSHOT_AGE_MS,
      ),
      methodologyVersion: '',
    };
  }

  const computedAt = requireTimestamp(
    finiteNumber(payload.fetchedAt) ?? finiteNumber(cii?.computedAt),
    now,
    'Country risk',
    MAX_LIVE_SNAPSHOT_AGE_MS,
  );

  return {
    partial: false,
    score: formatNumber(score),
    band,
    trend: formatTrend(cii?.dynamicScore, cii?.trend),
    advisory: formatAdvisory(payload.advisoryLevel || cii?.advisoryLevel),
    sanctions,
    computedAt,
    methodologyVersion: String(cii?.methodologyVersion || '').trim(),
  };
}

function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const values = bounds.map(finiteNumber);
  if (values.some((value) => value === null)) return null;
  const [south, west, north, east] = values;
  if (south < -90 || north > 90 || south > north || west < -180 || west > 180 || east < -180 || east > 180) {
    return null;
  }
  return [south, west, north, east];
}

export function pointInBounds(lat, lon, bounds) {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lon);
  const normalized = normalizeBounds(bounds);
  if (latitude === null || longitude === null || !normalized) return false;
  const [south, west, north, east] = normalized;
  if (latitude < south || latitude > north) return false;
  return west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
}

export function chokepointStatusViewModel(payload, chokepointId, now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Chokepoint status response is not an object');
  }
  if (!Array.isArray(payload.chokepoints)) {
    throw new Error('Chokepoint status list is unavailable');
  }
  const row = payload.chokepoints.find((entry) => entry?.id === chokepointId);
  if (!row) throw new Error('Requested chokepoint is not present in the status response');

  const score = finiteNumber(row.disruptionScore);
  if (score === null || score < 0 || score > 100) {
    throw new Error('Chokepoint disruption score is unavailable');
  }
  const statusToken = String(row.status || '').trim().toLowerCase();
  if (!['green', 'yellow', 'red'].includes(statusToken)) {
    throw new Error('Chokepoint status is unavailable');
  }
  const status = humanizeToken(statusToken);
  const fetchedAt = requireTimestamp(
    payload.fetchedAt,
    now,
    'Chokepoint status',
    MAX_LIVE_SNAPSHOT_AGE_MS,
  );
  const activeWarnings = Math.max(0, nonNegativeNumber(row.activeWarnings) ?? 0);
  const aisDisruptions = Math.max(0, nonNegativeNumber(row.aisDisruptions) ?? 0);
  const transit = row.transitSummary;
  const transitAvailable = transit?.dataAvailable === true;
  const todayTotal = transitAvailable ? nonNegativeNumber(transit.todayTotal) : null;
  const weekMovement = transitAvailable ? finiteNumber(transit.wowChangePct) : null;

  return {
    disruptionScore: formatNumber(score, 0),
    status,
    congestion: humanizeToken(row.congestionLevel) || 'Not reported',
    warnings: `${formatNumber(activeWarnings, 0)} ${activeWarnings === 1 ? 'warning' : 'warnings'} · ${formatNumber(aisDisruptions, 0)} AIS ${aisDisruptions === 1 ? 'disruption' : 'disruptions'}`,
    description: String(row.description || '').trim() || 'No additional status note was supplied.',
    todayTransits: todayTotal === null ? null : formatNumber(todayTotal, 0),
    weekMovement: weekMovement === null
      ? null
      : `${weekMovement > 0 ? '+' : ''}${formatNumber(weekMovement)}% vs prior week`,
    fetchedAt,
    partial: payload.upstreamUnavailable === true || !transitAvailable || todayTotal === null,
  };
}

function crisisSummary(result, expectedCode, now) {
  const summary = result?.payload?.summary;
  if (!summary || typeof summary !== 'object') return null;
  if (String(summary.countryCode || '').toUpperCase() !== expectedCode) return null;
  const events = nonNegativeNumber(summary.conflictEventsTotal);
  const political = nonNegativeNumber(summary.conflictPoliticalViolenceEvents);
  const fatalities = nonNegativeNumber(summary.conflictFatalities);
  const demonstrations = nonNegativeNumber(summary.conflictDemonstrations);
  const referencePeriod = String(summary.referencePeriod || '').trim();
  const updatedAt = validTimestamp(summary.updatedAt, now, MAX_LIVE_SNAPSHOT_AGE_MS);
  if (
    events === null
    || political === null
    || fatalities === null
    || demonstrations === null
    || !referencePeriod
    || updatedAt === null
  ) {
    return null;
  }
  return {
    code: expectedCode,
    name: String(summary.countryName || '').trim(),
    events,
    political,
    fatalities,
    demonstrations,
    referencePeriod,
    updatedAt,
  };
}

export function crisisTrackerViewModel(results, countries, now = Date.now()) {
  if (!Array.isArray(results) || !Array.isArray(countries) || countries.length === 0) {
    throw new Error('Crisis coverage is unavailable');
  }

  const countryByCode = new Map(countries.map((country) => [
    String(country.code || '').toUpperCase(),
    String(country.name || country.code || '').trim(),
  ]));
  const rows = [];
  for (const result of results) {
    const code = String(result?.code || '').toUpperCase();
    if (!countryByCode.has(code)) continue;
    const summary = crisisSummary(result, code, now);
    if (summary) {
      rows.push({
        ...summary,
        name: summary.name || countryByCode.get(code),
      });
    }
  }
  if (rows.length === 0) throw new Error('No current crisis summaries are available');

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const validCodes = new Set(rows.map((row) => row.code));
  const missingCountries = [...countryByCode]
    .filter(([code]) => !validCodes.has(code))
    .map(([, name]) => name);
  const periods = new Set(rows.map((row) => row.referencePeriod));
  const samePeriod = periods.size === 1;
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);

  return {
    state: missingCountries.length === 0 && samePeriod ? 'ready' : 'partial',
    eventsTotal: samePeriod ? formatNumber(sum('events'), 0) : null,
    politicalViolenceEvents: samePeriod ? formatNumber(sum('political'), 0) : null,
    fatalities: samePeriod ? formatNumber(sum('fatalities'), 0) : null,
    demonstrations: samePeriod ? formatNumber(sum('demonstrations'), 0) : null,
    referencePeriod: samePeriod ? rows[0].referencePeriod : 'Mixed reference periods',
    updatedAt: Math.max(...rows.map((row) => row.updatedAt)),
    missingCountries,
    rows,
  };
}

export function hazardPulseViewModel(payload, { now = Date.now(), bounds = null } = {}) {
  if (!payload || typeof payload !== 'object' || payload.dataAvailable !== true) {
    throw new Error('Natural-hazard snapshot is unavailable');
  }
  const fetchedAt = requireTimestamp(
    payload.fetchedAt,
    now,
    'Natural-hazard snapshot',
    MAX_LIVE_SNAPSHOT_AGE_MS,
  );
  if (!Array.isArray(payload.events)) throw new Error('Natural-hazard events are unavailable');
  const normalizedBounds = bounds === null ? null : normalizeBounds(bounds);
  if (bounds !== null && !normalizedBounds) throw new Error('Country bounds are invalid');

  let malformedOpenEvents = 0;
  const events = payload.events
    .filter((event) => event && event.closed !== true)
    .map((event) => {
      const lat = finiteNumber(event.lat);
      const lon = finiteNumber(event.lon);
      if (lat === null || lon === null) {
        malformedOpenEvents += 1;
        return null;
      }
      if (normalizedBounds && !pointInBounds(lat, lon, normalizedBounds)) return null;
      const date = validTimestamp(event.date, now);
      if (date === null) {
        malformedOpenEvents += 1;
        return null;
      }
      const rawMagnitude = finiteNumber(event.magnitude);
      const magnitude = rawMagnitude !== null && rawMagnitude > 0 ? rawMagnitude : null;
      return {
        id: String(event.id || ''),
        title: String(event.title || '').trim() || 'Untitled event',
        category: String(event.categoryTitle || '').trim()
          || humanizeToken(event.category)
          || 'Other',
        date,
        magnitude,
        magnitudeUnit: String(event.magnitudeUnit || '').trim(),
        source: String(event.sourceName || '').trim() || 'Source not reported',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date - a.date);
  if (events.length === 0 && malformedOpenEvents > 0) {
    throw new Error('Natural-hazard observations are malformed');
  }

  const categoryCounts = new Map();
  for (const event of events) {
    categoryCounts.set(event.category, (categoryCounts.get(event.category) || 0) + 1);
  }
  const categories = [...categoryCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `${category} ${count}`)
    .join(' · ');
  const magnitudeEvents = events.filter((event) => event.magnitude !== null);
  const magnitudeDomains = new Set(
    magnitudeEvents.map((event) => `${event.category}::${event.magnitudeUnit}`),
  );
  const strongestEvent = magnitudeDomains.size <= 1
    ? [...magnitudeEvents].sort((a, b) => b.magnitude - a.magnitude)[0]
    : null;

  return {
    total: formatNumber(events.length, 0),
    categories: categories || 'No current matches',
    strongest: magnitudeDomains.size > 1
      ? 'Mixed units — see events'
      : strongestEvent
        ? `${formatNumber(strongestEvent.magnitude)}${strongestEvent.magnitudeUnit ? ` ${strongestEvent.magnitudeUnit}` : ''}`
        : 'Not reported',
    latestAt: events[0]?.date ?? null,
    fetchedAt,
    events: events.slice(0, MAX_RENDERED_ROWS),
  };
}

const AIRPORT_SEVERITY_RANK = {
  severe: 5,
  major: 4,
  moderate: 3,
  minor: 2,
  normal: 1,
  unknown: 0,
  unspecified: 0,
};

function airportSeverity(value) {
  const severity = humanizeToken(value, ['FLIGHT_DELAY_SEVERITY_']).toLowerCase();
  return Object.hasOwn(AIRPORT_SEVERITY_RANK, severity) ? severity : 'unknown';
}

export function airportDisruptionViewModel(payload, bounds, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.alerts) || payload.alerts.length === 0) {
    throw new Error('Airport coverage is unavailable');
  }
  const normalizedBounds = normalizeBounds(bounds);
  if (!normalizedBounds) throw new Error('Country bounds are invalid');
  const hasFreshCoverageAnywhere = payload.alerts.some((alert) => (
    validTimestamp(alert?.updatedAt, now, MAX_AIRSPACE_OBSERVATION_AGE_MS) !== null
  ));
  if (!hasFreshCoverageAnywhere) throw new Error('Airport coverage is unavailable');

  const matchingAlerts = payload.alerts
    .filter((alert) => {
      const lat = finiteNumber(alert?.location?.latitude);
      const lon = finiteNumber(alert?.location?.longitude);
      return lat !== null && lon !== null && pointInBounds(lat, lon, normalizedBounds);
    });
  const alerts = matchingAlerts
    .map((alert) => {
      const severity = airportSeverity(alert.severity);
      const updatedAt = validTimestamp(alert.updatedAt, now, MAX_AIRSPACE_OBSERVATION_AGE_MS);
      if (updatedAt === null) return null;
      return {
        iata: String(alert.iata || '').trim() || '—',
        name: String(alert.name || '').trim() || 'Monitored airport',
        severity,
        delayMinutes: Math.max(0, nonNegativeNumber(alert.avgDelayMinutes) ?? 0),
        reason: String(alert.reason || '').trim(),
        source: humanizeToken(alert.source, ['FLIGHT_DELAY_SOURCE_']) || 'Source not reported',
        updatedAt,
      };
    })
    .filter(Boolean);
  if (matchingAlerts.length > 0 && alerts.length === 0) {
    throw new Error('Airport coverage is unavailable');
  }

  const unknown = alerts.filter((alert) => alert.severity === 'unknown' || alert.severity === 'unspecified');
  const normal = alerts.filter((alert) => alert.severity === 'normal');
  const disrupted = alerts.filter((alert) => !['unknown', 'unspecified', 'normal'].includes(alert.severity));
  disrupted.sort((a, b) => (
    (AIRPORT_SEVERITY_RANK[b.severity] || 0) - (AIRPORT_SEVERITY_RANK[a.severity] || 0)
    || b.delayMinutes - a.delayMinutes
  ));

  return {
    monitored: formatNumber(alerts.length, 0),
    disrupted: formatNumber(disrupted.length, 0),
    normal: formatNumber(normal.length, 0),
    unknown: formatNumber(unknown.length, 0),
    updatedAt: alerts.length ? Math.max(...alerts.map((alert) => alert.updatedAt)) : null,
    alerts: disrupted.slice(0, MAX_RENDERED_ROWS),
  };
}

export function militaryFlightsViewModel(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.flights)) {
    throw new Error('Military-flight observations are unavailable');
  }
  const flights = payload.flights
    .map((flight) => {
      const lastSeenAt = validTimestamp(
        flight?.lastSeenAt,
        now,
        MAX_AIRSPACE_OBSERVATION_AGE_MS,
      );
      if (lastSeenAt === null) return null;
      return {
        id: String(flight.id || ''),
        callsign: String(flight.callsign || '').trim() || 'Callsign not reported',
        aircraftType: humanizeToken(flight.aircraftType, ['MILITARY_AIRCRAFT_TYPE_']) || 'Unknown',
        operator: humanizeToken(flight.operator, ['MILITARY_OPERATOR_']) || 'Operator not reported',
        lastSeenAt,
        interesting: flight.isInteresting === true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, 100);
  if (flights.length === 0) {
    throw new Error('Military-flight observations are unavailable');
  }

  return {
    returned: formatNumber(flights.length, 0),
    interesting: formatNumber(flights.filter((flight) => flight.interesting).length, 0),
    latestSeenAt: flights[0].lastSeenAt,
    flights: flights.slice(0, MAX_RENDERED_ROWS),
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  readJson = false,
) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let rejectCancellation;
  let cancelled = false;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (message, name) => {
    if (cancelled) return;
    cancelled = true;
    const error = new Error(message);
    error.name = name;
    controller.abort(error);
    rejectCancellation(error);
  };
  const abort = () => cancel('Live data request aborted', 'AbortError');
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(
    () => cancel(`Live data request timed out after ${timeoutMs}ms`, 'TimeoutError'),
    timeoutMs,
  );
  try {
    const operation = (async () => {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
        credentials: 'include',
      });
      const payload = readJson && response.ok ? await response.json() : null;
      return { response, payload };
    })();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

let anonymousSessionPromise = null;

async function ensureAnonymousSession(fetchImpl, timeoutMs) {
  if (!anonymousSessionPromise) {
    anonymousSessionPromise = fetchWithTimeout('/api/wm-session', {
      method: 'POST',
    }, fetchImpl, timeoutMs).then(({ response }) => {
      if (!response.ok) throw new Error(`Anonymous session request failed (${response.status})`);
    }).finally(() => {
      anonymousSessionPromise = null;
    });
  }
  return anonymousSessionPromise;
}

export async function requestLiveJson(
  url,
  { fetchImpl = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  let { response, payload } = await fetchWithTimeout(
    url,
    { signal },
    fetchImpl,
    timeoutMs,
    true,
  );
  if (response.status === 401) {
    await ensureAnonymousSession(fetchImpl, timeoutMs);
    ({ response, payload } = await fetchWithTimeout(
      url,
      { signal },
      fetchImpl,
      timeoutMs,
      true,
    ));
  }
  if (!response.ok) throw new Error(`Live data request failed (${response.status})`);
  return payload;
}

function setText(root, selector, value) {
  const element = root.querySelector(selector);
  if (element) element.textContent = value;
}

function formatDateTime(timestamp) {
  if (timestamp === null) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

function setTime(root, selector, timestamp, prefix) {
  const element = root.querySelector(selector);
  if (!element) return;
  if (timestamp === null) {
    element.textContent = `${prefix} time unavailable`;
    element.removeAttribute('datetime');
    return;
  }
  element.textContent = `${prefix} ${formatDateTime(timestamp)}`;
  element.setAttribute('datetime', new Date(timestamp).toISOString());
}

function setToolState(tool, state, status) {
  tool.dataset.state = state;
  setText(tool, '[data-live-status]', status);
  for (const busy of tool.querySelectorAll('[data-live-grid]')) {
    busy.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }
  for (const control of tool.querySelectorAll('[data-live-refresh]')) {
    control.disabled = state === 'loading';
  }
}

function renderList(root, selector, rows, formatter, emptyMessage = 'No current matches in this bounded result.') {
  const list = root.querySelector(selector);
  if (!list) return;
  const documentRoot = root.ownerDocument || document;
  list.replaceChildren();
  if (rows.length === 0) {
    const item = documentRoot.createElement('li');
    item.textContent = emptyMessage;
    list.append(item);
    return;
  }
  for (const row of rows) {
    const item = documentRoot.createElement('li');
    item.textContent = formatter(row);
    list.append(item);
  }
}

const requestStates = new WeakMap();

function beginToolRequest(tool) {
  const previous = requestStates.get(tool);
  previous?.controller.abort();
  const state = {
    controller: new AbortController(),
  };
  requestStates.set(tool, state);
  return state;
}

function isCurrentRequest(tool, state) {
  return requestStates.get(tool) === state && !state.controller.signal.aborted;
}

function cancelToolRequest(tool) {
  requestStates.get(tool)?.controller.abort();
  requestStates.delete(tool);
}

export async function runLatestToolRequest(tool, request, commit) {
  const state = beginToolRequest(tool);
  try {
    const result = await request(state.controller.signal);
    if (!isCurrentRequest(tool, state)) return false;
    await commit(result);
    return true;
  } catch (error) {
    if (!isCurrentRequest(tool, state)) return false;
    throw error;
  }
}

function selectedBounds(select) {
  const raw = select?.selectedOptions?.[0]?.dataset.bounds;
  if (!raw) return null;
  return normalizeBounds(raw.split(',').map(Number));
}

function updateCountryQuery(select, dashboardLink) {
  const code = String(select?.value || '').toUpperCase();
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('country', code);
  else url.searchParams.delete('country');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  if (dashboardLink) {
    // Keep conversion attribution on dynamically-rewritten dashboard links.
    dashboardLink.href = code
      ? `/?country=${encodeURIComponent(code)}&expanded=1&utm_source=seo-tool`
      : '/?utm_source=seo-tool';
  }
}

function dashboardLinkFor(tool) {
  return tool.querySelector('[data-dashboard-link]')
    || tool.ownerDocument?.querySelector('[data-dashboard-link]')
    || null;
}

function renderCountryRiskViewModel(tool, view) {
  setText(tool, '[data-live-score]', view.partial ? '—' : view.score);
  setText(tool, '[data-live-band]', view.partial ? 'No current score' : view.band);
  setText(tool, '[data-live-trend]', view.partial ? 'Unavailable' : view.trend);
  setText(tool, '[data-live-advisory]', view.advisory);
  setText(tool, '[data-live-sanctions]', view.sanctions);
  const updated = tool.querySelector('[data-live-updated]');
  if (updated) {
    if (view.partial) {
      updated.textContent = view.computedAt === null
        ? 'Advisory and sanctions signals retrieved live; no combined instability score for this country.'
        : `Retrieved ${formatDateTime(view.computedAt)} · no combined instability score for this country`;
      if (view.computedAt === null) updated.removeAttribute('datetime');
      else updated.setAttribute('datetime', new Date(view.computedAt).toISOString());
    } else {
      const methodology = view.methodologyVersion
        ? ` · methodology ${view.methodologyVersion}`
        : '';
      updated.textContent = `Computed ${formatDateTime(view.computedAt)}${methodology}`;
      updated.setAttribute('datetime', new Date(view.computedAt).toISOString());
    }
  }
  if (view.partial) setToolState(tool, 'partial', 'Partial API result');
  else setToolState(tool, 'ready', 'API result');
}

function renderCountryRiskError(tool) {
  setText(tool, '[data-live-score]', '—');
  setText(tool, '[data-live-band]', 'Unavailable');
  setText(tool, '[data-live-trend]', 'Unavailable');
  setText(tool, '[data-live-advisory]', 'Unavailable');
  setText(tool, '[data-live-sanctions]', 'Unavailable');
  setText(
    tool,
    '[data-live-updated]',
    'The live signal could not be loaded. The dated structural snapshot below remains available.',
  );
  tool.querySelector('[data-live-updated]')?.removeAttribute('datetime');
  setToolState(tool, 'error', 'Temporarily unavailable');
}

async function loadCountryRisk(tool) {
  const countryCode = String(tool.dataset.countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    cancelToolRequest(tool);
    renderCountryRiskError(tool);
    return;
  }

  setToolState(tool, 'loading', 'Connecting…');
  try {
    await runLatestToolRequest(
      tool,
      async (signal) => {
        const payload = await requestLiveJson(
          `/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(countryCode)}`,
          { signal },
        );
        return liveRiskViewModel(payload);
      },
      (view) => renderCountryRiskViewModel(tool, view),
    );
  } catch {
    renderCountryRiskError(tool);
  }
}

async function loadChokepoint(tool) {
  const state = beginToolRequest(tool);
  const id = String(tool.dataset.chokepointId || '');
  setToolState(tool, 'loading', 'Connecting…');
  try {
    const payload = await requestLiveJson('/api/supply-chain/v1/get-chokepoint-status', {
      signal: state.controller.signal,
    });
    const view = chokepointStatusViewModel(payload, id);
    if (!isCurrentRequest(tool, state)) return;
    setText(tool, '[data-chokepoint-score]', view.disruptionScore);
    setText(tool, '[data-chokepoint-band]', view.status);
    setText(tool, '[data-chokepoint-congestion]', view.congestion);
    setText(tool, '[data-chokepoint-warnings]', view.warnings);
    setText(tool, '[data-chokepoint-transits]', view.todayTransits ?? 'Unavailable');
    setText(tool, '[data-chokepoint-movement]', view.weekMovement ?? 'Unavailable');
    setText(tool, '[data-chokepoint-description]', view.description);
    setTime(tool, '[data-live-updated]', view.fetchedAt, 'Snapshot');
    setToolState(tool, view.partial ? 'partial' : 'ready', view.partial ? 'Partial API result' : 'API result');
  } catch {
    if (!isCurrentRequest(tool, state)) return;
    setText(tool, '[data-chokepoint-score]', '—');
    setText(tool, '[data-chokepoint-band]', 'Unavailable');
    setText(tool, '[data-chokepoint-congestion]', 'Unavailable');
    setText(tool, '[data-chokepoint-warnings]', 'Unavailable');
    setText(tool, '[data-chokepoint-transits]', 'Unavailable');
    setText(tool, '[data-chokepoint-movement]', 'Unavailable');
    setText(tool, '[data-chokepoint-description]', 'The live status could not be loaded. Static waterway context remains available below.');
    setTime(tool, '[data-live-updated]', null, 'Snapshot');
    setToolState(tool, 'error', 'Temporarily unavailable');
  }
}

async function loadCrisis(tool) {
  const state = beginToolRequest(tool);
  const countries = [...tool.querySelectorAll('[data-crisis-country]')].map((row) => ({
    code: String(row.dataset.countryCode || '').toUpperCase(),
    name: String(row.dataset.countryName || row.dataset.countryCode || ''),
  }));
  setToolState(tool, 'loading', 'Connecting…');
  try {
    const settled = await Promise.allSettled(countries.map(async (country) => ({
      code: country.code,
      payload: await requestLiveJson(
        `/api/conflict/v1/get-humanitarian-summary?country_code=${encodeURIComponent(country.code)}`,
        { signal: state.controller.signal },
      ),
    })));
    const results = settled.map((result, index) => (
      result.status === 'fulfilled'
        ? result.value
        : { code: countries[index].code, error: result.reason }
    ));
    const view = crisisTrackerViewModel(results, countries);
    if (!isCurrentRequest(tool, state)) return;
    setText(tool, '[data-crisis-events]', view.eventsTotal ?? 'See countries');
    setText(tool, '[data-crisis-fatalities]', view.fatalities ?? 'See countries');
    setText(tool, '[data-crisis-political]', view.politicalViolenceEvents ?? 'See countries');
    setText(tool, '[data-crisis-period]', view.referencePeriod);
    setText(
      tool,
      '[data-crisis-coverage]',
      view.missingCountries.length
        ? `Unavailable: ${view.missingCountries.join(', ')}`
        : `${view.rows.length} ${view.rows.length === 1 ? 'country' : 'countries'} available`,
    );
    for (const row of tool.querySelectorAll('[data-crisis-country]')) {
      const result = view.rows.find((entry) => entry.code === row.dataset.countryCode);
      setText(
        row,
        '[data-crisis-country-value]',
        result
          ? `${formatNumber(result.events, 0)} events · ${formatNumber(result.fatalities, 0)} fatalities · ${result.referencePeriod}`
          : 'Unavailable',
      );
    }
    setTime(tool, '[data-live-updated]', view.updatedAt, 'Retrieved');
    setToolState(tool, view.state, view.state === 'partial' ? 'Partial API result' : 'API result');
  } catch {
    if (!isCurrentRequest(tool, state)) return;
    setText(tool, '[data-crisis-events]', '—');
    setText(tool, '[data-crisis-fatalities]', '—');
    setText(tool, '[data-crisis-political]', '—');
    setText(tool, '[data-crisis-period]', 'Unavailable');
    setText(tool, '[data-crisis-coverage]', 'No country summaries available');
    for (const row of tool.querySelectorAll('[data-crisis-country-value]')) row.textContent = 'Unavailable';
    setTime(tool, '[data-live-updated]', null, 'Retrieved');
    setToolState(tool, 'error', 'Temporarily unavailable');
  }
}

export async function loadHazards(tool) {
  const select = tool.querySelector('[data-country-select]');
  const bounds = selectedBounds(select);
  const selectedCode = String(select?.value || '');
  if (selectedCode && !bounds) {
    cancelToolRequest(tool);
    setToolState(tool, 'error', 'Unsupported country');
    return;
  }
  updateCountryQuery(select, dashboardLinkFor(tool));
  setToolState(tool, 'loading', 'Connecting…');
  try {
    await runLatestToolRequest(
      tool,
      async (signal) => {
        const payload = await requestLiveJson('/api/natural/v1/list-natural-events', {
          signal,
        });
        return hazardPulseViewModel(payload, { bounds });
      },
      (view) => {
        setText(tool, '[data-hazard-total]', view.total);
        setText(tool, '[data-hazard-categories]', view.categories);
        setText(tool, '[data-hazard-strongest]', view.strongest);
        setText(tool, '[data-hazard-latest]', view.latestAt ? formatDateTime(view.latestAt) : 'No current matches');
        renderList(tool, '[data-hazard-list]', view.events, (event) => (
          `${event.title} · ${event.category} · ${event.source} · ${formatDateTime(event.date)}`
        ));
        setTime(tool, '[data-live-updated]', view.fetchedAt, 'Snapshot');
        setToolState(tool, 'ready', 'API result');
      },
    );
  } catch {
    setText(tool, '[data-hazard-total]', '—');
    setText(tool, '[data-hazard-categories]', 'Unavailable');
    setText(tool, '[data-hazard-strongest]', 'Unavailable');
    setText(tool, '[data-hazard-latest]', 'Unavailable');
    renderList(tool, '[data-hazard-list]', [], () => '', 'Live event list unavailable.');
    setTime(tool, '[data-live-updated]', null, 'Snapshot');
    setToolState(tool, 'error', 'Temporarily unavailable');
  }
}

function renderAirspaceSectionError(tool, section) {
  setText(tool, `[data-${section}-state]`, 'Unavailable');
  if (section === 'airport') {
    setText(tool, '[data-airport-monitored]', '—');
    setText(tool, '[data-airport-disrupted]', '—');
    setText(tool, '[data-airport-normal]', '—');
    setText(tool, '[data-airport-unknown]', '—');
    renderList(
      tool,
      '[data-airport-list]',
      [],
      () => '',
      'Live airport coverage unavailable.',
    );
    setTime(tool, '[data-airport-updated]', null, 'Latest monitored update');
  } else {
    setText(tool, '[data-military-returned]', '—');
    setText(tool, '[data-military-interesting]', '—');
    renderList(
      tool,
      '[data-military-list]',
      [],
      () => '',
      'Live military-flight observations unavailable.',
    );
    setTime(tool, '[data-military-updated]', null, 'Latest returned observation');
  }
}

async function loadAirspace(tool) {
  const select = tool.querySelector('[data-country-select]');
  const bounds = selectedBounds(select);
  if (!bounds) {
    cancelToolRequest(tool);
    setToolState(tool, 'error', 'Choose a supported country');
    return;
  }
  const [south, west, north, east] = bounds;
  setToolState(tool, 'loading', 'Connecting…');
  const airportUrl = '/api/aviation/v1/list-airport-delays';
  const militaryUrl = `/api/military/v1/list-military-flights?sw_lat=${encodeURIComponent(south)}&sw_lon=${encodeURIComponent(west)}&ne_lat=${encodeURIComponent(north)}&ne_lon=${encodeURIComponent(east)}&page_size=100`;
  await runLatestToolRequest(
    tool,
    async (signal) => Promise.allSettled([
      requestLiveJson(airportUrl, { signal }),
      requestLiveJson(militaryUrl, { signal }),
    ]),
    ([airportResult, militaryResult]) => {
      let readySections = 0;
      if (airportResult.status === 'fulfilled') {
        try {
          const view = airportDisruptionViewModel(airportResult.value, bounds);
          setText(tool, '[data-airport-monitored]', view.monitored);
          setText(tool, '[data-airport-disrupted]', view.disrupted);
          setText(tool, '[data-airport-normal]', view.normal);
          setText(tool, '[data-airport-unknown]', view.unknown);
          setText(tool, '[data-airport-state]', 'Available');
          setTime(tool, '[data-airport-updated]', view.updatedAt, 'Latest monitored update');
          renderList(tool, '[data-airport-list]', view.alerts, (alert) => (
            `${alert.iata} · ${humanizeToken(alert.severity)}${alert.delayMinutes ? ` · ${formatNumber(alert.delayMinutes, 0)} min` : ''}${alert.reason ? ` · ${alert.reason}` : ''} · ${alert.source}`
          ));
          readySections += 1;
        } catch {
          renderAirspaceSectionError(tool, 'airport');
        }
      } else {
        renderAirspaceSectionError(tool, 'airport');
      }

      if (militaryResult.status === 'fulfilled') {
        try {
          const view = militaryFlightsViewModel(militaryResult.value);
          setText(tool, '[data-military-returned]', view.returned);
          setText(tool, '[data-military-interesting]', view.interesting);
          setText(tool, '[data-military-state]', 'Available');
          setTime(tool, '[data-military-updated]', view.latestSeenAt, 'Latest returned observation');
          renderList(tool, '[data-military-list]', view.flights, (flight) => (
            `${flight.callsign} · ${flight.aircraftType} · ${flight.operator} · ${formatDateTime(flight.lastSeenAt)}`
          ));
          readySections += 1;
        } catch {
          renderAirspaceSectionError(tool, 'military');
        }
      } else {
        renderAirspaceSectionError(tool, 'military');
      }

      updateCountryQuery(select, dashboardLinkFor(tool));
      if (readySections === 2) setToolState(tool, 'ready', 'API results');
      else if (readySections === 1) setToolState(tool, 'partial', 'Partial API result');
      else setToolState(tool, 'error', 'Temporarily unavailable');
    },
  );
}

function applyInitialCountrySelection(tool) {
  const select = tool.querySelector('[data-country-select]');
  if (!select) return;
  const requested = new URL(window.location.href).searchParams.get('country')?.toUpperCase();
  if (requested && [...select.options].some((option) => option.value === requested)) {
    select.value = requested;
  }
}

export function initLiveTools(root = document) {
  for (const tool of root.querySelectorAll('[data-live-country-risk]')) {
    tool.querySelector('[data-live-refresh]')?.addEventListener('click', () => loadCountryRisk(tool));
    void loadCountryRisk(tool);
  }
  for (const tool of root.querySelectorAll('[data-live-chokepoint]')) {
    tool.querySelector('[data-live-refresh]')?.addEventListener('click', () => loadChokepoint(tool));
    void loadChokepoint(tool);
  }
  for (const tool of root.querySelectorAll('[data-live-crisis]')) {
    tool.querySelector('[data-live-refresh]')?.addEventListener('click', () => loadCrisis(tool));
    void loadCrisis(tool);
  }
  for (const tool of root.querySelectorAll('[data-natural-hazard-tool]')) {
    applyInitialCountrySelection(tool);
    tool.querySelector('[data-country-select]')?.addEventListener('change', () => loadHazards(tool));
    tool.querySelector('[data-live-refresh]')?.addEventListener('click', () => loadHazards(tool));
    void loadHazards(tool);
  }
  for (const tool of root.querySelectorAll('[data-airspace-tool]')) {
    applyInitialCountrySelection(tool);
    tool.querySelector('[data-country-select]')?.addEventListener('change', () => loadAirspace(tool));
    tool.querySelector('[data-live-refresh]')?.addEventListener('click', () => loadAirspace(tool));
    void loadAirspace(tool);
  }
}

if (typeof document !== 'undefined') {
  initLiveTools();
}
