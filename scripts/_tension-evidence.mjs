// Non-news evidence for the GDELT tension pairs: per pair, a handful of
// counts from feeds the dashboard already seeds, each compared with its usual
// level over the same window. The GDELT score never reads these; the popup
// shows the notable ones beside it.

export const TENSION_EVIDENCE_KEY = 'intelligence:tension-evidence:v1';
export const TENSION_EVIDENCE_ACTIVATION_KEY = 'seed-activated:intelligence:tension-evidence';
export const TENSION_EVIDENCE_COMPLETION_META_KEY = 'seed-completion:intelligence:tension-evidence';
export const HISTORY_DAYS = 90;
export const NOTABLE_RATIO = 1.5;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FUTURE_SKEW_MS = 5 * MIN;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// maxAgeMin mirrors each source's SEED_META budget in api/health.js.
export const SOURCES = {
  strikeEvents: { key: 'conflict:iran-events:v1', metaKey: 'seed-meta:conflict:iran-events', maxAgeMin: 45 },
  strikeTally: { key: 'conflict:strike-pressure:v1', metaKey: 'seed-meta:conflict:strike-pressure', maxAgeMin: 45 },
  airportDelays: { key: 'aviation:delays:intl:v3', metaKey: 'seed-meta:aviation:intl', maxAgeMin: 90 },
  notamClosures: { key: 'aviation:notam:closures:v2', metaKey: 'seed-meta:aviation:notam', maxAgeMin: 240 },
  surgeHistory: { key: 'military:surges:history:v1', metaKey: 'seed-meta:military-surges', maxAgeMin: 30 },
  crossStrait: {
    key: 'military:cross-strait-activity-bootstrap:v1',
    metaKey: 'seed-meta:military:cross-strait-activity-bootstrap',
    maxAgeMin: 720,
  },
  sanctions: { key: 'sanctions:changes:v1', metaKey: 'seed-meta:sanctions:changes', maxAgeMin: 720 },
};

// Key order is display order. A channel is notable when it reaches minValue
// and is at least NOTABLE_RATIO times its usual level; an intrinsic channel
// with no usual level yet is notable on minValue alone. merge says how two
// readings of the same UTC day combine in the history.
export const CHANNELS = {
  strikes: { minValue: 3, intrinsic: false, merge: 'replace' },
  airports: { minValue: 1, intrinsic: true, merge: 'max' },
  military_aircraft: {
    minValue: 6,
    intrinsic: false,
    merge: 'max',
    // byCountry keys are seed-military-flights operatorCountry values.
    operatorSpelling: { US: 'USA', IL: 'Israel', CN: 'China', RU: 'Russia', SA: 'Saudi Arabia' },
  },
  pla_aircraft: { minValue: 20, intrinsic: false, merge: 'replace' },
  pla_ships: { minValue: 10, intrinsic: false, merge: 'replace' },
  sanctions: { minValue: 3, intrinsic: false, merge: 'replace' },
};

const GCC = ['SA', 'AE', 'QA', 'KW', 'BH', 'OM'];

// Theaters overlap: iran-theater contains israel-gaza-theater and
// taiwan-theater overlaps south-china-sea, so each pair reads one theater per
// region to count an aircraft once.
export const PAIR_EVIDENCE = {
  usa_russia: {
    military_aircraft: { theaters: ['baltic-theater', 'blacksea-theater'], operator: 'US' },
    sanctions: { countries: ['RU'] },
  },
  russia_ukraine: {
    airports: { countries: ['RU'] },
    military_aircraft: { theaters: ['blacksea-theater'], operator: 'RU' },
  },
  usa_china: {
    military_aircraft: { theaters: ['taiwan-theater'], operator: 'US' },
    sanctions: { countries: ['CN'] },
  },
  china_taiwan: {
    airports: { countries: ['TW'] },
    military_aircraft: { theaters: ['taiwan-theater'], operator: 'CN' },
    pla_aircraft: {},
    pla_ships: {},
  },
  usa_iran: {
    airports: { countries: ['IR'] },
    military_aircraft: { theaters: ['iran-theater'], operator: 'US' },
    sanctions: { countries: ['IR'] },
  },
  israel_iran: {
    strikes: { countries: ['IL', 'IR'] },
    airports: { countries: ['IL', 'IR'] },
    military_aircraft: { theaters: ['iran-theater'], operator: 'IL' },
  },
  iran_gcc: {
    strikes: { countries: GCC },
    airports: { countries: [...GCC, 'IR'] },
  },
  saudi_arabia_yemen: {
    strikes: { countries: ['SA', 'YE'] },
    airports: { countries: ['SA', 'YE'] },
    military_aircraft: { theaters: ['yemen-redsea-theater'], operator: 'SA' },
  },
};

