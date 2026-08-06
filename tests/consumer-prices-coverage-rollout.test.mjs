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
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';
import {
  COVERAGE_ACTIVATION_SCHEMA_VERSION as CORE_SCHEMA_VERSION,
  coverageActivationKey as coreCoverageActivationKey,
  isActivatingCoverage as coreIsActivatingCoverage,
  summarizeMarketCoverage,
} from '../consumer-prices-core/src/ops/coverage.ts';
import { emptyCoverage } from '../scripts/seed-consumer-prices.mjs';
import { isRolloutPendingProblem, findOperationalProblems } from '../scripts/check-seed-freshness.mjs';

const {
  classifyKey,
  healthResponseBody,
  computeOverallStatus,
  hasExpiredRolloutPending,
  STATUS_COUNTS,
  BOOTSTRAP_KEYS,
  SEED_META,
  ACTIVATION_MARKERS,
  ROLLOUT_PENDING_UNTIL_MS,
  ROLLOUT_PENDING_FROM_MS,
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

// Same ctx shape the handler builds (api/health.js), plus `activationStates`.
// That map is three-valued (#6095): every registered marker gets an entry here
// because a clean sweep reads them all, and only a marker whose EXISTS command
// FAILED is absent from the map. Modelling it as "listed = true, everything
// else = false" rather than "listed = true, everything else missing" keeps
// these fixtures on the production path instead of the unread-marker one.
function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {}, activated = [], now } = {}) {
  return {
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(
      Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    activationStates: new Map(
      Object.keys(ACTIVATION_MARKERS).map((name) => [name, activated.includes(name)]),
    ),
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

// The REAL handler arithmetic, not a replica. A test-local mirror would assert
// this change's central safety claim (ROLLOUT_PENDING stays inside realWarnCount,
// so eight softened keys still flip `overall` to WARNING rather than vanishing
// into HEALTHY) against a copy — adding `- counts.rolloutPending` in the handler
// would leave every such test green.
const computeOverall = ({ crit, warn, onDemandWarn = 0, rolloutPending = 0, total }) => computeOverallStatus(
  { ok: 0, warn, onDemandWarn, staleContent: 0, rolloutPending, crit },
  total,
).overall;

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
  // Measured against each market's OWN declared rollout start, not a single
  // historical constant: a ninth market added months from now must still be able
  // to declare a valid window, and pinning the bound to the 2026-08-02 deploy
  // would have made every future window fail this check the day it was written.
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const name = consumerPriceCoverageHealthName(market);
    const until = ROLLOUT_PENDING_UNTIL_MS[name];
    const from = ROLLOUT_PENDING_FROM_MS[name];
    assert.ok(Number.isFinite(until), `${name} must declare a rollout deadline`);
    assert.ok(Number.isFinite(from), `${name} must declare when its rollout window opened`);
    assert.ok(until > from, `${name} deadline must be after its rollout start`);
    assert.ok(
      until - from <= ONE_DAY_MS,
      `${name} window is ${Math.round((until - from) / 3_600_000)}h wide — the interim state must expire within ONE complete daily scrape/aggregate/publish window`,
    );
  }
});

test('a market added long after this rollout can still declare a valid window', () => {
  // Regression guard for the shape of the bug above: the invariant must be a
  // WINDOW LENGTH, not a distance from 2026-08-02, or the two registry tests
  // together make a future market impossible to add correctly (set-equality
  // forces it to have a deadline; a deploy-anchored bound forces that deadline
  // to already be expired).
  const future = { from: Date.parse('2027-03-01T12:00:00Z'), until: Date.parse('2027-03-02T06:00:00Z') };
  assert.ok(future.until - future.from <= ONE_DAY_MS, 'an 18h window a year from now is valid');
  assert.ok(
    future.until - DEPLOYED_AT > ONE_DAY_MS,
    'and it would have FAILED the old deploy-anchored bound — that is the bug this guards',
  );
});

