// Wiring tests for issue #5694: the three intel-history collector seeders
// (conflict/acled-intel, military/cross-strait-activity, energy/intelligence)
// must project their published payloads into history records and append them
// post-publish, best-effort. The append hook must NEVER throw: the canonical
// publish already succeeded, and a throw would skip runSeed's freshness write
// and crash a healthy run (the seed-gdelt-intel.mjs:286 hazard).
//
// Behavior is proven by executing the exported builders and hooks; a source
// pin at the bottom only asserts the hook is actually wired into each
// runSeed opts block (call-site pin, not a behavior guard).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const {
  buildConflictHistoryRecords,
  conflictIntelAfterPublish,
} = await import('../scripts/seed-conflict-intel.mjs');
const {
  buildEnergyHistoryRecords,
  energyIntelAfterPublish,
} = await import('../scripts/seed-energy-intelligence.mjs');
const {
  buildCrossStraitHistoryRecords,
  crossStraitHistoryAfterPublish,
} = await import('../scripts/seed-cross-strait-activity.mjs');

const ACLED_EVENT = {
  id: 'acled-SUD12345',
  eventType: 'Battles',
  country: 'Sudan',
  event_date: '2026-07-20',
  location: { latitude: 15.5, longitude: 32.5 },
  occurredAt: Date.parse('2026-07-20T00:00:00Z'),
  fatalities: 12,
  actors: ['RSF', 'SAF'],
  source: 'ACLED',
  admin1: 'Khartoum',
};

const ENERGY_ITEM = {
  id: 'oilprice-abc123-1753000000000',
  title: 'Brent spikes after chokepoint disruption',
  url: 'https://example.com/brent',
  source: 'OilPrice',
  publishedAt: 1753000000000,
  summary: 'Tanker transit halted.',
};

const CROSS_STRAIT_OBSERVATION = {
  id: 'japan-mod:press-20260720',
  sourceId: 'japan-mod',
  observationKind: 'reviewed_regional_augmentation',
  reportingDay: '2026-07-20',
  publicationTime: '2026-07-21T02:00:00.000Z',
  categories: { planVessels: 'PLAN vessels x 3' },
  originalTerminology: 'JMSDF press release',
  summary: 'JMSDF reported three PLAN vessels southeast of Minami-iwo-to.',
  sourceUrl: 'https://www.mod.go.jp/js/press/2026/07/20a.html',
};

test('buildConflictHistoryRecords maps ACLED events with ISO2 country', () => {
  const records = buildConflictHistoryRecords({ events: [ACLED_EVENT] });
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.dedupeKey, 'conflict:acled-intel:acled-SUD12345');
  assert.equal(record.country, 'SD');
  assert.equal(record.category, 'Battles');
  assert.equal(record.title, 'Battles — RSF vs SAF — in Khartoum, Sudan');
  assert.equal(record.summary, 'fatalities: 12; source: ACLED');
  assert.equal(record.sourceUrl, undefined);
  assert.equal(record.occurredAt, ACLED_EVENT.occurredAt);
});

test('buildConflictHistoryRecords preserves GDELT article title and provenance URL', () => {
  const [record] = buildConflictHistoryRecords({
    events: [{
      id: 'gdelt-SD-8b3e9d1a',
      eventType: 'GDELT coverage',
      country: 'Sudan',
      occurredAt: Date.parse('2026-07-20T12:00:00Z'),
      title: 'Sudan ceasefire talks resume after clashes',
      source: 'reuters.com',
      url: 'https://www.reuters.com/world/africa/sudan-ceasefire-talks/',
    }],
  });

  assert.equal(record.title, 'Sudan ceasefire talks resume after clashes');
  assert.equal(record.sourceUrl, 'https://www.reuters.com/world/africa/sudan-ceasefire-talks/');
  assert.equal(record.summary, 'source: reuters.com');
});

test('buildConflictHistoryRecords drops events without id or timestamp', () => {
  const records = buildConflictHistoryRecords({
    events: [
      { ...ACLED_EVENT, id: undefined },
      { ...ACLED_EVENT, occurredAt: Number.NaN },
      null,
    ],
  });
  assert.deepEqual(records, []);
  assert.deepEqual(buildConflictHistoryRecords(null), []);
});

test('buildConflictHistoryRecords keeps unresolvable country undefined', () => {
  const [record] = buildConflictHistoryRecords({
    events: [{ ...ACLED_EVENT, country: 'Atlantis' }],
  });
  assert.equal(record.country, undefined);
  assert.match(record.title, /in Khartoum, Atlantis$/);
});

test('buildEnergyHistoryRecords maps items directly', () => {
  const records = buildEnergyHistoryRecords({ items: [ENERGY_ITEM] });
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.dedupeKey, `energy:intelligence:${ENERGY_ITEM.id}`);
  assert.equal(record.category, 'news');
  assert.equal(record.title, ENERGY_ITEM.title);
  assert.equal(record.summary, ENERGY_ITEM.summary);
  assert.equal(record.sourceUrl, ENERGY_ITEM.url);
  assert.equal(record.occurredAt, ENERGY_ITEM.publishedAt);
  assert.equal(record.country, undefined);
});

