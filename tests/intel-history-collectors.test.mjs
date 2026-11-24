// Builders for the intel-history collectors added in #11245
// (scripts/_intel-history-collectors.mjs). The shared contract every builder
// must meet (stable keys, fail-open hooks, call-site wiring) lives in
// tests/seed-history-wiring.test.mjs; this file pins each projection: the
// significance bar, the identity it keys on, and the field mapping.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  AVIATION_ALERT,
  CYBER_C2_THREAT,
  CYBER_MALWARE_HOST,
  EARTHQUAKE,
  NATURAL_EVENT,
  PORTWATCH_DISRUPTION,
  UCDP_EVENT,
  UNREST_ACLED_EVENT,
  UNREST_GDELT_EVENT,
} from './helpers/intel-history-collector-fixtures.mjs';

const {
  EARTHQUAKE_HISTORY_MIN_MAGNITUDE,
  UCDP_HISTORY_MIN_DEATHS,
  UNREST_GDELT_MIN_REPORTS,
  buildAviationHistoryRecords,
  buildCyberHistoryRecords,
  buildEarthquakeHistoryRecords,
  buildNaturalEventHistoryRecords,
  buildPortwatchHistoryRecords,
  buildUcdpHistoryRecords,
  buildUnrestHistoryRecords,
  withHistoryAfterPublish,
} = await import('../scripts/_intel-history-collectors.mjs');
const { normalizeHistoryRecords } = await import('../scripts/_seed-history.mjs');

test('UCDP events map to a conflict record keyed on the GED id with an ISO2 country', () => {
  const [record] = buildUcdpHistoryRecords({ events: [UCDP_EVENT] });
  assert.deepEqual(record, {
    dedupeKey: 'conflict:ucdp-events:647991',
    country: 'ET',
    category: 'state-based',
    title: 'State-based conflict: Government of Ethiopia vs EPFAS — 200 deaths in Wichale town',
    summary: 'UCDP GED event 647991; deaths best 200 (low 200, high 210); source: MVON',
    occurredAt: UCDP_EVENT.dateStart,
  });
});

test('UCDP keeps events at the death threshold and drops those below it', () => {
  const records = buildUcdpHistoryRecords({
    events: [
      { ...UCDP_EVENT, id: 'at', deathsBest: UCDP_HISTORY_MIN_DEATHS },
      { ...UCDP_EVENT, id: 'below', deathsBest: UCDP_HISTORY_MIN_DEATHS - 1 },
    ],
  });
  assert.deepEqual(records.map((r) => r.dedupeKey), ['conflict:ucdp-events:at']);
});

test('UCDP drops a zero dateStart instead of storing a 1970 event', () => {
  // The writers map an unparseable date_start to 0 (`Date.parse(...) || 0`).
  assert.deepEqual(buildUcdpHistoryRecords({ events: [{ ...UCDP_EVENT, dateStart: 0 }] }), []);
  assert.deepEqual(buildUcdpHistoryRecords({ events: [{ ...UCDP_EVENT, id: '' }] }), []);
  assert.deepEqual(buildUcdpHistoryRecords(null), []);
});

test('UCDP omits a country name the resolver cannot map rather than storing the name', () => {
  const [record] = buildUcdpHistoryRecords({ events: [{ ...UCDP_EVENT, country: 'Atlantis' }] });
  assert.equal(record.country, undefined);
});