// The monitored airports (scripts/seed-aviation.mjs AIRPORTS) in the pair
// countries, named by city for the popup.
export const AIRPORTS = {
  OERK: { country: 'SA', name: 'Riyadh' },
  OEJN: { country: 'SA', name: 'Jeddah' },
  OEMA: { country: 'SA', name: 'Medina' },
  OEDF: { country: 'SA', name: 'Dammam' },
  OMDB: { country: 'AE', name: 'Dubai' },
  OMAA: { country: 'AE', name: 'Abu Dhabi' },
  OMSJ: { country: 'AE', name: 'Sharjah' },
  OMDW: { country: 'AE', name: 'Dubai Al Maktoum' },
  OTHH: { country: 'QA', name: 'Doha' },
  OKBK: { country: 'KW', name: 'Kuwait City' },
  OBBI: { country: 'BH', name: 'Manama' },
  OOMS: { country: 'OM', name: 'Muscat' },
  OIIE: { country: 'IR', name: 'Tehran Imam Khomeini' },
  OIII: { country: 'IR', name: 'Tehran Mehrabad' },
  OISS: { country: 'IR', name: 'Shiraz' },
  OIMM: { country: 'IR', name: 'Mashhad' },
  OIKB: { country: 'IR', name: 'Bandar Abbas' },
  OIFM: { country: 'IR', name: 'Isfahan' },
  OYSN: { country: 'YE', name: "Sana'a" },
  OYAA: { country: 'YE', name: 'Aden' },
  LLBG: { country: 'IL', name: 'Tel Aviv' },
  RCTP: { country: 'TW', name: 'Taipei' },
  UUEE: { country: 'RU', name: 'Moscow' },
};

const AIRPORT_STATUSES = ['closed', 'halted', 'restricted'];
// aviationstack: closure = at least 80% of due flights cancelled, ground stop =
// at least 50% (seed-aviation.mjs).
const DELAY_STATUS = { FLIGHT_DELAY_TYPE_CLOSURE: 'closed', FLIGHT_DELAY_TYPE_GROUND_STOP: 'halted' };

// The strike tally's severity layout (PRESSURE_SEVERITIES in
// scripts/lib/middle-east-strikes.cjs); events outside it are not tallied.
export const STRIKE_SEVERITIES = ['critical', 'high', 'elevated', 'moderate'];
// The strike feed keeps only its newest MAX_EVENTS events across all countries.
export const STRIKE_FEED_CAP = 400;
const STRIKE_WINDOW_MS = 72 * HOUR;
const STRIKE_WINDOW_DAYS = 3;
const STRIKE_MIN_PRIOR_DAYS = 7;

const AIRPORT_MIN_PRIOR_DAYS = 7;
const SURGE_MIN_PRIOR_SNAPSHOTS = 12;
const CROSS_STRAIT_MAX_REPORT_AGE_DAYS = 2;
const CROSS_STRAIT_CATEGORIES = { pla_aircraft: 'plaAircraftSorties', pla_ships: 'planShips' };