test('buildEnergyHistoryRecords drops incomplete items', () => {
  const records = buildEnergyHistoryRecords({
    items: [
      { ...ENERGY_ITEM, id: '' },
      { ...ENERGY_ITEM, title: '' },
      { ...ENERGY_ITEM, publishedAt: undefined },
    ],
  });
  assert.deepEqual(records, []);
});

test('buildCrossStraitHistoryRecords maps observations with source country', () => {
  const records = buildCrossStraitHistoryRecords({ observations: [CROSS_STRAIT_OBSERVATION] });
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.dedupeKey, 'military:cross-strait-activity:japan-mod:press-20260720');
  assert.equal(record.country, 'JP');
  assert.equal(record.category, 'reviewed_regional_augmentation');
  assert.equal(record.occurredAt, Date.parse('2026-07-20'));
  assert.match(record.title, /^Cross-Strait activity 2026-07-20: JMSDF reported/);
  assert.equal(record.sourceUrl, CROSS_STRAIT_OBSERVATION.sourceUrl);
});

test('buildCrossStraitHistoryRecords falls back to categories and publicationTime', () => {
  const [record] = buildCrossStraitHistoryRecords({
    observations: [{
      ...CROSS_STRAIT_OBSERVATION,
      sourceId: 'taiwan-mnd',
      summary: undefined,
      reportingDay: undefined,
    }],
  });
  assert.equal(record.country, 'TW');
  assert.equal(record.occurredAt, Date.parse('2026-07-21T02:00:00.000Z'));
  assert.match(record.title, /planVessels: PLAN vessels x 3/);
  assert.equal(record.summary, undefined);
});

test('buildCrossStraitHistoryRecords drops observations without id or any date', () => {
  const records = buildCrossStraitHistoryRecords({
    observations: [
      { ...CROSS_STRAIT_OBSERVATION, id: undefined },
      { ...CROSS_STRAIT_OBSERVATION, reportingDay: undefined, publicationTime: 'not-a-date' },
    ],
  });
  assert.deepEqual(records, []);
});

const HOOKS = [
  ['conflict', 'acled-intel', conflictIntelAfterPublish, { events: [ACLED_EVENT] }],
  ['energy', 'intelligence', energyIntelAfterPublish, { items: [ENERGY_ITEM] }],
  ['military', 'cross-strait-activity', crossStraitHistoryAfterPublish,
    { observations: [CROSS_STRAIT_OBSERVATION] }],
];

// The ingest-health recorder (#5736) is the hook's second injectable seam; stub
// it out here so these wiring tests stay offline and keep asserting only the
// append leg. tests/seed-history-ingest-health.test.mjs owns its behavior.
const noopRecordHealth = async () => null;

for (const [domain, resource, hook, payload] of HOOKS) {
  test(`${domain}/${resource} afterPublish passes projected records to append`, async () => {
    const calls = [];
    await hook(payload, { runId: 'run-42' }, {
      append: async (args) => {
        calls.push(args);
        return { inserted: 1, skipped: 0, chunks: 1 };
      },
      recordHealth: noopRecordHealth,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].domain, domain);
    assert.equal(calls[0].resource, resource);
    assert.equal(calls[0].runId, 'run-42');
    assert.equal(calls[0].records.length, 1);
  });

  test(`${domain}/${resource} afterPublish never throws when append fails`, async () => {
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      await hook(payload, { runId: 'run-42' }, {
        append: async () => {
          throw new Error('convex 503');
        },
        recordHealth: noopRecordHealth,
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /non-fatal.*convex 503/);
  });

  test(`${domain}/${resource} afterPublish surfaces a live retraction in the run log`, async () => {
    // A nonzero `retracted` in the Railway log is the ONLY operator-facing
    // signal that a tombstone is still suppressing a record the upstream feed
    // has not stopped serving (#5743). The suffix is conditional, so without
    // this the suppressed case renders byte-identically to "no tombstone
    // exists" and the signal can be dropped by a refactor with nothing failing.
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await hook(payload, { runId: 'run-42' }, {
        append: async () => ({ inserted: 0, skipped: 3, retracted: 2 }),
        recordHealth: noopRecordHealth,
      });
      await hook(payload, { runId: 'run-42' }, {
        append: async () => ({ inserted: 1, skipped: 0, retracted: 0 }),
        recordHealth: noopRecordHealth,
      });
    } finally {
      console.log = originalLog;
    }
    assert.match(logs[0], /appended 0, deduped 3, retracted 2/);
    // ...and stays out of the way when nothing is suppressed.
    assert.match(logs[1], /appended 1, deduped 0$/);
  });

  test(`${domain}/${resource} afterPublish stays quiet on unconfigured skip`, async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await hook(payload, { runId: 'run-42' }, {
        append: async () => ({ skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] }),
        recordHealth: noopRecordHealth,
      });
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(logs.filter((line) => line.includes('intel-history')), []);
  });

  test(`${domain}/${resource} afterPublish reports both outcomes to ingest health`, async () => {
    const observations = [];
    const recordHealth = async (observation) => {
      observations.push(observation);
      return null;
    };
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
      await hook(payload, { runId: 'run-42' }, {
        append: async () => ({ inserted: 2, skipped: 1, chunks: 1, abandoned: 0, failedChunks: 0 }),
        recordHealth,
      });
      await hook(payload, { runId: 'run-43' }, {
        append: async () => {
          throw new Error('convex 503');
        },
        recordHealth,
      });
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    assert.equal(observations.length, 2);
    assert.equal(observations[0].domain, domain);
    assert.equal(observations[0].resource, resource);
    assert.equal(observations[0].runId, 'run-42');
    assert.deepEqual(observations[0].result, { inserted: 2, skipped: 1, chunks: 1, abandoned: 0, failedChunks: 0 });
    assert.equal(observations[0].error, null);
    assert.equal(observations[1].result, null);
    assert.match(observations[1].error.message, /convex 503/);
  });

  test(`${domain}/${resource} afterPublish survives an ingest-health recorder that throws`, async () => {
    const warns = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args) => warns.push(args.join(' '));
    console.log = () => {};
    try {
      await hook(payload, { runId: 'run-42' }, {
        append: async () => ({ inserted: 1, skipped: 0, chunks: 1 }),
        recordHealth: async () => {
          throw new Error('upstash down');
        },
      });
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /ingest-health record failed \(non-fatal\).*upstash down/);
  });
}

