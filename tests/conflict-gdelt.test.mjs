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

test('fetchGdeltConflictEvents treats successful zero-article countries as coverage', async () => {
  const result = await fetchGdeltConflictEvents({
    pace: async () => {},
    fetchCountryEvents: async (cc) => ({ country: cc, ok: true, events: [] }),
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.pagination.countriesSucceeded, 20);
  assert.equal(result.pagination.countriesFailed, 0);
});

// #5140: the sweep's worst case (20 countries × direct+proxy retries ÷ 4
// concurrency ≈ 375s+) exceeded runSeed's fetch deadline, so a GDELT brownout
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
      fetchCountryEvents: async (cc) => {
        calls += 1;
        // Each batch of 4 consumes 40s of fake wall clock — a degraded-GDELT batch.
        fakeTime += 40_000 / 4;
        return { country: cc, ok: true, events: [] };
      },
    }),
    /coverage below floor.*sweep budget exhausted/s,
  );
  // Cutoff at 75s: batch 1 ends at 40s (< 75s → batch 2 launches), batch 2 ends
  // at 80s (≥ 75s → stop). Only 8 of 20 countries may be attempted.
  assert.equal(calls, 8);
});

test('fetchGdeltConflictEvents launches nothing when the phase cutoff already passed at entry (#5140)', async () => {
  // fetchAll anchors deadlineAt at fetch-phase START; if slow aux feeds (HAPI is
  // sequential, ~306s worst) consume the window first, the sweep must not add a
  // single batch on top — it degrades instantly to the caught floor throw.
  let calls = 0;
  await assert.rejects(
    fetchGdeltConflictEvents({
      pace: async () => {},
      deadlineAt: Date.now() - 1,
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
      fetchCountryEvents: async (cc) => {
        calls += 1;
        return { country: cc, ok: false, events: [], error: 'proxy unavailable' };
      },
    }),
    /coverage below floor/,
  );
  // After 2 all-failed batches: 0 successes + 12 remaining < 16 floor → no third batch.
  assert.equal(calls, 8);
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
      deadlineAt: 115_000,
      fetchCountryEvents: async (cc) => {
        calls += 1;
        fakeTime += 10_000;
        // Batch 1 succeeds; later batches fail → the floor drifts out of reach
        // while the clock runs out, so both stop conditions hold at once.
        return calls <= 4
          ? { country: cc, ok: true, events: [] }
          : { country: cc, ok: false, events: [], error: 'down' };
      },
    }),
    /coverage below floor/,
  );
  // Before batch 4: clock 120s ≥ 115s cutoff AND 4 successes + 8 remaining < 16.
  assert.equal(calls, 12);
  assert.ok(
    warns.some((w) => w.includes('sweep budget exhausted + coverage floor unreachable')),
    `expected combined stop reason in warns: ${warns.join(' | ')}`,
  );
});