test('GDELT unrest signals key on place and UTC day, not the moving upstream id', () => {
  const [first] = buildUnrestHistoryRecords({ events: [UNREST_GDELT_EVENT] });
  assert.equal(first.dedupeKey, 'unrest:events:gdelt:38.9:-77.0:2026-11-24');
  assert.equal(first.country, 'US');
  assert.equal(first.category, 'media-signal');
  assert.equal(first.title, 'Unrest media signal: Washington, Washington, United States (2026-11-24)');
  assert.match(first.summary, /^123 reports\. Unverified media signal\./);
  assert.equal(first.sourceUrl, undefined, 'the first keyword-matched article is not evidence');

  // Later the same day the bucket has more articles: the upstream id, title
  // count and occurredAt all move. The identity must not.
  const later = {
    ...UNREST_GDELT_EVENT,
    id: 'gdelt-bulk-38.90--77.04-1795560000000',
    title: 'Washington, Washington, United States (180 reports)',
    occurredAt: Date.parse('2026-11-24T18:00:00Z'),
  };
  assert.equal(buildUnrestHistoryRecords({ events: [later] })[0].dedupeKey, first.dedupeKey);

  const nextDay = { ...UNREST_GDELT_EVENT, occurredAt: Date.parse('2026-11-25T01:00:00Z') };
  assert.notEqual(buildUnrestHistoryRecords({ events: [nextDay] })[0].dedupeKey, first.dedupeKey);
});

test('GDELT unrest signals below the report threshold are dropped', () => {
  const small = {
    ...UNREST_GDELT_EVENT,
    title: `Chile (${UNREST_GDELT_MIN_REPORTS - 1} reports)`,
  };
  const untitled = { ...UNREST_GDELT_EVENT, title: 'Chile' };
  assert.deepEqual(buildUnrestHistoryRecords({ events: [small, untitled] }), []);
});

test('ACLED unrest rows keep their upstream id, title and link', () => {
  const [record] = buildUnrestHistoryRecords({ events: [UNREST_ACLED_EVENT] });
  assert.deepEqual(record, {
    dedupeKey: 'unrest:events:acled-CHL1234',
    country: 'CL',
    category: 'protest',
    title: UNREST_ACLED_EVENT.title,
    summary: UNREST_ACLED_EVENT.summary,
    sourceUrl: 'https://www.example.cl/marcha',
    occurredAt: UNREST_ACLED_EVENT.occurredAt,
  });
});

test('cyber history keeps C2 servers and drops reputation-only indicators', () => {
  const records = buildCyberHistoryRecords({ threats: [CYBER_C2_THREAT, CYBER_MALWARE_HOST] });
  assert.deepEqual(records, [{
    dedupeKey: 'cyber:threats:c2intel:47.115.221.177',
    country: 'CN',
    category: 'c2-server',
    title: 'Cobaltstrike C2 server 47.115.221.177 (CN)',
    summary: 'ip indicator; source: c2intel; severity: high; tags: c2, cobaltstrike',
    occurredAt: CYBER_C2_THREAT.firstSeenAt,
  }]);
});

test('cyber history hashes an id that would overflow the relay key limit', () => {
  const longIndicator = `http://${'a'.repeat(300)}.example/c2`;
  const [record] = buildCyberHistoryRecords({
    threats: [{ ...CYBER_C2_THREAT, id: `urlhaus:${longIndicator}`, indicator: longIndicator }],
  });
  assert.match(record.dedupeKey, /^cyber:threats:sha256:[0-9a-f]{64}$/);
  assert.equal(normalizeHistoryRecords([record]).length, 1, 'the bounded key survives the wire sanitizer');
});

test('cyber history drops a threat with no first-seen time', () => {
  assert.deepEqual(buildCyberHistoryRecords({ threats: [{ ...CYBER_C2_THREAT, firstSeenAt: 0 }] }), []);
});

test('PortWatch disruptions key on the ArcGIS event id and date from fromDate', () => {
  const [record] = buildPortwatchHistoryRecords({ events: [PORTWATCH_DISRUPTION] });
  assert.deepEqual(record, {
    dedupeKey: 'maritime:portwatch-disruptions:10000004',
    country: undefined,
    category: 'other-disruption',
    title: 'Port disruption: HORMUZ-26 (RED)',
    summary: 'IMF PortWatch other disruption; alert RED; from 2026-03-01 (ongoing); affected: chokepoint6',
    occurredAt: Date.parse('2026-03-01'),
  });
  assert.deepEqual(buildPortwatchHistoryRecords({ events: [{ ...PORTWATCH_DISRUPTION, fromDate: '' }] }), []);
});