const SANCTIONS_WINDOW_MS = 7 * DAY;
const SANCTIONS_MIN_PRIOR_MS = 21 * DAY;
const SANCTIONS_LOOKBACK_MS = HISTORY_DAYS * DAY;
const isUsList = list => list === 'SDN' || list === 'CONSOLIDATED' || (typeof list === 'string' && list.startsWith('CSL-'));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isFinite(value) && value >= 0;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const round2 = value => Math.round(value * 100) / 100;
const sum = values => values.reduce((total, n) => total + n, 0);

function pairsWith(channel) {
  return Object.entries(PAIR_EVIDENCE).filter(([, channels]) => channel in channels);
}

function usableSource(sources, name, nowMs) {
  const source = sources?.[name];
  if (!isRecord(source) || !isRecord(source.data) || !Number.isFinite(source.fetchedAt)) return null;
  const age = nowMs - source.fetchedAt;
  if (age > SOURCES[name].maxAgeMin * MIN || age < -FUTURE_SKEW_MS) return null;
  return source;
}

function setDay(days, date, pairId, value) {
  (days[date] ??= {})[pairId] = value;
}

function strikes(sources, _history, nowMs) {
  const feed = usableSource(sources, 'strikeEvents', nowMs);
  const tally = usableSource(sources, 'strikeTally', nowMs);
  if (!feed || !tally || !Array.isArray(feed.data.events) || !isRecord(tally.data.days)) return null;
  const windowStart = nowMs - STRIKE_WINDOW_MS;
  const events = feed.data.events;
  // A full feed whose oldest event is inside the window has dropped older
  // strikes from it, so its count would read low in exactly the busy periods.
  const truncated = events.length >= STRIKE_FEED_CAP
    && events.every(event => Number.isFinite(event?.timestamp) && event.timestamp >= windowStart);
  const recent = new Map();
  for (const event of events) {
    const ts = event?.timestamp;
    if (!Number.isFinite(ts) || ts < windowStart || ts > nowMs + FUTURE_SKEW_MS) continue;
    if (!STRIKE_SEVERITIES.includes(event.severity) || typeof event.countryCode !== 'string') continue;
    recent.set(event.countryCode, (recent.get(event.countryCode) ?? 0) + 1);
  }
  const tallyDays = tally.data.days;
  const dayCount = (date, countries) => sum(countries.map(cc => {
    const counts = tallyDays[date]?.[cc];
    return Array.isArray(counts) && counts.every(isCount) ? sum(counts) : 0;
  }));
  // The tally stores only days with strikes, so the usual rate counts every
  // calendar day from its first stored day to the start of the live window.
  const windowStartDay = utcDay(windowStart);
  const priorDates = Object.keys(tallyDays).filter(date => DATE_RE.test(date) && date < windowStartDay).sort();
  const priorSpan = priorDates.length ? (Date.parse(windowStartDay) - Date.parse(priorDates[0])) / DAY : 0;
  // Every day the tally still holds is recorded, so a run that was missed or a
  // later correction upstream is repaired from the tally.
  const recordDates = new Set([
    ...Object.keys(tallyDays).filter(date => DATE_RE.test(date) && date <= utcDay(nowMs)),
    utcDay(nowMs - DAY),
    utcDay(nowMs),
  ]);
  const pairs = {};
  const days = {};
  for (const [pairId, { strikes: { countries } }] of pairsWith('strikes')) {
    for (const date of recordDates) setDay(days, date, pairId, dayCount(date, countries));
    if (truncated) continue;
    const baseline = priorSpan >= STRIKE_MIN_PRIOR_DAYS
      ? round2(STRIKE_WINDOW_DAYS * sum(priorDates.map(date => dayCount(date, countries))) / priorSpan)
      : null;
    const hit = countries
      .map((cc, order) => ({ cc, order, n: recent.get(cc) ?? 0 }))
      .filter(entry => entry.n > 0)
      .sort((a, b) => b.n - a.n || a.order - b.order);
    pairs[pairId] = { value: sum(hit.map(entry => entry.n)), baseline, countries: hit.map(entry => entry.cc), airports: [] };
  }
  return { observedAt: Math.min(feed.fetchedAt, tally.fetchedAt), pairs, days };
}

