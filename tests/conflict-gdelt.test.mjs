import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gdeltSeenDateToIso,
  buildGdeltConflictUrl,
  mapGdeltArticlesToEvents,
  GDELT_COUNTRY_NAMES,
} from '../scripts/_conflict-gdelt.mjs';
import { computeEmaWindows } from '../scripts/_ema-threat-engine.mjs';
import {
  fetchGdeltConflictEvents,
  GDELT_MIN_SUCCESSFUL_COUNTRIES,
} from '../scripts/seed-conflict-intel.mjs';

const BULK_FIXTURE_NOW = Date.parse('2026-07-13T12:00:00Z');

test('gdeltSeenDateToIso parses GDELT seendate formats to YYYY-MM-DD', () => {
  assert.equal(gdeltSeenDateToIso('20260709T140000Z'), '2026-07-09');
  assert.equal(gdeltSeenDateToIso('20260709140000'), '2026-07-09');
  assert.ok(Number.isFinite(Date.parse(gdeltSeenDateToIso('20260709T140000Z'))));
  // unparseable → '' (dropped downstream, never a bad Date)
  assert.equal(gdeltSeenDateToIso(''), '');
  assert.equal(gdeltSeenDateToIso('bad'), '');
  assert.equal(gdeltSeenDateToIso(null), '');
});

test('buildGdeltConflictUrl targets DOC 2.0 artlist json with the country name', () => {
  const url = buildGdeltConflictUrl('SD');
  assert.ok(url.startsWith('https://api.gdeltproject.org/api/v2/doc/doc?query='));
  assert.ok(url.includes('mode=artlist'));
  assert.ok(url.includes('format=json'));
  assert.ok(decodeURIComponent(url).includes('"Sudan"'));
});

test('mapGdeltArticlesToEvents emits {country, event_date} in the EMA-readable shape', () => {
  const articles = [
    { seendate: '20260709T140000Z', domain: 'aljazeera.com', url: 'https://x/1', title: 'a' },
    { seendate: '20260709T100000Z', domain: 'reuters.com', url: 'https://x/2', title: 'b' },
  ];
  const events = mapGdeltArticlesToEvents(articles, 'SD');
  assert.equal(events.length, 2);
  // country is the full name (matches UCDP / normalizeCountry), NOT the ISO2 code
  assert.equal(events[0].country, 'Sudan');
  // event_date is the field the EMA reads — the bug this fixes was its absence
  assert.equal(events[0].event_date, '2026-07-09');
  assert.ok('event_date' in events[0]);
  assert.equal(events[0].title, 'a');
  assert.equal(events[0].url, 'https://x/1');
});

test('mapGdeltArticlesToEvents uses durable identities across reordered and replaced DOC responses', () => {
  const firstRun = mapGdeltArticlesToEvents([
    { seendate: '20260709T140000Z', domain: 'reuters.com', url: 'https://example.com/story?b=2&a=1#section', title: 'First story' },
    { seendate: '20260709T130000Z', domain: 'apnews.com', url: 'https://example.com/other', title: 'Second story' },
  ], 'SD');
  const secondRun = mapGdeltArticlesToEvents([
    { seendate: '20260709T130000Z', domain: 'apnews.com', url: 'https://example.com/other', title: 'Second story' },
    { seendate: '20260709T140000Z', domain: 'reuters.com', url: 'https://example.com/story?a=1&b=2', title: 'First story' },
    { seendate: '20260709T120000Z', domain: 'bbc.com', url: 'https://example.com/replacement', title: 'Replacement story' },
  ], 'SD');

  assert.equal(secondRun[0].id, firstRun[1].id);
  assert.equal(secondRun[1].id, firstRun[0].id);
  assert.notEqual(secondRun[2].id, firstRun[0].id);
  assert.notEqual(secondRun[2].id, firstRun[1].id);
  assert.match(firstRun[0].id, /^gdelt-SD-[a-f0-9]{16}$/);
});

test('mapGdeltArticlesToEvents drops articles with an unparseable seendate', () => {
  const events = mapGdeltArticlesToEvents(
    [{ seendate: '', domain: 'd' }, { seendate: 'garbage' }, { seendate: '20260709T000000Z' }],
    'YE',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].country, 'Yemen');
});