test('earthquakes keep M5+ with the region resolved from the place', () => {
  const [record] = buildEarthquakeHistoryRecords({ earthquakes: [EARTHQUAKE] });
  assert.deepEqual(record, {
    dedupeKey: 'natural:earthquakes:us6000ud6z',
    country: 'MX',
    category: 'earthquake',
    title: 'M5.2 earthquake — 93 km WSW of Puerto Madero, Mexico',
    summary: 'magnitude 5.2; depth 35 km; source: usgs',
    sourceUrl: EARTHQUAKE.sourceUrl,
    occurredAt: EARTHQUAKE.occurredAt,
  });

  const records = buildEarthquakeHistoryRecords({
    earthquakes: [
      { ...EARTHQUAKE, id: 'small', magnitude: EARTHQUAKE_HISTORY_MIN_MAGNITUDE - 0.1 },
      // NRCan publishes undated entries with occurredAt 0.
      { ...EARTHQUAKE, id: 'undated', occurredAt: 0 },
    ],
  });
  assert.deepEqual(records, []);
});

test('natural events strip the GDACS alert emoji and keep the upstream id', () => {
  const [record] = buildNaturalEventHistoryRecords({ events: [NATURAL_EVENT] });
  assert.deepEqual(record, {
    dedupeKey: 'natural:events:gdacs-DR-1027450',
    category: 'drought',
    title: 'Drought in Kenya, Somalia',
    summary: NATURAL_EVENT.description,
    sourceUrl: NATURAL_EVENT.sourceUrl,
    occurredAt: NATURAL_EVENT.date,
  });
  // GDACS maps a missing fromdate to new Date(0).
  assert.deepEqual(buildNaturalEventHistoryRecords({ events: [{ ...NATURAL_EVENT, date: 0 }] }), []);
});

test('natural events clip an over-long description instead of losing the record', () => {
  const [record] = buildNaturalEventHistoryRecords({
    events: [{ ...NATURAL_EVENT, description: 'x'.repeat(5000) }],
  });
  assert.equal(normalizeHistoryRecords([record]).length, 1);
});

test('aviation keeps major and severe disruptions keyed by airport, severity and UTC day', () => {
  const [record] = buildAviationHistoryRecords({ alerts: [AVIATION_ALERT] });
  assert.deepEqual(record, {
    dedupeKey: 'aviation:intl:MEX:major:2026-11-24',
    country: 'MX',
    category: 'general',
    title: 'Mexico City International (MEX): major delays',
    summary: 'Avg 38min delay, 60% delayed; 0 of 78 sampled departures cancelled; Mexico City, Mexico',
    occurredAt: AVIATION_ALERT.updatedAt,
  });

  // The next tick restamps updatedAt; the same day is the same row.
  const laterSameDay = { ...AVIATION_ALERT, updatedAt: Date.parse('2026-11-24T23:59:00Z') };
  assert.equal(buildAviationHistoryRecords({ alerts: [laterSameDay] })[0].dedupeKey, record.dedupeKey);
});

test('aviation keeps a closure at any severity and drops moderate delays', () => {
  const records = buildAviationHistoryRecords({
    alerts: [
      { ...AVIATION_ALERT, iata: 'RUH', severity: 'FLIGHT_DELAY_SEVERITY_MODERATE', delayType: 'FLIGHT_DELAY_TYPE_CLOSURE' },
      { ...AVIATION_ALERT, iata: 'YYZ', severity: 'FLIGHT_DELAY_SEVERITY_MODERATE' },
      { ...AVIATION_ALERT, iata: 'JFK', severity: 'FLIGHT_DELAY_SEVERITY_MINOR' },
    ],
  });
  assert.deepEqual(records.map((r) => r.dedupeKey), ['aviation:intl:RUH:moderate:2026-11-24']);
  assert.equal(records[0].title, 'Mexico City International (RUH): moderate closure');
});

