// #6059 — consumer-price coverage deploy-before-cron rollout handshake.
//
// #6022 shipped the eight-market coverage health registry to Vercel at
// 2026-08-02 10:55 UTC, hours after that day's 02:00/02:15/02:30 UTC
// scrape→aggregate→publish window had already run. All eight coverage keys read
// EMPTY (crit) and global health sat UNHEALTHY for ~15h while the underlying
// consumer-price data was fine. These tests pin the two gates that close the
// window without letting it rot into a permanent exemption:
//
//   ACTIVATION — the producer SETs a durable, versioned, no-TTL marker only
//   after publishing real per-market coverage. One-way: strict forever after.
//   DEADLINE   — softening also stops at a wall-clock timestamp compiled into
//   api/health.js, so a missed or failed first tick escalates on its own.
//
// Runs under the repo's data-test runner (`tsx --test tests/*.test.mjs`), which
// is why the consumer-prices-core TypeScript module can be imported directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import {
  COVERAGE_ACTIVATION_SCHEMA_VERSION as CORE_SCHEMA_VERSION,
  coverageActivationKey as coreCoverageActivationKey,
  isActivatingCoverage as coreIsActivatingCoverage,
  summarizeMarketCoverage,
} from '../consumer-prices-core/src/ops/coverage.ts';
import {
  COVERAGE_ACTIVATION_SCHEMA_VERSION as FALLBACK_SCHEMA_VERSION,
  coverageActivationKey as fallbackCoverageActivationKey,
  isActivatingCoverage as fallbackIsActivatingCoverage,
  emptyCoverage,
  writeCoverageActivationMarker,
} from '../scripts/seed-consumer-prices.mjs';
import { isRolloutPendingProblem, findOperationalProblems } from '../scripts/check-seed-freshness.mjs';

const {
  classifyKey,
  healthResponseBody,
  STATUS_COUNTS,
  BOOTSTRAP_KEYS,
  SEED_META,
  ACTIVATION_MARKERS,
  ROLLOUT_PENDING_UNTIL_MS,
  CONSUMER_PRICE_HEALTH_MARKETS,
  consumerPriceCoverageActivationKey,
  consumerPriceCoverageHealthName,
} = __testing__;

// #6022 merged at 2026-08-02T10:54:58Z; its three Railway services deployed at
// ~10:55Z, after that day's window. The rollout window must not outlive one
// complete daily scrape/aggregate/publish cycle from there (AC: "expires no
// later than one complete daily window").
const DEPLOYED_AT = Date.parse('2026-08-02T10:54:58Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const US = consumerPriceCoverageHealthName('us');
const SG = consumerPriceCoverageHealthName('sg');
const AE = consumerPriceCoverageHealthName('ae');

const US_UNTIL = ROLLOUT_PENDING_UNTIL_MS[US];
const BEFORE_DEADLINE = US_UNTIL - 60_000;
const AT_DEADLINE = US_UNTIL;
const AFTER_DEADLINE = US_UNTIL + 60_000;

// Same ctx shape the handler builds (api/health.js), plus `activatedNames`.
function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {}, activated = [], now } = {}) {
  return {
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(
      Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    activatedNames: new Set(activated),
    now,
  };
}

function classifyCoverage(name, { now, activated = [], strens = {}, metaValues = {} } = {}) {
  return classifyKey(name, BOOTSTRAP_KEYS[name], { allowOnDemand: false }, makeCtx({
    now,
    activated,
    strens,
    metaValues,
  }));
}

// Mirror of the handler's overall-status computation (api/health.js). Kept local
// on purpose: the point of these assertions is the SEVERITY of the interim
// state, and ROLLOUT_PENDING is deliberately NOT subtracted from realWarnCount
// the way EMPTY_ON_DEMAND is.
function computeOverall({ crit, warn, onDemandWarn = 0, total }) {
  const realWarn = warn - onDemandWarn;
  if (crit === 0 && realWarn === 0) return 'HEALTHY';
  if (crit === 0) return 'WARNING';
  if (crit / total <= 0.03) return 'DEGRADED';
  return 'UNHEALTHY';
}

// ── Registry contract ───────────────────────────────────────────────────────

test('every consumer-price market has a durable activation marker registered', () => {
  assert.equal(CONSUMER_PRICE_HEALTH_MARKETS.length, 8);
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const name = consumerPriceCoverageHealthName(market);
    assert.equal(
      ACTIVATION_MARKERS[name],
      `seed-activated:consumer-prices:coverage:v1:${market}`,
      `${name} must be EXISTS-probed by the handler pipeline, or the marker can never revoke softening`,
    );
  }
});