test('mapGdeltArticlesToEvents is defensive against bad input', () => {
  assert.deepEqual(mapGdeltArticlesToEvents(null, 'SD'), []);
  assert.deepEqual(mapGdeltArticlesToEvents([{ seendate: '20260709T0000Z' }], 'ZZ'), []); // unknown cc → no name
});

test('GDELT-derived events register in the conflict EMA (end-to-end shape contract)', () => {
  // The whole point of #5099: without a valid event_date, computeEmaWindows would
  // Date.parse(undefined) → NaN → skip the event, leaving the country uncounted.
  const now = Date.parse('2026-07-09T18:00:00Z');
  const recent = new Date(now - 60 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + 'Z';
  const events = mapGdeltArticlesToEvents(
    [{ seendate: recent, domain: 'd' }, { seendate: recent, domain: 'd2' }],
    'SD',
  );
  const windows = computeEmaWindows(new Map(), events, [], now);
  const sudan = [...windows.entries()].find(([c]) => String(c).toLowerCase().includes('sudan'));
  assert.ok(sudan, 'Sudan should be present in the EMA windows');
  // event_date within the 24h cutoff → counted (would be 0 if event_date were missing)
  assert.ok(sudan[1], 'Sudan window state should exist');
});

test('GDELT_COUNTRY_NAMES covers the priority conflict set with full display names', () => {
  assert.equal(GDELT_COUNTRY_NAMES.UA, 'Ukraine');
  assert.equal(GDELT_COUNTRY_NAMES.SD, 'Sudan');
  assert.equal(GDELT_COUNTRY_NAMES.CD, 'Democratic Republic of Congo');
  assert.ok(Object.keys(GDELT_COUNTRY_NAMES).length >= 20);
});

test('fetchGdeltConflictEvents fails closed when too many country fetches fail', async () => {
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      fetchBulkEvents: async () => { throw new Error('bulk unavailable'); },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        if (calls < GDELT_MIN_SUCCESSFUL_COUNTRIES) {
          return { country: cc, ok: true, events: [{ country: 'Sudan', event_date: '2026-07-09' }] };
        }
        return { country: cc, ok: false, events: [], error: 'proxy unavailable' };
      },
    }),
    /coverage below floor: 15\/20 countries succeeded \(min 16\)/,
  );
});

test('fetchGdeltConflictEvents uses the bulk export as PRIMARY: a healthy bulk path makes zero DOC requests (#5849)', async () => {
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    // A DOC route that would happily serve every country — the old DOC-first
    // order returns source 'gdelt' with 20 requests here; bulk-first makes none.
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ country: 'Sudan', event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [
        { id: 'gdelt-event-primary-1', country: 'Sudan' },
        { id: 'gdelt-event-primary-2', country: 'Yemen' },
        { id: 'gdelt-event-primary-3', country: 'Ukraine' },
      ],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
  });

  assert.equal(docCalls, 0, `healthy bulk path must make zero DOC API requests, made ${docCalls}`);
  assert.equal(result.source, 'gdelt-bulk');
  assert.deepEqual(
    result.events.map(event => event.id).sort(),
    ['gdelt-event-primary-1', 'gdelt-event-primary-2', 'gdelt-event-primary-3'],
  );
});

test('fetchGdeltConflictEvents rejects when bulk fails and the DOC sweep succeeds but yields zero events', async () => {
  // Post-#5849 the zero-yield sweep has nothing left to fall through to: bulk
  // already failed ahead of it. The run must throw (runSeed retries / preserves
  // last-good), never resolve to a legitimate-looking empty payload.
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => BULK_FIXTURE_NOW,
      loadPreviousSnapshot: async () => null,
      fetchCountryEvents: async (cc) => ({ country: cc, ok: true, events: [] }),
      fetchBulkEvents: async () => { throw new Error('mirror unreachable'); },
    }),
    /bulk event export failed: mirror unreachable.*returned zero events across 20\/20 successful countries/s,
  );
});