test('every builder emits records the wire sanitizer accepts unchanged', () => {
  const built = [
    ...buildUcdpHistoryRecords({ events: [UCDP_EVENT] }),
    ...buildUnrestHistoryRecords({ events: [UNREST_GDELT_EVENT, UNREST_ACLED_EVENT] }),
    ...buildCyberHistoryRecords({ threats: [CYBER_C2_THREAT] }),
    ...buildPortwatchHistoryRecords({ events: [PORTWATCH_DISRUPTION] }),
    ...buildEarthquakeHistoryRecords({ earthquakes: [EARTHQUAKE] }),
    ...buildNaturalEventHistoryRecords({ events: [NATURAL_EVENT] }),
    ...buildAviationHistoryRecords({ alerts: [AVIATION_ALERT] }),
  ];
  assert.equal(built.length, 8);
  assert.equal(normalizeHistoryRecords(built).length, built.length);
  for (const record of built) {
    if (record.country !== undefined) assert.match(record.country, /^[A-Z]{2}$/, record.dedupeKey);
  }
});

test('withHistoryAfterPublish returns the primary hook result and runs history after it', async () => {
  const order = [];
  const primaryResult = { completionState: 'DEGRADED', freshnessMetaPatch: { sourceState: 'degraded' } };
  const hook = withHistoryAfterPublish(
    async (data, meta) => {
      order.push(['primary', data, meta.runId]);
      return primaryResult;
    },
    async (data, meta) => {
      order.push(['history', data, meta.runId]);
    },
  );
  const data = { events: [] };
  assert.equal(await hook(data, { runId: 'run-7' }), primaryResult);
  assert.deepEqual(order, [['primary', data, 'run-7'], ['history', data, 'run-7']]);
});

test('withHistoryAfterPublish skips history when the primary hook throws', async () => {
  let historyRan = false;
  const hook = withHistoryAfterPublish(
    async () => { throw new Error('notify failed'); },
    async () => { historyRan = true; },
  );
  await assert.rejects(hook({}, {}), /notify failed/);
  assert.equal(historyRan, false);
});

// ── Review fixes before the first production run: a row keeps the identity and
// country it was first stored with for 180 days. ────────────────────────────

test('UCDP resolves the historical parenthetical country names it emits', () => {
  const countries = buildUcdpHistoryRecords({
    events: ['DR Congo (Zaire)', 'Myanmar (Burma)', 'Russia (Soviet Union)', 'Yemen (North Yemen)']
      .map((country, i) => ({ ...UCDP_EVENT, id: `p${i}`, country })),
  }).map((r) => r.country);
  assert.deepEqual(countries, ['CD', 'MM', 'RU', 'YE']);
});

test('GDELT unrest keys on the 0.1° bucket, not the point the bucket kept', () => {
  // aggregateGeo buckets at toFixed(1) and keeps the first location's
  // coordinates; a different first article moves the point inside the cell.
  const keyAt = (latitude, longitude) => buildUnrestHistoryRecords({
    events: [{ ...UNREST_GDELT_EVENT, location: { latitude, longitude } }],
  })[0].dedupeKey;
  assert.equal(keyAt(48.866, 2.333), keyAt(48.874, 2.318));
  assert.equal(keyAt(48.87, 2.33), 'unrest:events:gdelt:48.9:2.3:2026-11-24');
});

test('earthquake history keeps USGS ids only', () => {
  // NRCan rows switch to the USGS id once USGS reports the same quake.
  assert.equal(buildEarthquakeHistoryRecords({ earthquakes: [{ ...EARTHQUAKE, id: 'nrcan-2026abcd', source: 'nrcan' }] }).length, 0);
  assert.equal(buildEarthquakeHistoryRecords({ earthquakes: [EARTHQUAKE] }).length, 1);
});

test('natural events skip GDACS earthquakes and HKO warning signals', () => {
  const kept = buildNaturalEventHistoryRecords({
    events: [
      { ...NATURAL_EVENT, id: 'gdacs-EQ-1501234', category: 'earthquakes', title: '🔴 Earthquake in Japan' },
      { ...NATURAL_EVENT, id: 'hko-warning:WTCSGNL', category: 'severeStorms', title: 'Tropical Cyclone Warning Signal No. 8' },
      NATURAL_EVENT,
    ],
  }).map((r) => r.dedupeKey);
  assert.deepEqual(kept, [`natural:events:${NATURAL_EVENT.id}`]);
});