test('every consumer-price market carries a bounded rollout deadline within one daily window', () => {
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const name = consumerPriceCoverageHealthName(market);
    const until = ROLLOUT_PENDING_UNTIL_MS[name];
    assert.ok(Number.isFinite(until), `${name} must declare a rollout deadline`);
    assert.ok(until > DEPLOYED_AT, `${name} deadline must be after the schema deployed`);
    assert.ok(
      until - DEPLOYED_AT <= ONE_DAY_MS,
      `${name} deadline is ${Math.round((until - DEPLOYED_AT) / 3_600_000)}h after deploy — the interim state must expire within ONE complete daily scrape/aggregate/publish window`,
    );
  }
});

test('the rollout registry covers ONLY the consumer-price coverage keys', () => {
  const expected = new Set(CONSUMER_PRICE_HEALTH_MARKETS.map(consumerPriceCoverageHealthName));
  assert.deepEqual(
    new Set(Object.keys(ROLLOUT_PENDING_UNTIL_MS)),
    expected,
    'rollout softening is a scoped, reviewed exemption — a key silently joining it would be an unbounded soften',
  );
});

test('activation key shape is identical across health, publisher, and manual fallback', () => {
  assert.equal(CORE_SCHEMA_VERSION, FALLBACK_SCHEMA_VERSION);
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const fromHealth = consumerPriceCoverageActivationKey(market);
    assert.equal(fromHealth, coreCoverageActivationKey(market));
    assert.equal(fromHealth, fallbackCoverageActivationKey(market));
    assert.equal(fromHealth, ACTIVATION_MARKERS[consumerPriceCoverageHealthName(market)]);
    assert.match(
      fromHealth,
      /^seed-activated:consumer-prices:coverage:v\d+:[a-z]{2}$/,
      'the schema version must live IN the key so a v2 coverage shape cannot inherit v1 activation',
    );
  }
});

// ── AC: deploy-before-cron does not go crit ─────────────────────────────────

test('deploy-before-cron: absent coverage key inside the window is ROLLOUT_PENDING (warn), not EMPTY', () => {
  const entry = classifyCoverage(US, { now: BEFORE_DEADLINE });
  assert.equal(entry.status, 'ROLLOUT_PENDING');
  assert.equal(STATUS_COUNTS.ROLLOUT_PENDING, 'warn');
  assert.equal(entry.records, 0, 'record count is never synthesized to make the state look populated');
  assert.equal(
    entry.rolloutPendingUntil,
    new Date(US_UNTIL).toISOString(),
    'the deadline must be on the wire so the softening is auditable from the payload alone',
  );
});

test('deploy-before-cron: all eight markets pending drives WARNING, never UNHEALTHY', () => {
  let warn = 0;
  let crit = 0;
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const entry = classifyCoverage(consumerPriceCoverageHealthName(market), { now: BEFORE_DEADLINE });
    assert.equal(entry.status, 'ROLLOUT_PENDING', `${market} must be softened independently`);
    const bucket = STATUS_COUNTS[entry.status] ?? 'warn';
    if (bucket === 'warn') warn++;
    if (bucket === 'crit') crit++;
  }
  assert.equal(crit, 0);
  assert.equal(warn, 8);
  // 253 checks / 8 crit was the observed production incident: 8/253 = 3.2% > 3%.
  assert.equal(computeOverall({ crit: 8, warn: 0, total: 253 }), 'UNHEALTHY', 'the bug being fixed');
  assert.equal(
    computeOverall({ crit: 0, warn: 8, total: 253 }),
    'WARNING',
    'the interim state must be explicit (WARNING), not silently OK and not UNHEALTHY',
  );
});

// ── AC: the interim state is bounded ────────────────────────────────────────

test('missed first tick: the same absent key is EMPTY (crit) once the deadline passes', () => {
  const entry = classifyCoverage(US, { now: AFTER_DEADLINE });
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS.EMPTY, 'crit');
  assert.equal(entry.rolloutPendingUntil, undefined);
});

test('the deadline is exclusive: at the exact boundary millisecond the key is already strict', () => {
  assert.equal(classifyCoverage(US, { now: AT_DEADLINE }).status, 'EMPTY');
  assert.equal(classifyCoverage(US, { now: AT_DEADLINE - 1 }).status, 'ROLLOUT_PENDING');
});