test('fetchGdeltConflictEvents publishes bulk pagination telemetry on the primary path', async () => {
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async () => { throw new Error('DOC sweep must not run when bulk is healthy'); },
    fetchBulkEvents: async () => ({
      events: [
        {
          id: 'gdelt-event-1',
          country: 'Sudan',
          event_date: '2026-07-13',
          occurredAt: Date.parse('2026-07-13'),
          source: 'example.com',
          url: 'https://example.com/conflict',
        },
        { id: 'gdelt-event-2', country: 'Yemen', event_date: '2026-07-13' },
        { id: 'gdelt-event-3', country: 'Ukraine', event_date: '2026-07-13' },
      ],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
  });

  assert.equal(result.source, 'gdelt-bulk');
  assert.equal(result.events.length, 3);
  assert.equal(result.pagination.exportTimestamp, '20260713110000');
  assert.equal(result.pagination.exportsRequested, 8);
  assert.equal(result.pagination.exportsSucceeded, 8);
  assert.equal(result.pagination.countriesWithEvents, 3);
  assert.equal(result.pagination.rollingWindowHours, 24);
  // The sweep never ran, so its telemetry must not appear at all — 0/20 would
  // read as a failed sweep to anyone inspecting the published snapshot.
  assert.ok(!('countriesSucceeded' in result.pagination));
  assert.ok(!('countriesFailed' in result.pagination));
});

test('fetchGdeltConflictEvents carries prior bulk events through the EMA 24h window', async () => {
  const now = Date.parse('2026-07-13T18:00:00Z');
  const makeEvent = (id, hoursAgo) => {
    const gdeltAddedAt = now - hoursAgo * 60 * 60 * 1000;
    return {
      id,
      country: 'Sudan',
      event_date: new Date(gdeltAddedAt).toISOString().slice(0, 10),
      occurredAt: gdeltAddedAt,
      gdeltAddedAt,
      source: 'example.com',
      url: `https://example.com/${id}`,
    };
  };
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => now,
    fetchCountryEvents: async (cc) => ({ country: cc, ok: false, events: [], error: 'HTTP 429' }),
    fetchBulkEvents: async () => ({
      events: [makeEvent('current-1h', 1)],
      oldestExportTimestamp: '20260713160000',
      exportTimestamp: '20260713170000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
    loadPreviousSnapshot: async () => ({
      source: 'gdelt-bulk',
      events: [makeEvent('prior-12h', 12), makeEvent('stale-25h', 25)],
      pagination: {
        exportTimestamp: '20260713153000',
        rollingWindowStartedAt: now - 14 * 60 * 60 * 1000,
      },
    }),
  });

  assert.deepEqual(result.events.map(event => event.id), ['current-1h', 'prior-12h']);
  assert.equal(result.pagination.rollingWindowHours, 24);
  assert.equal(result.pagination.retainedPreviousEvents, 1);
  const windows = computeEmaWindows(new Map(), result.events, [], now);
  assert.equal(windows.get('sudan').window.at(-1), 2);
});

test('fetchGdeltConflictEvents publishes fresh bulk events when the previous snapshot read fails', async () => {
  const now = Date.parse('2026-07-13T18:00:00Z');
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => now,
    fetchCountryEvents: async (cc) => ({ country: cc, ok: false, events: [], error: 'HTTP 429' }),
    fetchBulkEvents: async () => ({
      events: [
        {
          id: 'fresh-after-redis-blip',
          country: 'Sudan',
          event_date: '2026-07-13',
          occurredAt: now - 60 * 60 * 1000,
          gdeltAddedAt: now - 60 * 60 * 1000,
        },
        { id: 'fresh-2', country: 'Yemen', event_date: '2026-07-13', occurredAt: now - 60 * 60 * 1000, gdeltAddedAt: now - 60 * 60 * 1000 },
        { id: 'fresh-3', country: 'Ukraine', event_date: '2026-07-13', occurredAt: now - 60 * 60 * 1000, gdeltAddedAt: now - 60 * 60 * 1000 },
      ],
      oldestExportTimestamp: '20260713160000',
      exportTimestamp: '20260713170000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
    loadPreviousSnapshot: async () => {
      throw new Error('Redis snapshot read failed: HTTP 503');
    },
  });

  assert.equal(result.source, 'gdelt-bulk');
  assert.ok(result.events.some(event => event.id === 'fresh-after-redis-blip'));
  assert.equal(result.events.length, 3);
  assert.equal(result.pagination.retainedPreviousEvents, 0);
  assert.equal(result.pagination.rollingWindowComplete, false);
});