function airports(sources, history, nowMs) {
  const delays = usableSource(sources, 'airportDelays', nowMs);
  const notam = usableSource(sources, 'notamClosures', nowMs);
  const delayAlerts = Array.isArray(delays?.data.alerts) ? delays.data.alerts : null;
  const notamUsable = notam && Array.isArray(notam.data.closedIcaos) && Array.isArray(notam.data.restrictedIcaos);
  if (!delayAlerts && !notamUsable) return null;
  const status = new Map();
  const mark = (icao, next) => {
    if (!(icao in AIRPORTS)) return;
    const current = status.get(icao);
    if (!current || AIRPORT_STATUSES.indexOf(next) < AIRPORT_STATUSES.indexOf(current)) status.set(icao, next);
  };
  for (const alert of delayAlerts ?? []) {
    const next = DELAY_STATUS[alert?.delayType];
    if (next) mark(alert.icao, next);
  }
  if (notamUsable) {
    for (const icao of notam.data.closedIcaos) mark(icao, 'closed');
    for (const icao of notam.data.restrictedIcaos) mark(icao, 'restricted');
  }
  const today = utcDay(nowMs);
  const pairs = {};
  const days = {};
  for (const [pairId, { airports: { countries } }] of pairsWith('airports')) {
    const listed = Object.entries(AIRPORTS)
      .filter(([icao, airport]) => countries.includes(airport.country) && status.has(icao))
      .map(([icao, airport]) => ({ name: airport.name, status: status.get(icao) }))
      .sort((a, b) => AIRPORT_STATUSES.indexOf(a.status) - AIRPORT_STATUSES.indexOf(b.status));
    const prior = Object.entries(history)
      .filter(([date, byPair]) => date < today && isCount(byPair?.[pairId]?.airports))
      .map(([, byPair]) => byPair[pairId].airports);
    pairs[pairId] = {
      value: listed.length,
      baseline: prior.length >= AIRPORT_MIN_PRIOR_DAYS ? round2(sum(prior) / prior.length) : null,
      countries: [],
      airports: listed,
    };
    setDay(days, today, pairId, listed.length);
  }
  const used = [delayAlerts && delays, notamUsable && notam].filter(Boolean);
  return { observedAt: Math.min(...used.map(source => source.fetchedAt)), pairs, days };
}

function militaryAircraft(sources, _history, nowMs) {
  const source = usableSource(sources, 'surgeHistory', nowMs);
  const snapshots = Array.isArray(source?.data.history)
    ? source.data.history.filter(s => Number.isFinite(s?.assessedAt) && Array.isArray(s.theaters))
    : [];
  const latest = snapshots.at(-1);
  if (!latest || nowMs - latest.assessedAt > SOURCES.surgeHistory.maxAgeMin * MIN) return null;
  // A feed switch (opensky, adsb.lol) changes what is visible, so only
  // snapshots from the latest snapshot's feed are compared.
  const sameFeed = snapshots.filter(s => s.sourceVersion === latest.sourceVersion);
  const count = (snapshot, { theaters, operator }) => {
    const spelling = CHANNELS.military_aircraft.operatorSpelling[operator];
    return sum(snapshot.theaters
      .filter(theater => theaters.includes(theater?.theaterId))
      .map(theater => theater.byCountry?.[spelling])
      .filter(isCount));
  };
  const pairs = {};
  const days = {};
  for (const [pairId, { military_aircraft: params }] of pairsWith('military_aircraft')) {
    const prior = sameFeed.slice(0, -1).map(snapshot => count(snapshot, params));
    pairs[pairId] = {
      value: count(latest, params),
      baseline: prior.length >= SURGE_MIN_PRIOR_SNAPSHOTS ? round2(sum(prior) / prior.length) : null,
      countries: [params.operator],
      airports: [],
    };
    for (const snapshot of sameFeed) {
      const date = utcDay(snapshot.assessedAt);
      const value = count(snapshot, params);
      if (!(days[date]?.[pairId] >= value)) setDay(days, date, pairId, value);
    }
  }
  return { observedAt: source.fetchedAt, pairs, days };
}