// Call-site pin: the hooks above are only worth testing if runSeed actually
// invokes them. Assert each seeder wires its hook into the opts block.
const WIRING = [
  ['scripts/seed-conflict-intel.mjs', 'afterPublish: conflictIntelAfterPublish'],
  ['scripts/seed-energy-intelligence.mjs', 'afterPublish: energyIntelAfterPublish'],
  ['scripts/seed-cross-strait-activity.mjs', 'afterPublish: crossStraitHistoryAfterPublish'],
];

for (const [file, needle] of WIRING) {
  test(`${file} wires its history hook into runSeed opts`, async () => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(needle), `${file} must contain "${needle}"`);
  });
}

// ---------------------------------------------------------------------------
// dedupeKey stability (#5743)
//
// The retraction path suppresses an identity, not a row, so a `dedupeKey` that
// changes between runs for the SAME upstream item makes every tombstone
// useless: the record returns under a fresh key and nothing reports a problem.
// That assumption is load-bearing for the whole feature and, until these
// tests, nothing pinned it — a cross-model review pass surfaced "add Date.now()
// to the energy dedupeKey" as a mutation the suite would not kill.
//
// These call the REAL builders with the same input twice, and assert the key
// depends only on properties of the upstream item.
// ---------------------------------------------------------------------------

test('every history dedupeKey is a pure function of the upstream item', () => {
  const CASES = [
    ['conflict', buildConflictHistoryRecords, { events: [ACLED_EVENT] }],
    ['energy', buildEnergyHistoryRecords, { items: [ENERGY_ITEM] }],
    ['military', buildCrossStraitHistoryRecords, { observations: [CROSS_STRAIT_OBSERVATION] }],
  ];

  for (const [label, build, payload] of CASES) {
    const first = build(payload);
    const second = build(JSON.parse(JSON.stringify(payload)));
    assert.ok(first.length > 0, `${label} builder must produce a record`);
    assert.deepEqual(
      first.map((r) => r.dedupeKey),
      second.map((r) => r.dedupeKey),
      `${label} dedupeKey must not change between runs for identical input`,
    );

    // A clock-derived component is the specific failure mode: it survives a
    // same-tick comparison above and only diverges across runs, so assert the
    // key carries no fragment of the current time.
    const now = String(Date.now());
    for (const key of first.map((r) => r.dedupeKey)) {
      for (const width of [13, 10]) {
        assert.ok(
          !key.includes(now.slice(0, width)),
          `${label} dedupeKey must not embed the current time: ${key}`,
        );
      }
    }
  }
});

test('a changed upstream item yields a different key, an unchanged one does not', () => {
  // The other half of the contract: the key must still DISCRIMINATE. A builder
  // that returned a constant would pass the stability test above while
  // collapsing every event onto one row — and one tombstone would then suppress
  // an entire feed.
  const a = buildEnergyHistoryRecords({ items: [ENERGY_ITEM] })[0].dedupeKey;
  const b = buildEnergyHistoryRecords({
    items: [{ ...ENERGY_ITEM, id: `${ENERGY_ITEM.id}-other` }],
  })[0].dedupeKey;
  assert.notEqual(a, b, 'distinct upstream ids must not collapse onto one key');
});