test('a slow-failing bulk export does not starve the DOC sweep window (#5849)', async () => {
  // The deadline invariant budgets the bulk path's worst case (GDELT_BULK_WORST_NETWORK_MS)
  // ON TOP of the sweep window (seed-fetch-deadline-budget-invariants.test.mjs), so time the
  // bulk attempt burns must be credited back to the sweep cutoff — otherwise a hanging-then-
  // failing mirror leaves the healthy DOC fallback an already-expired budget every tick.
  let fakeTime = 0;
  let calls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => fakeTime,
    deadlineAt: 120_000,
    loadPreviousSnapshot: async () => null,
    fetchBulkEvents: async () => {
      fakeTime += 110_000; // mirror hangs through timeouts, consuming nearly the whole window
      throw new Error('mirror hanging');
    },
    fetchCountryEvents: async (cc) => {
      calls += 1;
      fakeTime += 2_000;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
  });

  assert.equal(calls, 20, `sweep must still get its full window after a slow bulk failure, attempted ${calls}/20`);
  assert.equal(result.source, 'gdelt');
});

test('fetchGdeltConflictEvents falls back to the DOC sweep when the bulk export fails', async () => {
  // Mixed DOC outcomes landing exactly on the floor, so the sweep's
  // countriesSucceeded/countriesFailed telemetry stays asserted post-#5849.
  let bulkCalls = 0;
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return docCalls <= GDELT_MIN_SUCCESSFUL_COUNTRIES
        ? { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] }
        : { country: cc, ok: false, events: [], error: 'proxy unavailable' };
    },
    fetchBulkEvents: async () => {
      bulkCalls += 1;
      throw new Error('mirror unreachable');
    },
  });

  assert.equal(bulkCalls, 1);
  assert.equal(result.source, 'gdelt');
  assert.equal(result.events.length, GDELT_MIN_SUCCESSFUL_COUNTRIES);
  assert.equal(result.pagination.countriesTotal, Object.keys(GDELT_COUNTRY_NAMES).length);
  assert.equal(result.pagination.countriesSucceeded, GDELT_MIN_SUCCESSFUL_COUNTRIES);
  assert.equal(
    result.pagination.countriesFailed,
    Object.keys(GDELT_COUNTRY_NAMES).length - GDELT_MIN_SUCCESSFUL_COUNTRIES,
  );
  assert.equal(result.pagination.minSuccessfulCountries, GDELT_MIN_SUCCESSFUL_COUNTRIES);
});

test('partial bulk export coverage logs a degradation warning; full coverage stays silent (#5849)', async (t) => {
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')); });
  const bulkFixture = (exportsSucceeded) => ({
    events: [
      { id: `warn-${exportsSucceeded}-1`, country: 'Sudan' },
      { id: `warn-${exportsSucceeded}-2`, country: 'Yemen' },
      { id: `warn-${exportsSucceeded}-3`, country: 'Ukraine' },
    ],
    exportTimestamp: '20260713110000',
    exportsRequested: 8,
    exportsSucceeded,
  });
  const opts = {
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async () => { throw new Error('DOC sweep must not run'); },
  };

  await fetchGdeltConflictEvents({ ...opts, fetchBulkEvents: async () => bulkFixture(6) });
  assert.ok(
    warns.some((w) => w.includes('partially degraded: 6/8')),
    `expected partial-degradation warn, got: ${warns.join(' | ')}`,
  );

  warns.length = 0;
  await fetchGdeltConflictEvents({ ...opts, fetchBulkEvents: async () => bulkFixture(8) });
  assert.ok(
    !warns.some((w) => w.includes('partially degraded')),
    'full export coverage must not warn',
  );
});

test('the bulk-elapsed credit cannot resurrect a window that expired before entry (#5849)', async () => {
  // deadlineAt already passed when fetchGdeltConflictEvents was entered (aux
  // feeds burned it) AND bulk fails slowly: the credit shifts the cutoff by
  // bulk time only, so the sweep still sees the pre-entry (expired) window
  // and must launch nothing.
  let fakeTime = 200_000;
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => fakeTime,
      deadlineAt: 120_000,
      loadPreviousSnapshot: async () => null,
      fetchBulkEvents: async () => {
        fakeTime += 50_000;
        throw new Error('mirror hanging');
      },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        return { country: cc, ok: true, events: [] };
      },
    }),
    /coverage below floor: 0\/20/,
  );
  assert.equal(calls, 0);
});