// This repo has a measured 0-for-6 record on comment-based "remove me later"
// reminders in this exact file: every TRANSITIONAL entry in ON_DEMAND_KEYS
// (fxYoy, hyperliquidFlow, the two relay heartbeats, eiaPetroleum,
// digestNotifications) says "remove after ~7 days of clean production cron runs"
// and every one is still there 52-110 days on. A prose reminder is a wish, not a
// control. So the expiry is enforced the same way scripts/seed-freshness-baseline.json
// enforces its own: an `expiresAt` that HARD-FAILS once it passes
// (scripts/check-seed-freshness.mjs -> "the accepted-problem baseline expired on
// ${expiresAt}").
//
// The grace period is not politeness — issue #6059's own acceptance criteria
// require production observation across two advancing scheduled runs AFTER
// activation, so a test that reddened the moment the window shut would fire in
// the middle of the acceptance gate it exists to protect.
//
// NOTE what this forces: prune the EXPIRED per-market entries, not the mechanism.
// The handshake is reusable by design (the schema version lives in the marker
// key so a future coverage shape opens its own window); it is the dead config
// that must go.
const PRUNE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const rottedDeadlines = (registry, now, graceMs = PRUNE_GRACE_MS) => Object.entries(registry)
  .filter(([, until]) => now > until + graceMs)
  .map(([name]) => name)
  .sort();

// The live assertion below cannot fail today — that is the whole point of an
// "assert now, fail later" gate, and it is also how such a gate rots into a test
// that never had teeth. So the predicate itself is pinned here against an
// injected clock (mirroring how tests/seed-freshness-monitor.test.mjs pins the
// baseline's own expiry with at('2026-08-26') / at('2026-08-28')), and only then
// applied to the real registry.
test('the prune predicate fires exactly one grace period after a deadline closes', () => {
  const registry = { alpha: Date.parse('2026-08-03T06:00:00Z') };
  const closed = registry.alpha;

  assert.deepEqual(rottedDeadlines(registry, closed - 1), [], 'still inside the window');
  assert.deepEqual(rottedDeadlines(registry, closed + 1), [], 'window shut, grace period running');
  assert.deepEqual(rottedDeadlines(registry, closed + PRUNE_GRACE_MS), [], 'grace boundary is exclusive');
  assert.deepEqual(rottedDeadlines(registry, closed + PRUNE_GRACE_MS + 1), ['alpha'], 'grace elapsed -> prune');
  assert.deepEqual(
    rottedDeadlines({ alpha: closed, beta: closed + 30 * 24 * 60 * 60 * 1000 }, closed + PRUNE_GRACE_MS + 1),
    ['alpha'],
    'prunes only the rotted entries, never a market whose window is still open',
  );
});

test('expired rollout deadlines must be pruned from the registry', () => {
  const rotted = rottedDeadlines(ROLLOUT_PENDING_UNTIL_MS, Date.now());

  assert.deepEqual(
    rotted,
    [],
    'These rollout windows closed more than 14 days ago and are now dead config. '
    + 'Delete their entries from CONSUMER_PRICE_COVERAGE_ROLLOUT_UNTIL in api/health.js. '
    + 'If that empties the map, also remove ROLLOUT_PENDING_UNTIL_MS, the ROLLOUT_PENDING '
    + 'branch in classifyKey, its STATUS_COUNTS entry and summary.rolloutPending counter, '
    + 'isRolloutPendingProblem in scripts/check-seed-freshness.mjs, the ROLLOUT_PENDING rows '
    + 'in docs/health-endpoints.mdx + docs/zh/health-endpoints.mdx, and this test file. '
    + `Stale: ${rotted.join(', ')}`,
  );
});

test('the rollout registry covers ONLY the consumer-price coverage keys', () => {
  const expected = new Set(CONSUMER_PRICE_HEALTH_MARKETS.map(consumerPriceCoverageHealthName));
  assert.deepEqual(
    new Set(Object.keys(ROLLOUT_PENDING_UNTIL_MS)),
    expected,
    'rollout softening is a scoped, reviewed exemption — a key silently joining it would be an unbounded soften',
  );
});

