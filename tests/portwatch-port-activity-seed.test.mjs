import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  classifyDeferredPayload,
  MAX_CACHE_AGE_MS,
  MAX_COLD_FETCH_PER_RUN,
  orderColdFetchQueue,
  PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES,
} from '../scripts/seed-portwatch-port-activity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const bundleSrc = readFileSync(resolve(root, 'scripts/seed-bundle-portwatch-port-activity.mjs'), 'utf-8');
const dockerfileSrc = readFileSync(resolve(root, 'Dockerfile.seed-bundle-portwatch-port-activity'), 'utf-8');

// ── deployment wiring ────────────────────────────────────────────────────────
//
// Port activity runs as its own Railway cron service. Nothing executable can
// observe whether the image starts the right script or whether the schedule is
// registered, so these read the deployment artefacts directly — a wrong CMD or
// a missing cron entry is a silently dead service, not a test failure anywhere
// else. Seeder behaviour is covered by the runtime sections below.

describe('standalone Railway cron service', () => {
  it('starts the dedicated bundle from the image entrypoint', () => {
    assert.match(dockerfileSrc, /CMD\s*\["node",\s*"scripts\/seed-bundle-portwatch-port-activity\.mjs"\]/);
    assert.match(bundleSrc, /runBundle\('portwatch-port-activity'/);
  });

  it('ships the runtime directories the bundle imports from', () => {
    assert.match(dockerfileSrc, /COPY\s+scripts\/\s+\.\/scripts\//);
    assert.match(dockerfileSrc, /COPY\s+shared\/\s+\.\/shared\//);
  });

  it('declares the 12-hour recovery cadence and its required credentials', () => {
    const registry = JSON.parse(readFileSync(resolve(root, 'scripts/railway-services.json'), 'utf8'));
    const service = registry.find((entry) => entry.service === 'seed-bundle-portwatch-port-activity');
    assert.equal(service?.cronSchedule, '0 */12 * * *');
    assert.deepEqual(service?.requiredEnv, [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'PROXY_URL',
    ]);
  });
});

// ── runtime tests ────────────────────────────────────────────────────────────

describe('withPerCountryTimeout (runtime)', () => {
  let withPerCountryTimeout;
  before(async () => {
    ({ withPerCountryTimeout } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('aborts the per-country signal when the timer fires', async () => {
    let observedSignal;
    const p = withPerCountryTimeout(
      (signal) => {
        observedSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      'TST',
      40,
    );
    await assert.rejects(p, /per-country timeout after 0\.04s \(TST\)/);
    assert.equal(observedSignal.aborted, true);
  });

  it('resolves with the work result when work completes before the timer', async () => {
    const result = await withPerCountryTimeout((_s) => Promise.resolve({ ok: true }), 'TST', 500);
    assert.deepEqual(result, { ok: true });
  });

  it('surfaces the real error when work rejects first (not timeout message)', async () => {
    await assert.rejects(
      withPerCountryTimeout((_s) => Promise.reject(new Error('ArcGIS HTTP 500')), 'TST', 1_000),
      /ArcGIS HTTP 500/,
    );
  });
});

describe('finalisePortsForCountry (runtime, semantic equivalence)', () => {
  let finalisePortsForCountry;
  before(async () => {
    ({ finalisePortsForCountry } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('emits tankerCalls30d + trendDelta + import/export sums; anomalySignal always false', () => {
    const portAccumMap = new Map([
      ['42', {
        portname: 'Test Port',
        last30_calls: 60 * 23 + 20 * 7,
        last30_count: 30,
        last30_import: 1000,
        last30_export: 500,
        prev30_calls: 40 * 30,
      }],
    ]);
    const refMap = new Map([['42', { lat: 10, lon: 20 }]]);
    const [port] = finalisePortsForCountry(portAccumMap, refMap);
    assert.equal(port.tankerCalls30d, 60 * 23 + 20 * 7);
    assert.equal(port.importTankerDwt30d, 1000);
    assert.equal(port.exportTankerDwt30d, 500);
    const expectedTrend = Math.round(((60 * 23 + 20 * 7 - 40 * 30) / (40 * 30)) * 1000) / 10;
    assert.equal(port.trendDelta, expectedTrend);
    // anomalySignal is hardcoded false post-H+F. See finalisePortsForCountry
    // header for rationale (last7 aggregation was always empty due to
    // ArcGIS max-date lag, so the field was always false anyway).
    assert.equal(port.anomalySignal, false);
  });

  it('trendDelta=0 when prev30_calls=0', () => {
    const portAccumMap = new Map([
      ['1', { portname: 'P', last30_calls: 100, last30_count: 30, last30_import: 0, last30_export: 0, prev30_calls: 0 }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.trendDelta, 0);
    assert.equal(port.anomalySignal, false);
  });

  it('sorts desc + truncates to MAX_PORTS_PER_COUNTRY=50', () => {
    const portAccumMap = new Map();
    for (let i = 0; i < 60; i++) {
      portAccumMap.set(String(i), { portname: `P${i}`, last30_calls: 60 - i, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0 });
    }
    const out = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(out.length, 50);
    assert.equal(out[0].tankerCalls30d, 60);
    assert.equal(out[49].tankerCalls30d, 11);
  });

  it('falls back to lat/lon=0 when refMap lacks the portId', () => {
    const portAccumMap = new Map([
      ['999', { portname: 'Orphan', last30_calls: 1, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0 }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.lat, 0);
    assert.equal(port.lon, 0);
  });
});

describe('proxyFetch signal propagation (runtime)', () => {
  const require_ = createRequire(import.meta.url);
  const { proxyFetch } = require_('../scripts/_proxy-utils.cjs');

  it('rejects synchronously when called with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('test-cancel'));
    await assert.rejects(
      proxyFetch('https://example.invalid/x', { host: 'nope', port: 1, auth: 'a:b', tls: true }, {
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
      /test-cancel|aborted/,
    );
  });
});

describe('validateFn', () => {
  let validateFn;
  let shouldAdvanceCanonical;
  let shouldAdvanceCanonicalForRun;
  let PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES;

  before(async () => {
    ({
      validateFn,
      shouldAdvanceCanonical,
      shouldAdvanceCanonicalForRun,
      PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES,
    } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('accepts five countries as a usable partial snapshot', () => {
    const data = { countries: Array.from({ length: 5 }, (_, i) => `C${i}`), fetchedAt: new Date().toISOString() };
    assert.equal(validateFn(data), true);
  });

  it('rejects fewer than five countries as a usable partial snapshot', () => {
    const data = { countries: ['US', 'SA', 'GB', 'JP'], fetchedAt: new Date().toISOString() };
    assert.equal(validateFn(data), false);
  });

  it('returns false for null data', () => {
    assert.equal(validateFn(null), false);
  });

  it('keeps the 174-country target as a health floor, not the publish cursor', () => {
    assert.equal(PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES, 174);
    assert.equal(shouldAdvanceCanonical(49), false);
    assert.equal(shouldAdvanceCanonical(50), true);
    assert.equal(shouldAdvanceCanonical(139), true);
    assert.equal(shouldAdvanceCanonical(173), true);
    assert.equal(shouldAdvanceCanonical(174), true);
    assert.equal(shouldAdvanceCanonical(175), true);
  });

  it('requires real upstream contact before canonical + seed-meta advance', () => {
    assert.equal(shouldAdvanceCanonicalForRun({
      countryCount: 174,
      previousCountryCount: 174,
      referenceCountryCount: 174,
      capTriggered: true,
      upstreamContactCount: 0,
    }), false);
    assert.equal(shouldAdvanceCanonicalForRun({
      countryCount: 174,
      previousCountryCount: 174,
      referenceCountryCount: 174,
      capTriggered: true,
      upstreamContactCount: 30,
    }), true);
    assert.equal(shouldAdvanceCanonicalForRun({
      countryCount: 120,
      previousCountryCount: 174,
      referenceCountryCount: 174,
      capTriggered: false,
      upstreamContactCount: 30,
    }), false);
  });
});

describe('resolveArcgisDateField (runtime, schema-flap defence)', () => {
  let resolveArcgisDateField, _resetArcgisDateFieldCache;
  let originalFetch;

  before(async () => {
    ({ resolveArcgisDateField, _resetArcgisDateFieldCache } = await import(
      '../scripts/seed-portwatch-port-activity.mjs'
    ));
    originalFetch = globalThis.fetch;
  });

  // Sets globalThis.fetch to a stub returning `body`. Stays installed
  // until restoreFetch() — name reflects that (Greptile P2 on PR #3496:
  // the original `mockFetchOnce` name implied auto-reset semantics it
  // didn't enforce, masking accidental cache hits in future edits).
  function mockFetch(body) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
  }

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  it('returns "date" when schema reports name=date alias=date (post-revert state)', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'date', alias: 'date', type: 'esriFieldTypeDateOnly' },
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('returns "date_" when schema reports name=date_ alias=date (post-rename state)', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'date_', alias: 'date', type: 'esriFieldTypeDateOnly' },
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date_');
    } finally { restoreFetch(); }
  });

  it('memoises the resolved value across calls within a run', async () => {
    _resetArcgisDateFieldCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: [{ name: 'date_', alias: 'date', type: 'esriFieldTypeDateOnly' }],
        }),
      };
    };
    try {
      const a = await resolveArcgisDateField();
      const b = await resolveArcgisDateField();
      const c = await resolveArcgisDateField();
      assert.equal(a, 'date_');
      assert.equal(b, 'date_');
      assert.equal(c, 'date_');
      assert.equal(calls, 1, 'schema endpoint must be hit at most once per run');
    } finally { restoreFetch(); }
  });

  it('falls back to "date" when schema introspection throws', async () => {
    _resetArcgisDateFieldCache();
    globalThis.fetch = async () => { throw new Error('schema endpoint timeout'); };
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('falls back to "date" when schema response has no date field', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
        { name: 'ISO3', alias: 'ISO3', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('concurrent first-callers share one schema round-trip (promise-cache)', async () => {
    // Greptile P2 on PR #3496: cache the in-flight promise, not the
    // resolved value, so `Promise.all([resolve(), resolve(), resolve()])`
    // dispatches a single fetch. Without this, three null-checks fire
    // before any fetch settles → three round-trips.
    _resetArcgisDateFieldCache();
    let calls = 0;
    let resolveFetch;
    globalThis.fetch = () => {
      calls++;
      // Hold the fetch open so all three callers race against the same
      // unresolved promise — the bug-class this guards against.
      return new Promise((r) => {
        resolveFetch = () => r({
          ok: true,
          status: 200,
          json: async () => ({
            fields: [{ name: 'date', alias: 'date', type: 'esriFieldTypeDateOnly' }],
          }),
        });
      });
    };
    try {
      const racing = Promise.all([
        resolveArcgisDateField(),
        resolveArcgisDateField(),
        resolveArcgisDateField(),
      ]);
      // Microtask flush so the three calls have all entered the resolver
      // and registered their continuations on the cached promise.
      await Promise.resolve();
      resolveFetch();
      const [a, b, c] = await racing;
      assert.equal(a, 'date');
      assert.equal(b, 'date');
      assert.equal(c, 'date');
      assert.equal(calls, 1, 'three concurrent first-callers must share ONE schema fetch');
    } finally { restoreFetch(); }
  });
});

// WM 2026-05-13 incident: when upstream advanced ArcGIS data after two days of
// "frozen" runs, every cached country's `asof` mismatched, producing a
// 174-country cold-fetch. The 570s bundle budget couldn't cover it (preflight
// alone took 360s; batch 1 of 15 hit 12 errors at 45s before SIGTERM).
// Result: 37 hours of stale data + UptimeRobot WARNING.
//
// Fix: cap cold-fetches per run; serve the deferred countries from prior
// (slightly-stale) cache rather than dropping them. Full rotation across
// ~ceil(N / cap) runs.
describe('cold-fetch cap prevents 174-country cliff (WM 2026-05-13)', () => {
  // Hours between runs, taken from the deployed cron rather than a copy of it,
  // so re-cadencing the service re-checks the rotation invariant below.
  const cronIntervalMs = (() => {
    const registry = JSON.parse(readFileSync(resolve(root, 'scripts/railway-services.json'), 'utf8'));
    const schedule = registry.find(
      (entry) => entry.service === 'seed-bundle-portwatch-port-activity',
    )?.cronSchedule;
    const everyNHours = schedule?.match(/^0 \*\/(\d+) \* \* \*$/);
    assert.ok(everyNHours, `unhandled cron schedule: ${schedule}`);
    return Number(everyNHours[1]) * 3_600_000;
  })();

  const rotationMs = () =>
    Math.ceil(PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES / MAX_COLD_FETCH_PER_RUN) * cronIntervalMs;

  it('completes a full country rotation well inside the hard-drop age gate', () => {
    // The cap exists so one upstream asof bump cannot turn all 174 countries
    // into a single-run cold fetch. The invariant that keeps that safe is that
    // a full rotation finishes before MAX_CACHE_AGE_MS forces hard drops —
    // checked against the seeder's real constants, not a copy of them.
    assert.ok(
      rotationMs() < MAX_CACHE_AGE_MS,
      `rotation (${rotationMs() / 3_600_000}h) must finish before the ${MAX_CACHE_AGE_MS / 3_600_000}h hard drop`,
    );
  });

  it('leaves headroom rather than only just clearing the age gate', () => {
    // A rotation that barely fits would hard-drop countries on a single missed
    // cron tick, so require at least one spare run's worth of slack.
    assert.ok(rotationMs() + cronIntervalMs < MAX_CACHE_AGE_MS, 'rotation must tolerate a missed cron tick');
  });

  it('serves a deferred country from its prior payload marked stale', () => {
    // Without this fallback a deferred country DROPS from canonical output,
    // which is a hard-fail for the consumer. staleAsof preserves the shape and
    // signals "one window behind".
    const prior = { iso2: 'US', cacheWrittenAt: 1_000, ports: [{ portId: 'US-1' }] };
    const classified = classifyDeferredPayload(prior, 2_000);
    assert.equal(classified.status, 'stale');
    assert.deepEqual(classified.payload, { ...prior, staleAsof: true });
  });

  it('hard-drops a deferred payload older than the age gate instead of serving it', () => {
    // Greptile P1 on PR #3676: a country deferred across enough runs while
    // upstream was frozen could otherwise publish data past the hard-drop
    // threshold.
    const prior = { iso2: 'US', cacheWrittenAt: 0, ports: [{ portId: 'US-1' }] };
    // The boundary is inclusive: exactly at the age gate already expires.
    assert.deepEqual(classifyDeferredPayload(prior, MAX_CACHE_AGE_MS), {
      status: 'expired',
      payload: null,
    });
    assert.equal(classifyDeferredPayload(prior, MAX_CACHE_AGE_MS - 1).status, 'stale');
  });

  it('reports missing when a deferred country never had a usable payload', () => {
    assert.deepEqual(classifyDeferredPayload(null, 1_000), { status: 'missing', payload: null });
    // A payload without a numeric write timestamp cannot be age-checked, so it
    // must not be served as merely stale.
    assert.equal(classifyDeferredPayload({ iso2: 'US' }, 1_000).status, 'missing');
  });
});


// ── cold-fetch prioritisation (WM #4293 coverage-freeze fix) ──────────────────
// Never-cached countries (prevPayload=null) have no served-stale fallback.
// The oldest-attempt scheduler treats them as never-attempted, so they sort
// ahead of legacy cached countries while retaining a durable cursor once an
// attempt succeeds or fails.
describe('orderColdFetchQueue — never-attempted prioritisation', () => {
  const noCache = (iso2) => ({ iso2, prevPayload: null });
  const cached = (iso2) => ({ iso2, prevPayload: { asof: '2026-06-26', cacheWrittenAt: Date.now() } });

  it('places every no-prior-cache country ahead of every cached one', () => {
    const q = [cached('US'), noCache('MY'), cached('GB'), noCache('IE'), noCache('EC')];
    const ordered = orderColdFetchQueue(q);
    const firstCachedIdx = ordered.findIndex((it) => it.prevPayload);
    const noCacheIdxs = ordered.flatMap((it, i) => (it.prevPayload ? [] : [i]));
    assert.ok(Math.max(...noCacheIdxs) < firstCachedIdx, 'all uncached must sort before all cached');
    assert.deepEqual(ordered.slice(0, 3).map((it) => it.iso2).sort(), ['EC', 'IE', 'MY']);
  });

  it('is a permutation and fits all uncached within the 30-slot cap (16 < 30)', () => {
    const q = Array.from({ length: 16 }, (_, i) => noCache('N' + i))
      .concat(Array.from({ length: 140 }, (_, i) => cached('C' + i)));
    const ordered = orderColdFetchQueue(q);
    assert.equal(ordered.length, q.length, 'no drops');
    assert.equal(new Set(ordered.map((it) => it.iso2)).size, q.length, 'no dups');
    const inCap = new Set(ordered.slice(0, 30).map((it) => it.iso2));
    for (let i = 0; i < 16; i++) {
      assert.ok(inCap.has('N' + i), `uncached N${i} must be within the cold-fetch cap, not deferred/dropped`);
    }
  });
});