test('a thin cold-start bulk window falls through to the DOC sweep instead of publishing as primary (#5849)', async () => {
  // No retained rolling window + a single-country handful of events (the
  // partially-degraded-mirror shape: 1/8 exports usable) must not overwrite
  // last-good as the primary feed — it should fall through to the sweep.
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [{ id: 'thin-1', country: 'Sudan' }],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 1,
    }),
  });

  assert.equal(result.source, 'gdelt');
  assert.equal(docCalls, Object.keys(GDELT_COUNTRY_NAMES).length);
});

test('fetchGdeltConflictEvents falls through to the DOC sweep when bulk resolves with zero events (#5849)', async () => {
  // "Empty exports" is a named bulk-failure mode distinct from a thrown mirror
  // error — the guard is a resolved-but-empty payload, not a rejection.
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({ events: [], exportTimestamp: '20260713110000', exportsRequested: 8, exportsSucceeded: 8 }),
  });

  assert.equal(result.source, 'gdelt');
  assert.equal(docCalls, Object.keys(GDELT_COUNTRY_NAMES).length);
});

test('fetchGdeltConflictEvents falls through to the DOC sweep when the rolling window prunes all bulk events (#5849)', async () => {
  // Third named failure mode: exports resolve with events, but every one is
  // older than the 24h rolling window and no previous snapshot backfills it.
  const staleAddedAt = BULK_FIXTURE_NOW - 25 * 60 * 60 * 1000;
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [{ id: 'stale-26h', country: 'Sudan', event_date: '2026-07-12', occurredAt: staleAddedAt, gdeltAddedAt: staleAddedAt }],
      oldestExportTimestamp: '20260712100000',
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
  });

  assert.equal(result.source, 'gdelt');
  assert.equal(docCalls, Object.keys(GDELT_COUNTRY_NAMES).length);
});

// #5140: the sweep's former retry fanout exceeded runSeed's fetch deadline, so
// a GDELT brownout
// crashed the seeder (exit 75) instead of reaching the caught coverage-floor →
// aux-only → exit 0 path. The sweep must stop launching batches once its
// launch cutoff passes, regardless of per-country outcome. (The deadline
// arithmetic itself is pinned in seed-fetch-deadline-budget-invariants.test.mjs.)
test('fetchGdeltConflictEvents stops launching batches once the launch cutoff passes (#5140)', async () => {
  let calls = 0;
  let fakeTime = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => fakeTime,
      deadlineAt: 75_000,
      fetchBulkEvents: async () => { throw new Error('bulk unavailable'); },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        // Each request consumes 10s. The route canary is one request; healthy
        // coverage then widens to batches of four.
        fakeTime += 40_000 / 4;
        return { country: cc, ok: true, events: [] };
      },
    }),
    /coverage below floor.*sweep budget exhausted/s,
  );
  // Cutoff at 75s: canary ends at 10s, batches end at 50s and 90s, then stop.
  assert.equal(calls, 9);
});

test('fetchGdeltConflictEvents launches nothing when the phase cutoff already passed at entry (#5140)', async () => {
  // fetchAll anchors deadlineAt at fetch-phase START; if slow aux feeds (HAPI's
  // January snapshot fallback is bounded at ~315s) consume the window first,
  // the sweep must not add a single batch on top — it degrades instantly to the
  // caught floor throw.
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      deadlineAt: Date.now() - 1,
      fetchBulkEvents: async () => { throw new Error('bulk unavailable'); },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        return { country: cc, ok: true, events: [] };
      },
    }),
    /coverage below floor: 0\/20/,
  );
  assert.equal(calls, 0);
});

test('fetchGdeltConflictEvents stops sweeping once the coverage floor is unreachable (#5140)', async () => {
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      fetchBulkEvents: async () => { throw new Error('bulk unavailable'); },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        return { country: cc, ok: false, events: [], error: 'proxy unavailable' };
      },
    }),
    /coverage below floor/,
  );
  // With no successful canary, requests stay sequential. After 5 failures:
  // 0 successes + 15 remaining < the 16-country floor.
  assert.equal(calls, 5);
});