// ── AC: activation is one-way ───────────────────────────────────────────────

test('already activated: the marker revokes softening inside the window (absent key → EMPTY)', () => {
  const entry = classifyCoverage(US, { now: BEFORE_DEADLINE, activated: [US] });
  assert.equal(
    entry.status,
    'EMPTY',
    'a market that has published once can never fall back to a pre-activation soft state',
  );
  assert.equal(entry.rolloutPendingUntil, undefined);
});

test('successful first tick: published + activated + healthy coverage reads OK', () => {
  const entry = classifyCoverage(US, {
    now: BEFORE_DEADLINE,
    activated: [US],
    strens: { [BOOTSTRAP_KEYS[US]]: 4096 },
    metaValues: {
      [SEED_META[US].key]: {
        fetchedAt: BEFORE_DEADLINE - 60_000,
        recordCount: 11,
        coverage: { status: 'healthy', completedPages: 22, failedPages: 0, completionRatio: 1, rejectedCount: 0, retailers: [] },
      },
    },
  });
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 11);
  assert.equal(entry.rolloutPendingUntil, undefined, 'nothing about the rollout window survives a healthy market');
});

test('already activated: a stale published market stays STALE_SEED, not softened', () => {
  const entry = classifyCoverage(AE, {
    now: BEFORE_DEADLINE,
    activated: [AE],
    strens: { [BOOTSTRAP_KEYS[AE]]: 4096 },
    metaValues: {
      [SEED_META[AE].key]: {
        fetchedAt: BEFORE_DEADLINE - 3000 * 60_000, // 3000min > 1500min budget
        recordCount: 4,
        coverage: { status: 'healthy', completedPages: 12, failedPages: 0, completionRatio: 1, rejectedCount: 0 },
      },
    },
  });
  assert.equal(entry.status, 'STALE_SEED');
});

// ── AC: markets stay independently observable ───────────────────────────────

test('partial-market publication: an activated market is strict while its siblings stay pending', () => {
  const activatedEntry = classifyCoverage(US, { now: BEFORE_DEADLINE, activated: [US] });
  const pendingEntry = classifyCoverage(SG, { now: BEFORE_DEADLINE, activated: [US] });
  assert.equal(activatedEntry.status, 'EMPTY', 'US published, so its missing key is a real outage');
  assert.equal(pendingEntry.status, 'ROLLOUT_PENDING', 'SG has not published, so its absence is still explained');
});

test('partial-market publication: a market that published partial coverage is COVERAGE_PARTIAL, not softened', () => {
  const entry = classifyCoverage(SG, {
    now: BEFORE_DEADLINE,
    strens: { [BOOTSTRAP_KEYS[SG]]: 2048 },
    metaValues: {
      [SEED_META[SG].key]: {
        fetchedAt: BEFORE_DEADLINE - 60_000,
        recordCount: 10,
        coverage: {
          status: 'partial',
          completedPages: 10,
          failedPages: 1,
          completionRatio: 0.9091,
          rejectedCount: 2,
          retailers: [{ slug: 'r-a', coverageStatus: 'partial', pagesAttempted: 11, pagesSucceeded: 10 }],
        },
      },
    },
  });
  assert.equal(entry.status, 'COVERAGE_PARTIAL', 'truthful partial coverage survives the rollout window unchanged');
});

// ── The softening is confined to the "never published" branch ───────────────

test('rollout softening never reaches a key that HAS data: zero records stays EMPTY_DATA (crit)', () => {
  const entry = classifyCoverage(US, {
    now: BEFORE_DEADLINE,
    strens: { [BOOTSTRAP_KEYS[US]]: 512 },
    metaValues: { [SEED_META[US].key]: { fetchedAt: BEFORE_DEADLINE - 60_000, recordCount: 0 } },
  });
  assert.equal(
    entry.status,
    'EMPTY_DATA',
    'the key exists, so the producer ran — softening this would hide a real first-run failure',
  );
  assert.equal(STATUS_COUNTS.EMPTY_DATA, 'crit');
});

test('rollout softening never reaches a key that HAS data: missing coverage stays COVERAGE_DEGRADED', () => {
  const entry = classifyCoverage(US, {
    now: BEFORE_DEADLINE,
    strens: { [BOOTSTRAP_KEYS[US]]: 512 },
    metaValues: { [SEED_META[US].key]: { fetchedAt: BEFORE_DEADLINE - 60_000, recordCount: 4 } },
  });
  assert.equal(entry.status, 'COVERAGE_DEGRADED');
  assert.equal(entry.coverage, null, 'coverage diagnostics are never fabricated from the record count');
});