function crossStrait(channel) {
  return (sources, _history, nowMs) => {
    const source = usableSource(sources, 'crossStrait', nowMs);
    const category = isRecord(source?.data.baselines) && isRecord(source.data.baselines.categories)
      ? source.data.baselines.categories[CROSS_STRAIT_CATEGORIES[channel]]
      : null;
    const current = category?.current;
    if (!isCount(current?.value) || !DATE_RE.test(current.reportingDay ?? '')) return null;
    const reportAgeDays = (Date.parse(utcDay(nowMs)) - Date.parse(current.reportingDay)) / DAY;
    if (reportAgeDays > CROSS_STRAIT_MAX_REPORT_AGE_DAYS || reportAgeDays < -1) return null;
    const window = category.windows?.['90'];
    const baseline = window?.state === 'sufficient' && isCount(window.value) ? window.value : null;
    const pairs = {};
    const days = {};
    for (const [pairId] of pairsWith(channel)) {
      pairs[pairId] = { value: current.value, baseline, countries: [], airports: [] };
      setDay(days, current.reportingDay, pairId, current.value);
    }
    return { observedAt: source.fetchedAt, pairs, days };
  };
}

function mergedSpan(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function sanctions(sources, _history, nowMs) {
  const source = usableSource(sources, 'sanctions', nowMs);
  if (!source || !Array.isArray(source.data.events)) return null;
  const gaps = Array.isArray(source.data.gaps) ? source.data.gaps.filter(g => Number.isFinite(g?.from) && Number.isFinite(g?.to)) : [];
  const events = source.data.events.filter(e => Number.isFinite(e?.at) && e.at <= nowMs + FUTURE_SKEW_MS);
  const additions = events.filter(e => e.op === 'added' && isUsList(e.list) && Array.isArray(e.cc));
  const weekStart = nowMs - SANCTIONS_WINDOW_MS;
  // The log keeps 90 days but began recently: the usual rate covers only time
  // the log was running and the US lists were observed.
  const firstSeen = Math.min(...events.map(e => e.at), ...gaps.map(g => g.from));
  const truncatedBefore = Number.isFinite(source.data.truncatedBefore) ? source.data.truncatedBefore : -Infinity;
  const priorStart = Math.max(nowMs - SANCTIONS_LOOKBACK_MS, truncatedBefore, firstSeen);
  // Each list's usual rate covers only the time its changes were recorded. A
  // retained gap keeps the last snapshot, so the list's changes are recorded
  // when it returns; any other gap skips them for good (_sanctions-changes.mjs).
  const lostGaps = gaps
    .filter(g => isUsList(g.list) && g.reason !== 'retained')
    .map(g => ({ list: g.list, from: Math.max(g.from, priorStart), to: Math.min(g.to, weekStart) }))
    .filter(g => g.to > g.from);
  const recorded = list => {
    const own = lostGaps.filter(g => g.list === list);
    return {
      exposure: weekStart - priorStart - mergedSpan(own.map(g => [g.from, g.to])),
      covers: at => !own.some(g => at >= g.from && at <= g.to),
    };
  };
  const usualRate = named => {
    if (weekStart - priorStart < SANCTIONS_MIN_PRIOR_MS) return null;
    let rate = 0;
    for (const list of new Set(named.map(e => e.list))) {
      const { exposure, covers } = recorded(list);
      const prior = named.filter(e => e.list === list && e.at >= priorStart && e.at < weekStart && covers(e.at)).length;
      if (prior === 0) continue;
      if (exposure < SANCTIONS_MIN_PRIOR_MS) return null;
      rate += prior / (exposure / SANCTIONS_WINDOW_MS);
    }
    return round2(rate);
  };
  const today = utcDay(nowMs);
  const yesterday = utcDay(nowMs - DAY);
  const pairs = {};
  const days = {};
  for (const [pairId, { sanctions: { countries } }] of pairsWith('sanctions')) {
    const named = additions.filter(e => countries.some(cc => e.cc.includes(cc)));
    pairs[pairId] = {
      value: named.filter(e => e.at >= weekStart).length,
      baseline: usualRate(named),
      countries: [...countries],
      airports: [],
    };
    for (const date of [yesterday, today]) setDay(days, date, pairId, named.filter(e => utcDay(e.at) === date).length);
  }
  return { observedAt: source.fetchedAt, pairs, days };
}

const READERS = {
  strikes,
  airports,
  military_aircraft: militaryAircraft,
  pla_aircraft: crossStrait('pla_aircraft'),
  pla_ships: crossStrait('pla_ships'),
  sanctions,
};

export function isNotable(channel, value, baseline) {
  const spec = CHANNELS[channel];
  if (!spec || !Number.isFinite(value) || value <= 0 || value < spec.minValue) return false;
  if (baseline == null) return spec.intrinsic;
  return Number.isFinite(baseline) && value >= NOTABLE_RATIO * baseline;
}

/**
 * Read every channel from its sources. `sources[name]` is `{ data, fetchedAt }`
 * for each SOURCES entry; a missing, stale or malformed source drops only the
 * channels that read it. Returns the live reading per pair and the daily values
 * this run observed, for mergeEvidenceHistory.
 */
export function buildEvidence(sources, historyDays, nowMs) {
  const history = isRecord(historyDays) ? historyDays : {};
  const live = Object.fromEntries(Object.keys(PAIR_EVIDENCE).map(pairId => [pairId, []]));
  const day = {};
  for (const channel of Object.keys(CHANNELS)) {
    const reading = READERS[channel](sources, history, nowMs);
    if (!reading) continue;
    for (const [pairId, { value, baseline, countries, airports: listed }] of Object.entries(reading.pairs)) {
      live[pairId].push({
        channel, value, baseline, countries, airports: listed,
        notable: isNotable(channel, value, baseline),
        observedAt: reading.observedAt,
      });
    }
    for (const [date, byPair] of Object.entries(reading.days)) {
      for (const [pairId, value] of Object.entries(byPair)) ((day[date] ??= {})[pairId] ??= {})[channel] = value;
    }
  }
  return { live, day };
}

/**
 * Fold one run's daily values into the stored history. Idempotent; keeps the
 * last HISTORY_DAYS UTC days and only registered pair and channel values.
 */
export function mergeEvidenceHistory(previousDays, dayValues, nowMs) {
  const oldest = utcDay(nowMs - (HISTORY_DAYS - 1) * DAY);
  const newest = utcDay(nowMs + DAY);
  const merged = {};
  const fold = (days, combine) => {
    if (!isRecord(days)) return;
    for (const [date, byPair] of Object.entries(days)) {
      if (!DATE_RE.test(date) || date < oldest || date > newest || !isRecord(byPair)) continue;
      for (const [pairId, byChannel] of Object.entries(byPair)) {
        if (!(pairId in PAIR_EVIDENCE) || !isRecord(byChannel)) continue;
        for (const [channel, value] of Object.entries(byChannel)) {
          if (!(channel in PAIR_EVIDENCE[pairId]) || !isCount(value)) continue;
          const slot = ((merged[date] ??= {})[pairId] ??= {});
          slot[channel] = combine && channel in slot ? combine(channel, slot[channel], value) : value;
        }
      }
    }
  };
  fold(previousDays, null);
  fold(dayValues, (channel, stored, value) => (CHANNELS[channel].merge === 'max' ? Math.max(stored, value) : value));
  return Object.fromEntries(Object.keys(merged).sort().map(date => [date, merged[date]]));
}

export function buildEvidencePayload(sources, previous, nowMs) {
  const history = mergeEvidenceHistory(isRecord(previous) ? previous.days : {}, {}, nowMs);
  const { live, day } = buildEvidence(sources, history, nowMs);
  return { updatedAt: nowMs, live, days: mergeEvidenceHistory(history, day, nowMs) };
}

export function countReadings(payload) {
  return Object.values(payload?.live ?? {}).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
}