test('early-stop reason names BOTH conditions when budget and floor trip together (#5140)', async (t) => {
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')); });
  let calls = 0;
  let fakeTime = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => fakeTime,
      deadlineAt: 85_000,
      fetchBulkEvents: async () => { throw new Error('bulk unavailable'); },
      fetchCountryEvents: async (cc) => {
        calls += 1;
        fakeTime += 10_000;
        // Canary/first batch succeed; the next batch fails → the floor drifts out of reach
        // while the clock runs out, so both stop conditions hold at once.
        return calls <= 4
          ? { country: cc, ok: true, events: [] }
          : { country: cc, ok: false, events: [], error: 'down' };
      },
    }),
    /coverage below floor/,
  );
  // Before the next batch: clock 90s ≥ 85s cutoff AND
  // 4 successes + 11 remaining < 16.
  assert.equal(calls, 9);
  assert.ok(
    warns.some((w) => w.includes('sweep budget exhausted + coverage floor unreachable')),
    `expected combined stop reason in warns: ${warns.join(' | ')}`,
  );
});

test('a transient snapshot-read failure does not arm the cold-start floor (#5855 review)', async () => {
  // readSeedSnapshot(strict:true) throwing on a Redis blip must not be
  // conflated with a true first-ever run: the thin-but-real bulk window still
  // publishes instead of falling through to the load-shed DOC sweep.
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => { throw new Error('redis read failed: HTTP 500'); },
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [{ id: 'thin-but-real', country: 'Sudan' }],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
  });

  assert.equal(docCalls, 0, 'a snapshot-read blip must not route a healthy bulk tick to the DOC sweep');
  assert.equal(result.source, 'gdelt-bulk');
  assert.deepEqual(result.events.map(event => event.id), ['thin-but-real']);
});

test('partial mirror degradation is reported even when the cold-start floor rejects the tick (#5855 review)', async (t) => {
  // The 1-usable-export cold start is exactly the partially-degraded-mirror
  // shape the warning exists to expose; the floor throw must not silence it.
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')); });
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    loadPreviousSnapshot: async () => null,
    fetchCountryEvents: async (cc) => (
      { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] }
    ),
    fetchBulkEvents: async () => ({
      events: [{ id: 'thin-degraded', country: 'Sudan' }],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 1,
    }),
  });

  assert.equal(result.source, 'gdelt', 'thin cold start still falls through to the sweep');
  assert.ok(
    warns.some((w) => w.includes('partially degraded: 1/8')),
    `expected the degradation warn to fire before the floor throw, got: ${warns.join(' | ')}`,
  );
});

test('the sweep-budget credit is clamped to GDELT_BULK_WORST_NETWORK_MS on a bulk overrun (#5855 review)', async () => {
  // Bulk burns 100s against a 60s worst-case budget. The clamped credit moves
  // the 20s-old cutoff to 80s — already expired when the sweep starts at 100s —
  // so nothing launches. An unclamped credit (raw elapsed) would resurrect a
  // 120s cutoff and launch the sweep: this test goes red under that mutant.
  let fakeTime = 0;
  let docCalls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => fakeTime,
      deadlineAt: 20_000,
      loadPreviousSnapshot: async () => null,
      fetchBulkEvents: async () => {
        fakeTime += 100_000;
        throw new Error('mirror hanging');
      },
      fetchCountryEvents: async (cc) => {
        docCalls += 1;
        fakeTime += 2_000;
        return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
      },
    }),
    /sweep budget exhausted/,
  );
  assert.equal(docCalls, 0, 'the clamped credit must not resurrect the pre-bulk sweep window');
});

test('a programming defect in the bulk block crashes loud instead of impersonating a mirror outage (#5855 review)', async () => {
  // With DOC load-shed, "bulk failed" routes to a dead sweep and a quiet
  // sourceUnavailable exit 0 — the wrong runbook for a shipped code defect.
  // TypeError/ReferenceError/RangeError/SyntaxError must escape the bulk catch.
  let docCalls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      now: () => BULK_FIXTURE_NOW,
      loadPreviousSnapshot: async () => null,
      fetchCountryEvents: async (cc) => {
        docCalls += 1;
        return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
      },
      fetchBulkEvents: async () => { throw new TypeError('bulk.events.map is not a function'); },
    }),
    TypeError,
  );
  assert.equal(docCalls, 0, 'a code defect must not be reclassified as a bulk outage and routed to the sweep');
});