test('rollout softening never reaches an unregistered key: an absent sibling is still EMPTY', () => {
  const entry = classifyKey(
    'consumerPricesOverview',
    BOOTSTRAP_KEYS.consumerPricesOverview,
    { allowOnDemand: false },
    makeCtx({ now: BEFORE_DEADLINE }),
  );
  assert.equal(entry.status, 'EMPTY', 'only the coverage keys opted into the bounded window');
});

// ── Producer activation predicate (core + manual fallback must agree) ───────

const coverageOf = (retailers) => summarizeMarketCoverage('us', '1754000000000', retailers);

const ACTIVATION_CASES = [
  {
    name: 'real coverage with attempted pages activates',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'completed', pagesAttempted: 6, pagesSucceeded: 6, errorsCount: 0, rejectedCount: 0 },
    ]),
    expected: true,
  },
  {
    name: 'a degraded-but-real run activates (truthful report of a failing scrape)',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'failed', pagesAttempted: 6, pagesSucceeded: 0, errorsCount: 6, rejectedCount: 0 },
    ]),
    expected: true,
  },
  {
    name: 'retailers configured but zero pages ever attempted does NOT activate',
    snapshot: coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: null, pagesAttempted: 0, pagesSucceeded: 0, errorsCount: 0, rejectedCount: 0 },
    ]),
    expected: false,
  },
  { name: 'no active retailers does NOT activate', snapshot: coverageOf([]), expected: false },
  { name: 'the upstream-unavailable placeholder does NOT activate', snapshot: emptyCoverage('us'), expected: false },
  { name: 'null does NOT activate', snapshot: null, expected: false },
  { name: 'undefined does NOT activate', snapshot: undefined, expected: false },
];

for (const { name, snapshot, expected } of ACTIVATION_CASES) {
  test(`activation predicate: ${name}`, () => {
    assert.equal(coreIsActivatingCoverage(snapshot), expected, 'consumer-prices-core');
    assert.equal(fallbackIsActivatingCoverage(snapshot), expected, 'manual fallback must agree');
  });
}

test('activation is withheld from the degenerate snapshot health would otherwise see as coverage', () => {
  // summarizeMarketCoverage reports status 'degraded' for configured-but-never-run
  // retailers. That IS publishable and truthful, but it is not proof the market's
  // pipeline works — and activation is irreversible.
  const neverRan = coverageOf([
    { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: null, pagesAttempted: 0, pagesSucceeded: 0, errorsCount: 0, rejectedCount: 0 },
  ]);
  assert.equal(neverRan.status, 'degraded');
  assert.equal(neverRan.completionRatio, null);
  assert.equal(coreIsActivatingCoverage(neverRan), false);
});

// ── Manual fallback publisher ───────────────────────────────────────────────

test('manual fallback writes a durable, versioned marker after publishing real coverage', async () => {
  const sent = [];
  const wrote = await writeCoverageActivationMarker(
    'ae',
    coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'completed', pagesAttempted: 4, pagesSucceeded: 4, errorsCount: 0, rejectedCount: 0 },
    ]),
    { getCreds: () => ({ restUrl: 'https://redis.test', token: 't' }), command: (_c, cmd) => { sent.push(cmd); } },
  );

  assert.equal(wrote, true);
  assert.equal(sent.length, 1);
  const [verb, key, value, ...rest] = sent[0];
  assert.equal(verb, 'SET');
  assert.equal(key, consumerPriceCoverageActivationKey('ae'));
  assert.deepEqual(rest, [], 'NO TTL — the marker must outlive the 7d seed-meta TTL to stay one-way');
  const payload = JSON.parse(value);
  assert.equal(payload.schemaVersion, FALLBACK_SCHEMA_VERSION);
  assert.equal(payload.marketCode, 'ae');
  assert.equal(payload.attemptedPages, 4);
});

test('manual fallback withholds the marker when the coverage write failed', async () => {
  const sent = [];
  // run() passes null when the coverage key write threw, so a failed publish
  // can never activate the market off the snapshot it fetched but never stored.
  const wrote = await writeCoverageActivationMarker('ae', null, {
    getCreds: () => ({ restUrl: 'https://redis.test', token: 't' }),
    command: (_c, cmd) => { sent.push(cmd); },
  });
  assert.equal(wrote, false);
  assert.deepEqual(sent, []);
});