test('activation key shape is identical across the health reader and the publisher', () => {
  assert.equal(CORE_SCHEMA_VERSION, 1);
  for (const market of CONSUMER_PRICE_HEALTH_MARKETS) {
    const fromHealth = consumerPriceCoverageActivationKey(market);
    assert.equal(fromHealth, coreCoverageActivationKey(market));
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

// #6095 kept ROLLOUT_PENDING soft when the marker read FAILS, deliberately and
// for a different reason than the content-freshness gate (which fails closed).
// makeCtx models a clean sweep, so every marker gets an entry and the unknown
// state is unreachable from it — this drives the third state directly, since a
// policy asserted only in a comment is a policy nothing defends.
test('an unreadable marker keeps rollout softening, and says so in the payload', () => {
  const ctx = makeCtx({ now: BEFORE_DEADLINE });
  ctx.activationStates.delete(US); // the EXISTS command failed for this market only

  const entry = classifyKey(US, BOOTSTRAP_KEYS[US], { allowOnDemand: false }, ctx);

  assert.equal(
    entry.status,
    'ROLLOUT_PENDING',
    'unknown must not manufacture a crit for a market that may genuinely never have run',
  );
  assert.equal(entry.activated, false, '`activated` reports read-AND-present, so unknown reads false');
  assert.equal(
    entry.activationUnknown,
    true,
    'and the flag distinguishes it from a market whose marker was read and found absent',
  );

  // The neighbouring market read cleanly, so it must carry no flag — otherwise
  // the assertion above would pass on a sweep that lost every marker.
  const clean = classifyKey(SG, BOOTSTRAP_KEYS[SG], { allowOnDemand: false }, ctx);
  assert.equal(clean.status, 'ROLLOUT_PENDING');
  assert.equal(clean.activationUnknown, undefined);
});

test('activation state is readable from the payload in every status, not just while pending', () => {
  // `rolloutPendingUntil` exists exactly when the market has NOT activated, so on
  // its own it can never answer "which markets have gone live?". Without a field
  // that survives activation, auditing rollout progress means EXISTS-probing
  // Redis by hand.
  const pending = classifyCoverage(US, { now: BEFORE_DEADLINE });
  assert.equal(pending.activated, false);

  const activatedButBroken = classifyCoverage(US, { now: BEFORE_DEADLINE, activated: [US] });
  assert.equal(activatedButBroken.status, 'EMPTY');
  assert.equal(
    activatedButBroken.activated,
    true,
    'an operator must be able to tell "activated then broke" from "never ran" without reading Redis',
  );

  const healthy = classifyCoverage(AE, {
    now: BEFORE_DEADLINE,
    activated: [AE],
    strens: { [BOOTSTRAP_KEYS[AE]]: 4096 },
    metaValues: {
      [SEED_META[AE].key]: {
        fetchedAt: BEFORE_DEADLINE - 60_000,
        recordCount: 11,
        coverage: { status: 'healthy', completedPages: 12, failedPages: 0, completionRatio: 1, rejectedCount: 0, retailers: [] },
      },
    },
  });
  assert.equal(healthy.status, 'OK');
  assert.equal(healthy.activated, true, 'survives into the healthy steady state');
});

test('activation state is NOT emitted for keys outside the rollout registry', () => {
  const entry = classifyKey(
    'consumerPricesOverview',
    BOOTSTRAP_KEYS.consumerPricesOverview,
    { allowOnDemand: false },
    makeCtx({ now: BEFORE_DEADLINE }),
  );
  assert.equal(entry.activated, undefined, 'the field is scoped to rollout-registered keys');
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
    computeOverall({ crit: 0, warn: 8, rolloutPending: 8, total: 253 }),
    'WARNING',
    'the interim state must be explicit (WARNING), not silently OK and not UNHEALTHY',
  );
});

test('ROLLOUT_PENDING is NOT excused from the verdict the way EMPTY_ON_DEMAND is', () => {
  // The asymmetry is the whole severity design: an unrequested on-demand key is
  // excused because nothing is on a clock; a rollout key is not, because its
  // escalation to crit IS a clock and a verdict of HEALTHY would mean nobody
  // looks at it before the deadline fires.
  assert.equal(
    computeOverall({ crit: 0, warn: 8, onDemandWarn: 8, total: 253 }),
    'HEALTHY',
    'on-demand warns are subtracted from realWarnCount',
  );
  assert.equal(
    computeOverall({ crit: 0, warn: 8, rolloutPending: 8, total: 253 }),
    'WARNING',
    'rollout warns are NOT subtracted — softening the verdict too would hide the window entirely',
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

// ── Producer activation predicate ───────────────────────────────────────────

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
  // Raw shapes: summarizeMarketCoverage normalizes through nonNegativeInt, so the
  // cases above can never exercise a malformed attemptedPages. The predicate must
  // still fail closed on one, since a future caller could hand it an unnormalized
  // payload (e.g. straight off an HTTP body).
  { name: 'a negative attemptedPages does NOT activate', snapshot: { retailers: [{}], attemptedPages: -5 }, expected: false },
  { name: 'a NaN attemptedPages does NOT activate', snapshot: { retailers: [{}], attemptedPages: Number.NaN }, expected: false },
  { name: 'a missing attemptedPages does NOT activate', snapshot: { retailers: [{}] }, expected: false },
  { name: 'a non-array retailers does NOT activate', snapshot: { retailers: 'nope', attemptedPages: 9 }, expected: false },
  { name: 'a numeric-string attemptedPages activates (Number coerces)', snapshot: { retailers: [{}], attemptedPages: '9' }, expected: true },
];

for (const { name, snapshot, expected } of ACTIVATION_CASES) {
  test(`activation predicate: ${name}`, () => {
    assert.equal(coreIsActivatingCoverage(snapshot), expected);
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

test('the manual fallback never writes an activation marker', () => {
  // It publishes the coverage key with a 30-minute TTL (TTL_COVERAGE) because it
  // is a stopgap for a broken publish.ts. Activation is permanent, so claiming it
  // off a 30-minute artifact would strand the market in an unrecoverable EMPTY
  // (crit) once the data expired but the marker did not — fixable only by
  // hand-deleting the Redis key. This test is the guard on that asymmetry.
  const src = readFileSync(new URL('../scripts/seed-consumer-prices.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /seed-activated/, 'the fallback must not construct an activation key');
  assert.doesNotMatch(src, /_upstash-rest/, 'and must not reach for the raw Redis command helper to write one');

  // The behavioural half: the short TTL that makes activation unsafe is real, and
  // it is an order of magnitude below the publisher's durable 26h key.
  assert.match(src, /const TTL_COVERAGE\s*=\s*1800;/, 'coverage key stays short-lived here');
  assert.ok(1800 * 4 < 93600, 'publish.ts writes 93600s (26h); the fallback is nowhere near durable');
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

test('freshness monitor refuses a deadline further out than one daily window', () => {
  // Proven reachable by the cross-model pass: without an independent bound here,
  // `{rolloutPendingUntil: '2099-01-01'}` is excused, so one bad deadline in the
  // payload silences these keys in CI effectively forever. The gate consumes a
  // network payload and must not take its own exemption on trust.
  assert.equal(isRolloutPendingProblem(rolloutProblem({ rolloutPendingUntil: '2099-01-01T00:00:00Z' }), BEFORE_DEADLINE), false);
  const justInside = new Date(BEFORE_DEADLINE + 23 * 60 * 60 * 1000).toISOString();
  const justOutside = new Date(BEFORE_DEADLINE + 25 * 60 * 60 * 1000).toISOString();
  assert.equal(isRolloutPendingProblem(rolloutProblem({ rolloutPendingUntil: justInside }), BEFORE_DEADLINE), true);
  assert.equal(isRolloutPendingProblem(rolloutProblem({ rolloutPendingUntil: justOutside }), BEFORE_DEADLINE), false);
});

test('a cached verdict is not served once its own rollout deadline has passed', () => {
  // The 60s verdict cache must not outlive the one value in the payload that is
  // exact to the second. Proven reachable by the cross-model pass: a snapshot
  // written just before a deadline kept serving ROLLOUT_PENDING after it.
  const pending = { status: 'ROLLOUT_PENDING', records: 0, rolloutPendingUntil: new Date(US_UNTIL).toISOString() };
  const compactSnap = { status: 'WARNING', problems: { [US]: pending } };
  const fullSnap = { status: 'WARNING', checks: { [US]: pending } };

  assert.equal(hasExpiredRolloutPending(compactSnap, BEFORE_DEADLINE), false, 'inside the window the cache is fine');
  assert.equal(hasExpiredRolloutPending(compactSnap, AFTER_DEADLINE), true, 'past it, force a fresh sweep');
  assert.equal(hasExpiredRolloutPending(fullSnap, AFTER_DEADLINE), true, 'both snapshot shapes');
  assert.equal(hasExpiredRolloutPending(compactSnap, AT_DEADLINE), true, 'boundary is inclusive of expiry');
  assert.equal(
    hasExpiredRolloutPending({ status: 'WARNING', problems: { [US]: { status: 'ROLLOUT_PENDING', records: 0 } } }, BEFORE_DEADLINE),
    true,
    'an entry that cannot prove it is still inside its window is not served warm',
  );
  assert.equal(
    hasExpiredRolloutPending({ status: 'WARNING', problems: { other: { status: 'STALE_SEED' } } }, AFTER_DEADLINE),
    false,
    'unrelated problems never force a sweep',
  );
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