test('an empty current tick publishes the retained rolling window instead of discarding it (#5855 review)', async () => {
  // One quiet/glitchy 15-min tick must not abandon a healthy multi-hour window
  // for the load-shed DOC sweep: "empty exports" is a bulk failure only when
  // nothing is retained either.
  const now = Date.parse('2026-07-13T18:00:00Z');
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => now,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [],
      exportTimestamp: '20260713174500',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
    loadPreviousSnapshot: async () => ({
      source: 'gdelt-bulk',
      events: [
        { id: 'retained-1', country: 'Sudan', event_date: '2026-07-13', occurredAt: now - 2 * 60 * 60 * 1000, gdeltAddedAt: now - 2 * 60 * 60 * 1000 },
        { id: 'retained-2', country: 'Yemen', event_date: '2026-07-13', occurredAt: now - 3 * 60 * 60 * 1000, gdeltAddedAt: now - 3 * 60 * 60 * 1000 },
      ],
      pagination: { exportTimestamp: '20260713173000', rollingWindowStartedAt: now - 14 * 60 * 60 * 1000 },
    }),
  });

  assert.equal(docCalls, 0, 'an empty tick with a healthy retained window must not run the DOC sweep');
  assert.equal(result.source, 'gdelt-bulk');
  assert.deepEqual(result.events.map(event => event.id).sort(), ['retained-1', 'retained-2']);
  assert.equal(result.pagination.retainedPreviousEvents, 2);
});

test('a stale bulk export (frozen mirror) is treated as a bulk failure and falls through to the DOC sweep (#5855 review)', async () => {
  // A mirror that stops updating keeps serving the same aging exports: without
  // an age gate every tick would publish "fresh" writes while a possibly
  // healthy DOC route is never consulted.
  const now = Date.parse('2026-07-13T18:00:00Z');
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => now,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      // newest export 4h old — beyond the 3h freshness gate
      events: [
        { id: 'frozen-1', country: 'Sudan', event_date: '2026-07-13', occurredAt: now - 4 * 60 * 60 * 1000, gdeltAddedAt: now - 4 * 60 * 60 * 1000 },
        { id: 'frozen-2', country: 'Yemen', event_date: '2026-07-13', occurredAt: now - 4 * 60 * 60 * 1000, gdeltAddedAt: now - 4 * 60 * 60 * 1000 },
        { id: 'frozen-3', country: 'Ukraine', event_date: '2026-07-13', occurredAt: now - 4 * 60 * 60 * 1000, gdeltAddedAt: now - 4 * 60 * 60 * 1000 },
      ],
      exportTimestamp: '20260713140000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
    loadPreviousSnapshot: async () => null,
  });

  assert.equal(result.source, 'gdelt', 'a frozen mirror must fall through to the DOC sweep');
  assert.equal(docCalls, Object.keys(GDELT_COUNTRY_NAMES).length);
});

test('a thin bulk window after a DOC-published tick is NOT floored — the floor arms only on a true cold start (#5855 review)', async () => {
  // After GDELT DOC briefly recovers, one sweep-published tick (source 'gdelt')
  // zeroes retainedPreviousEvents on the next bulk tick. That must not re-arm
  // the cold-start floor, or recovery ping-pongs on the DOC route (#5852's
  // floor half): a previous snapshot EXISTS, so this is not a cold start.
  let docCalls = 0;
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    now: () => BULK_FIXTURE_NOW,
    fetchCountryEvents: async (cc) => {
      docCalls += 1;
      return { country: cc, ok: true, events: [{ id: `doc-${cc}`, country: GDELT_COUNTRY_NAMES[cc], event_date: '2026-07-13' }] };
    },
    fetchBulkEvents: async () => ({
      events: [{ id: 'thin-recovery', country: 'Sudan' }],
      exportTimestamp: '20260713110000',
      exportsRequested: 8,
      exportsSucceeded: 8,
    }),
    loadPreviousSnapshot: async () => ({
      source: 'gdelt',
      events: [{ id: 'doc-published', country: 'Sudan', event_date: '2026-07-13' }],
      pagination: { countriesSucceeded: 16 },
    }),
  });

  assert.equal(docCalls, 0, 'a DOC-sourced previous snapshot must not re-arm the cold-start floor');
  assert.equal(result.source, 'gdelt-bulk');
  assert.deepEqual(result.events.map(event => event.id), ['thin-recovery']);
});