test('manual fallback withholds the marker for the upstream-unavailable placeholder', async () => {
  const sent = [];
  const wrote = await writeCoverageActivationMarker('ae', emptyCoverage('ae'), {
    getCreds: () => ({ restUrl: 'https://redis.test', token: 't' }),
    command: (_c, cmd) => { sent.push(cmd); },
  });
  assert.equal(wrote, false);
  assert.deepEqual(sent, [], 'a placeholder written because upstream was down must never claim activation');
});

test('manual fallback swallows a marker-write failure instead of failing the run', async () => {
  const wrote = await writeCoverageActivationMarker(
    'ae',
    coverageOf([
      { slug: 'r-a', name: 'A', lastRunAt: null, runStatus: 'completed', pagesAttempted: 4, pagesSucceeded: 4, errorsCount: 0, rejectedCount: 0 },
    ]),
    {
      getCreds: () => ({ restUrl: 'https://redis.test', token: 't' }),
      command: () => { throw new Error('Upstash HTTP 500'); },
    },
  );
  assert.equal(wrote, false, 'coverage already published; the deadline still bounds the window');
});

// ── Freshness monitor gate ──────────────────────────────────────────────────

const rolloutProblem = (over = {}) => ({
  status: 'ROLLOUT_PENDING',
  records: 0,
  rolloutPendingUntil: new Date(US_UNTIL).toISOString(),
  ...over,
});

test('the deadline survives into the compact payload the monitor actually reads', () => {
  // The monitor's fail-closed check is only as good as the field reaching it —
  // if `rolloutPendingUntil` were dropped at the response boundary the gate
  // would silently flip to "always report", turning the whole rollout window
  // back into the false red this issue exists to remove.
  // NOTE: `summary` is passed straight through by healthResponseBody, so an
  // assertion on summary.rolloutPending here would only re-read this fixture.
  // The severity that actually drives the verdict is pinned above via
  // STATUS_COUNTS + computeOverall; the sub-count is operator display only.
  const entry = classifyCoverage(US, { now: BEFORE_DEADLINE });
  const body = healthResponseBody({
    status: 'WARNING',
    summary: { total: 1, ok: 0, warn: 1, onDemandWarn: 0, staleContent: 0, rolloutPending: 1, crit: 0 },
    checkedAt: new Date(BEFORE_DEADLINE).toISOString(),
    checks: { [US]: entry },
  }, true);

  assert.equal(body.problems[US].status, 'ROLLOUT_PENDING', 'the state stays visible — softened, not hidden');
  assert.equal(body.problems[US].rolloutPendingUntil, new Date(US_UNTIL).toISOString());
  assert.equal(isRolloutPendingProblem(body.problems[US], BEFORE_DEADLINE), true);
  assert.equal(isRolloutPendingProblem(body.problems[US], AFTER_DEADLINE), false);
});

test('freshness monitor excuses a rollout-pending key only while its own deadline is in the future', () => {
  assert.equal(isRolloutPendingProblem(rolloutProblem(), BEFORE_DEADLINE), true);
  assert.equal(isRolloutPendingProblem(rolloutProblem(), AT_DEADLINE), false);
  assert.equal(isRolloutPendingProblem(rolloutProblem(), AFTER_DEADLINE), false);
});

test('freshness monitor fails closed on a missing or unparseable deadline', () => {
  assert.equal(isRolloutPendingProblem(rolloutProblem({ rolloutPendingUntil: undefined }), BEFORE_DEADLINE), false);
  assert.equal(isRolloutPendingProblem(rolloutProblem({ rolloutPendingUntil: 'soon' }), BEFORE_DEADLINE), false);
  assert.equal(isRolloutPendingProblem({ status: 'EMPTY', records: 0 }, BEFORE_DEADLINE), false);
});

test('freshness monitor drops in-window rollout keys and reports them once expired', () => {
  const payload = {
    status: 'WARNING',
    problems: {
      [US]: rolloutProblem(),
      [SG]: rolloutProblem(),
      someOtherKey: { status: 'STALE_SEED', records: 3, seedAgeMin: 900, maxStaleMin: 120 },
    },
  };
  assert.deepEqual(
    findOperationalProblems(payload, BEFORE_DEADLINE).map((p) => p.name),
    ['someOtherKey'],
  );
  assert.deepEqual(
    findOperationalProblems(payload, AFTER_DEADLINE).map((p) => p.name).sort(),
    [SG, US, 'someOtherKey'].sort(),
    'a stale compact snapshot cached from inside the window must not keep excusing the keys',
  );
});
