// #6095 — an activation marker the endpoint FAILED TO READ is not evidence the
// producer has never published.
//
// #6060 gave PortWatch a deployment-order grace: the content-freshness block is
// allowed to be absent until the durable marker
// `seed-activated:supply_chain:portwatch-ports:content-freshness` proves the
// producer has written it at least once. #6080 hardened MCP so the grace needs
// POSITIVE proof — the marker was read AND came back absent — while
// /api/health and /api/seed-health still collapsed "errored" and "absent" into
// one bucket, so a per-command Redis error on the marker key re-entered a grace
// that had already been earned away.
//
// That is the green-while-dead shape the alarm family exists to prevent: an
// unreadable marker earns no grace, and a cleanly absent marker is bounded by
// the compiled rollout window. These tests drive an ERRORED `EXISTS` entry (not
// merely a missing marker) through the real handlers, because the bug lived in
// the pipeline-result loop that builds the activation map, not in the classifier
// it feeds.
//
// Run: node --test tests/activation-marker-unknown-state.test.mjs

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

const { handleHealth, __testing__ } = await import('../api/health.js');
const { handleSeedHealth } = await import('../api/seed-health.js');
const { readExistsFlags, redisPipeline } = await import('../api/_upstash-json.js');

const {
  ACTIVATION_MARKERS,
  SEED_META,
  STANDALONE_KEYS,
  ON_DEMAND_KEYS,
  ROLLOUT_PENDING_UNTIL_MS,
  CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS,
} = __testing__;

const PORTWATCH_META_KEY = SEED_META.portwatchPortActivity.key;
const PORTWATCH_MARKER = ACTIVATION_MARKERS.portwatchContentFreshness;
const PORTWATCH_DOMAIN = 'supply_chain:portwatch-ports';
const TEST_NOW = Date.parse('2026-08-03T14:42:58.000Z');
const PORTWATCH_PENDING_UNTIL = new Date(
  CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER],
).toISOString();

// The ON_DEMAND arm of the same shared marker read — see the last describe.
const FEED_HEALTH_MARKER = ACTIVATION_MARKERS.newsFeedHealth;
const FEED_HEALTH_DATA_KEY = STANDALONE_KEYS.newsFeedHealth;
const FEED_HEALTH_META_KEY = SEED_META.newsFeedHealth.key;
const FEED_HEALTH_DOMAIN = 'news:feed-health';

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

// The marker read outcomes the three surfaces must agree on. `absent` is the
// only one that earns the grace.
const PRESENT = () => ({ result: 1 });
const ABSENT = () => ({ result: 0 });
const EMPTY_ENTRY = () => ({});
// Upstash reports per-command failures inside an otherwise-successful HTTP 200
// pipeline response, so this is a live production shape, not a synthetic one.
const ERRORED = () => ({ error: 'ERR max request size exceeded' });

// A PortWatch run that is healthy on every dimension EXCEPT the content block,
// which it does not publish at all. Only the marker can decide whether that
// absence is deploy lag or a producer regression — which is exactly what makes
// it the probe for this bug.
function blockLessPortwatchMeta(now = TEST_NOW) {
  return JSON.stringify({ fetchedAt: now, recordCount: 174 });
}

// ── /api/health ─────────────────────────────────────────────────────────────

// Mirrors tests/health-verdict-snapshot.test.mjs: snapshot GET misses so every
// call runs a real sweep, the refresh lock is granted, and every unrelated key
// answers fresh so only the PortWatch content dimension can move the verdict.
function installHealthPipelineMock(
  markerEntries,
  {
    emptyDataKeys = [],
    truncateBeforeActivation = false,
    malformedPipelineBody,
    now = TEST_NOW,
    onFetch,
  } = {},
) {
  const empty = new Set(emptyDataKeys);
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([op, key]) => {
      if (op === 'STRLEN') return { result: empty.has(key) ? 0 : 100 };
      if (op === 'LLEN') return { result: empty.has(key) ? 0 : 1 };
      if (op === 'EXISTS') {
        assert.match(String(key), /^seed-activated:/, 'EXISTS is only used for activation markers');
        // Every OTHER marker reads cleanly absent, so a regression that made
        // the whole map unknown would show up as unrelated checks flipping
        // rather than as one assertion passing for the wrong reason.
        return markerEntries[key]?.() ?? { result: 0 };
      }
      if (op === 'GET' && key === PORTWATCH_META_KEY) return { result: blockLessPortwatchMeta(now) };
      // Snapshot keys included: a null GET is a cache miss, forcing the sweep.
      if (op === 'GET' && key.startsWith('health:verdict')) return { result: null };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: now, recordCount: 10_000 }) };
      return { result: 'OK' };
    });
    // A response ARRAY shorter than the command list. Upstash validates the
    // request as a whole, so the activation EXISTS commands — which sit at the
    // tail of the sweep — are exactly where a truncated or size-capped response
    // stops short. The slots are then `undefined`: not an entry carrying an
    // error, but no entry at all.
    const firstActivation = commands.findIndex(([op]) => op === 'EXISTS');
    if (malformedPipelineBody !== undefined && firstActivation !== -1) {
      return new Response(JSON.stringify(malformedPipelineBody), { status: 200 });
    }
    const body = truncateBeforeActivation && firstActivation !== -1
      ? results.slice(0, firstActivation)
      : results;
    if (typeof onFetch === 'function' && commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) {
      onFetch();
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

async function healthResponseFor(markerEntries, options) {
  installHealthPipelineMock(markerEntries, options);
  const now = options?.now ?? TEST_NOW;
  const handlerOptions = options?.useProductionClock ? undefined : { now };
  const res = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
  }), undefined, handlerOptions);
  return { res, body: await res.json() };
}

async function healthChecks(markerEntries, options) {
  return (await healthResponseFor(markerEntries, options)).body.checks ?? {};
}

async function portwatchHealthCheck(markerEntry, options) {
  const checks = await healthChecks({ [PORTWATCH_MARKER]: markerEntry }, options);
  return checks.portwatchPortActivity;
}

describe('#6095 — /api/health treats an unreadable activation marker as unknown', () => {
  it('graces a block-less run only when the marker was read and came back absent', async () => {
    const entry = await portwatchHealthCheck(ABSENT);
    assert.equal(entry?.status, 'OK', 'read-absent is the deployment-order state the grace exists for');
    assert.equal(entry?.contentFreshnessPendingUntil, PORTWATCH_PENDING_UNTIL);
  });

  // A graced check is OK, so it is filtered OUT of the compact `problems` map —
  // `summary.contentFreshnessPendingUntil` is the ONLY thing carrying the
  // deadline on the compact shape, and therefore the only thing that lets
  // hasExpiredActivationGrace refuse an expired compact snapshot. Drive it
  // through a real sweep; the other tests build that summary by hand.
  it('publishes the graced deadline in the summary a live sweep produces', async () => {
    const { body } = await healthResponseFor({ [PORTWATCH_MARKER]: ABSENT });
    assert.equal(
      body.summary?.contentFreshnessPendingUntil?.portwatchPortActivity,
      PORTWATCH_PENDING_UNTIL,
      'the sweep must accumulate per-check deadlines into the summary map',
    );
  });

  it('classifies against the wall clock after the live Redis sweep completes', async () => {
    let clock = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER] - 1;
    Date.now = () => clock;

    const { body } = await healthResponseFor(
      { [PORTWATCH_MARKER]: ABSENT },
      {
        useProductionClock: true,
        onFetch: () => {
          clock = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER] + 1;
        },
      },
    );

    assert.equal(
      body.checks?.portwatchPortActivity?.status,
      'COVERAGE_DEGRADED',
      'a sweep that crosses the deadline must use the post-read strict verdict',
    );
    assert.equal(body.checks?.portwatchPortActivity?.contentFreshnessPendingUntil, undefined);
    assert.equal(body.summary?.contentFreshnessPendingUntil, undefined);
    assert.equal(body.checkedAt, new Date(clock).toISOString());
  });

  it('fails closed once the marker proves the producer has published the block', async () => {
    const entry = await portwatchHealthCheck(PRESENT);
    assert.equal(entry?.status, 'COVERAGE_DEGRADED', 'a block that disappears after activation is a regression');
  });

  // The bug. An errored EXISTS entry says nothing about whether the producer
  // ever published, so it cannot re-open a grace the marker may already have
  // revoked — otherwise a Redis blip silently disables the content alarm.
  it('does not let an errored EXISTS entry re-enter the grace', async () => {
    const entry = await portwatchHealthCheck(ERRORED);
    assert.equal(
      entry?.status,
      'COVERAGE_DEGRADED',
      'an errored marker read is unknown state, not proof of a producer that never ran',
    );
  });

  // The same bug through a second door. "Unread" is not only an entry carrying
  // an error — it is also a slot that never arrived, and a guard written as
  // `!r?.error` is TRUE for `r === undefined`.
  //
  // #6115 moved the defence one layer OUT: redisPipeline now rejects any body
  // that is not an array of exactly commands.length entries, so a truncated
  // response never reaches the classifier at all — the request fails closed as
  // REDIS_DOWN instead. Assert THAT, not a status: a short response leaves no
  // `checks` map, so the old `assert.notEqual(checks.x?.status, 'OK')` compared
  // `undefined` and passed even with the length guard deleted. The classifier's
  // own unknown-marker behaviour is covered by the ERRORED and EMPTY_ENTRY
  // cases above, which do reach it.
  it('fails a short pipeline response closed instead of classifying it', async () => {
    const { res, body } = await healthResponseFor({}, { truncateBeforeActivation: true });
    assert.equal(res.status, 503, 'a truncated pipeline body must not produce a verdict');
    assert.equal(body.status, 'REDIS_DOWN');
    assert.equal(body.checks, undefined, 'no check may be classified from a body we never fully received');
  });

  it('does not treat an empty pipeline entry as read-absent', async () => {
    const entry = await portwatchHealthCheck(EMPTY_ENTRY);
    assert.equal(
      entry?.status,
      'COVERAGE_DEGRADED',
      'an entry without a result is unknown state, not a marker read and found absent',
    );
  });

  for (const [label, malformedPipelineBody] of [
    ['object', {}],
    ['string', 'ok'],
    ['null', null],
    ['wrong-length array', []],
  ]) {
    it(`does not produce a marker verdict from a malformed ${label} pipeline body`, async () => {
      const { res, body } = await healthResponseFor({}, { malformedPipelineBody });
      assert.equal(res.status, 503, `${label} must fail the health request closed`);
      assert.equal(body.status, 'REDIS_DOWN', `${label} must not produce a marker verdict`);
    });
  }
});

describe('#6115 — redisPipeline rejects malformed pipeline response envelopes', () => {
  for (const [label, body] of [
    ['object', {}],
    ['string', 'ok'],
    ['null', null],
    ['wrong-length array', [{ result: 0 }]],
  ]) {
    it(`returns null for a ${label} response`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      try {
        assert.equal(
          await redisPipeline([['EXISTS', 'marker-a'], ['EXISTS', 'marker-b']]),
          null,
          `${label} is not a trustworthy pipeline result envelope`,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

// readExistsFlags is the ONE parser all three surfaces now share, so its
// contract is asserted here directly rather than only through the handlers.
// Every call site happens to hand it a length-matched array today, which means
// the length clause is unreachable from them and would survive deletion — the
// exact shape a handler-only test cannot pin.
describe('#6115 — readExistsFlags is the shared three-valued marker parser', () => {
  const KEYS = ['marker-a', 'marker-b'];

  it('maps only an explicit 0 or 1 to a known state', () => {
    const states = readExistsFlags([{ result: 1 }, { result: 0 }], KEYS);
    assert.deepEqual([...states], [['marker-a', true], ['marker-b', false]]);
  });

  it('accepts the string forms Upstash may serialise', () => {
    const states = readExistsFlags([{ result: '1' }, { result: '0' }], KEYS);
    assert.deepEqual([...states], [['marker-a', true], ['marker-b', false]]);
  });

  // The old parser was `Number(r.result) === 1`, which coerced. Each of these
  // became a CONFIDENT verdict under it — `{result: null}` read as "absent"
  // (granting grace) and `{result: true}` read as "present". All must now be
  // absent from the map, i.e. unknown.
  for (const [label, entry] of [
    ['a truthy non-1 result', { result: true }],
    ['a null result', { result: null }],
    ['an out-of-range number', { result: 2 }],
    ['an out-of-range string', { result: '2' }],
    ['an array result', { result: [] }],
    ['an entry with no result at all', {}],
    ['a per-command error', { error: 'ERR max request size exceeded' }],
    ['a result alongside an error', { result: 0, error: 'ERR marker read' }],
    ['a non-object entry', 'ok'],
    ['a null entry', null],
  ]) {
    it(`leaves ${label} unknown`, () => {
      const states = readExistsFlags([entry, { result: 1 }], KEYS);
      assert.equal(states.has('marker-a'), false, `${label} must not become a verdict`);
      assert.equal(states.get('marker-b'), true, 'the sibling slot still resolves');
    });
  }

  // Fail-closed on the envelope itself: one short body must not let slot 0 be
  // read as authoritative just because it happens to be well-formed.
  for (const [label, results] of [
    ['a short array', [{ result: 0 }]],
    ['a long array', [{ result: 0 }, { result: 0 }, { result: 0 }]],
    ['a non-array', { 0: { result: 0 }, 1: { result: 0 } }],
    ['null', null],
  ]) {
    it(`returns an empty map for ${label}`, () => {
      assert.equal(readExistsFlags(results, KEYS).size, 0);
    });
  }
});

// ── /api/seed-health ────────────────────────────────────────────────────────

function installSeedHealthPipelineMock(
  markerEntries,
  { missingMetaKeys = [], malformedPipelineBody, now = TEST_NOW, onFetch } = {},
) {
  const missing = new Set(missingMetaKeys);
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const results = commands.map(([op, key]) => {
      if (op === 'EXISTS') {
        assert.match(String(key), /^seed-activated:/, 'EXISTS is only used for activation markers');
        return markerEntries[key]?.() ?? { result: 0 };
      }
      assert.equal(op, 'GET');
      if (missing.has(key)) return { result: null };
      if (key === PORTWATCH_META_KEY) return { result: blockLessPortwatchMeta(now) };
      // Keep every unrelated coverage-gated feed above its floor so only the
      // entry under test can move.
      return { result: JSON.stringify({ fetchedAt: now, recordCount: 10_000 }) };
    });
    const body = malformedPipelineBody === undefined ? results : malformedPipelineBody;
    if (typeof onFetch === 'function') onFetch();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function seedHealthResponseFor(markerEntries, options) {
  installSeedHealthPipelineMock(markerEntries, options);
  const now = options?.now ?? TEST_NOW;
  const handlerOptions = options?.useProductionClock ? undefined : { now };
  const res = await handleSeedHealth(new Request('https://api.worldmonitor.app/api/seed-health', {
    headers: { 'X-WorldMonitor-Key': 'test-health-admin-key' },
  }), handlerOptions);
  return { res, body: await res.json() };
}

async function seedHealthEntries(markerEntries, options) {
  return (await seedHealthResponseFor(markerEntries, options)).body.seeds ?? {};
}

async function portwatchSeedHealthEntry(markerEntry) {
  const seeds = await seedHealthEntries({ [PORTWATCH_MARKER]: markerEntry });
  return seeds[PORTWATCH_DOMAIN];
}

describe('#6095 — /api/seed-health treats an unreadable activation marker as unknown', () => {
  it('graces a block-less run only when the marker was read and came back absent', async () => {
    const entry = await portwatchSeedHealthEntry(ABSENT);
    assert.equal(entry?.status, 'ok');
    assert.equal(entry?.stale, false);
    assert.equal(entry?.contentFreshness, undefined, 'a graced block publishes no content verdict');
    assert.equal(entry?.contentFreshnessPendingUntil, PORTWATCH_PENDING_UNTIL);
  });

  it('classifies against the wall clock after the Redis batch completes', async () => {
    let clock = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER] - 1;
    Date.now = () => clock;

    const { body } = await seedHealthResponseFor(
      { [PORTWATCH_MARKER]: ABSENT },
      {
        useProductionClock: true,
        onFetch: () => {
          clock = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER] + 1;
        },
      },
    );
    const entry = body.seeds?.[PORTWATCH_DOMAIN];

    assert.equal(
      entry?.status,
      'coverage_degraded',
      'a batch that crosses the deadline must use the post-read strict verdict',
    );
    assert.equal(entry?.stale, true);
    assert.equal(entry?.contentFreshnessPendingUntil, undefined);
    assert.equal(body.checkedAt, clock);
  });

  it('fails closed once the marker proves the producer has published the block', async () => {
    const entry = await portwatchSeedHealthEntry(PRESENT);
    assert.equal(entry?.status, 'coverage_degraded');
    assert.equal(entry?.stale, true);
  });

  it('does not let an errored EXISTS entry re-enter the grace', async () => {
    const entry = await portwatchSeedHealthEntry(ERRORED);
    assert.equal(
      entry?.status,
      'coverage_degraded',
      'an errored marker read is unknown state, not proof of a producer that never ran',
    );
    assert.equal(entry?.stale, true);
    // Pins the flag on the has-meta path, not just the pending-activation
    // branch: this is the entry an operator actually triages, and without the
    // flag it is identical to a producer that genuinely stopped publishing.
    assert.equal(entry?.activationUnknown, true);
  });

  it('leaves the flag off when the marker was read cleanly', async () => {
    for (const outcome of [ABSENT, PRESENT]) {
      const entry = await portwatchSeedHealthEntry(outcome);
      assert.equal(entry?.activationUnknown, undefined);
    }
  });

  it('does not treat an empty pipeline entry as read-absent', async () => {
    const entry = await portwatchSeedHealthEntry(EMPTY_ENTRY);
    assert.equal(
      entry?.status,
      'coverage_degraded',
      'an entry without a result is unknown state, not a marker read and found absent',
    );
    assert.equal(entry?.activationUnknown, true);
  });

  for (const [label, malformedPipelineBody] of [
    ['object', {}],
    ['string', 'ok'],
    ['null', null],
    ['wrong-length array', []],
  ]) {
    it(`does not produce a marker verdict from a malformed ${label} pipeline body`, async () => {
      const { res, body } = await seedHealthResponseFor({}, { malformedPipelineBody });
      assert.equal(res.status, 503, `${label} must fail the seed-health request closed`);
      assert.equal(body.error, 'Redis unavailable', `${label} must not produce a marker verdict`);
    });
  }
});

// ── The deliberate asymmetry ────────────────────────────────────────────────

// #6095's audit of every ACTIVATION_MARKERS consumer landed on TWO policies,
// not one, and both are served from the same three-valued read. The rationale
// lives in comments at each gate; this pins the behaviour so the split cannot
// be flattened in either direction without a test going red — and asserts both
// arms of ONE sweep, so "the map went unknown everywhere" cannot masquerade as
// "the ON_DEMAND policy was preserved".
describe('#6095 — the ON_DEMAND grace deliberately keeps the opposite policy', () => {
  it('softens an ON_DEMAND key while failing the content check closed, in one sweep', async () => {
    const checks = await healthChecks(
      { [PORTWATCH_MARKER]: ERRORED, [FEED_HEALTH_MARKER]: ERRORED },
      { emptyDataKeys: [FEED_HEALTH_DATA_KEY] },
    );

    assert.equal(
      checks.portwatchPortActivity?.status,
      'COVERAGE_DEGRADED',
      'content freshness fails closed: its strict verdict is "cannot prove", which an unread marker makes true',
    );
    assert.equal(
      checks.newsFeedHealth?.status,
      'EMPTY_ON_DEMAND',
      'ON_DEMAND stays soft: its strict verdict is EMPTY (crit) for a key that may genuinely never have run',
    );

    // The softening above is only defensible because it is VISIBLE. Without
    // this flag an operator cannot tell a key softened on evidence from one
    // softened on a Redis blip — and for an already-activated key the blip
    // downgrades EMPTY (crit) to a status check-seed-freshness.mjs excuses.
    assert.equal(checks.newsFeedHealth?.activationUnknown, true);
    assert.equal(checks.portwatchPortActivity?.activationUnknown, true);
  });

  it('marks only the checks whose marker was actually unreadable', async () => {
    const checks = await healthChecks({ [FEED_HEALTH_MARKER]: ERRORED });

    assert.equal(checks.newsFeedHealth?.activationUnknown, true);
    assert.equal(
      checks.portwatchPortActivity?.activationUnknown,
      undefined,
      'a cleanly-read marker must not be reported as unknown',
    );
    assert.equal(
      checks.chinaCoverage?.activationUnknown,
      undefined,
      'nor may the flag leak across checks sharing the sweep',
    );
  });

  it('still revokes the ON_DEMAND softening on a marker read cleanly present', async () => {
    const checks = await healthChecks(
      { [FEED_HEALTH_MARKER]: PRESENT },
      { emptyDataKeys: [FEED_HEALTH_DATA_KEY] },
    );
    assert.equal(
      checks.newsFeedHealth?.status,
      'EMPTY',
      'a publisher that ran once and died must alarm — soft-on-unknown is not soft-on-everything',
    );
  });

  it('keeps /api/seed-health pending-activation soft when its marker is unreadable', async () => {
    const seeds = await seedHealthEntries(
      { [FEED_HEALTH_MARKER]: ERRORED },
      { missingMetaKeys: [FEED_HEALTH_META_KEY] },
    );
    assert.equal(
      seeds[FEED_HEALTH_DOMAIN]?.status,
      'pending-activation',
      'the strict verdict here is "missing", which drives overall degraded and HTTP 503',
    );
    assert.equal(
      seeds[FEED_HEALTH_DOMAIN]?.activationUnknown,
      true,
      'seed-health must mark the same window /api/health marks',
    );
  });

  it('still alarms on /api/seed-health once that marker reads cleanly present', async () => {
    const seeds = await seedHealthEntries(
      { [FEED_HEALTH_MARKER]: PRESENT },
      { missingMetaKeys: [FEED_HEALTH_META_KEY] },
    );
    assert.equal(seeds[FEED_HEALTH_DOMAIN]?.status, 'missing');
  });
});

// #6095 asked for an audit of every ACTIVATION_MARKERS consumer before changing
// the shared read. An audit written once is prose that rots: the next marker
// added inherits whichever unknown-state policy its gate happens to have, with
// nobody deciding. Assert the partition instead, so adding a marker without
// picking a side is a red test rather than a silent inheritance.
describe('#6095 — every activation marker is claimed by exactly one policy', () => {
  it('partitions ACTIVATION_MARKERS across the three gates that read it', () => {
    const contentNames = new Set(
      Object.values(SEED_META).map((cfg) => cfg.contentFreshnessActivation).filter(Boolean),
    );
    const claims = Object.fromEntries(Object.keys(ACTIVATION_MARKERS).map((name) => {
      const policies = [];
      if (contentNames.has(name)) policies.push('content-freshness: fail closed on unknown');
      if (ROLLOUT_PENDING_UNTIL_MS[name] != null) policies.push('rollout-pending: soft on unknown');
      if (ON_DEMAND_KEYS.has(name)) policies.push('on-demand: soft on unknown');
      return [name, policies];
    }));

    assert.deepEqual(
      Object.keys(claims).filter((name) => claims[name].length === 0),
      [],
      'a marker no gate reads can never revoke any softening — either wire it to a gate, or drop it',
    );
    assert.deepEqual(
      Object.entries(claims).filter(([, p]) => p.length > 1).map(([n, p]) => `${n}: ${p.join(' + ')}`),
      [],
      'two gates with different unknown-state policies would answer differently for one marker read',
    );
  });

  // The inverse hole. The partition above walks ACTIVATION_MARKERS outward; a
  // seed config naming a contentFreshnessActivation that ACTIVATION_MARKERS
  // does not register is never EXISTS-probed, so its state is permanently
  // unknown — with the fail-closed policy that means permanent
  // COVERAGE_DEGRADED, and nothing above would go red.
  it('registers every content-freshness marker a seed config names', () => {
    const unregistered = Object.entries(SEED_META)
      .filter(([, cfg]) => cfg.contentFreshnessActivation)
      .filter(([, cfg]) => !ACTIVATION_MARKERS[cfg.contentFreshnessActivation])
      .map(([name, cfg]) => `${name} -> ${cfg.contentFreshnessActivation}`);

    assert.deepEqual(
      unregistered,
      [],
      'a marker no sweep probes can never be read, so its check can never leave COVERAGE_DEGRADED',
    );
  });
});

// The read-side guard (hasExpiredActivationGrace) refuses an expired softening,
// but refusing still costs a full ~390-command sweep per concurrent waiter,
// because the refresh wait budget is shorter than a sweep. The write side must
// therefore stop the snapshot from outliving the deadline in the first place,
// so the deadline lands as an ordinary cache MISS that the refresh lock
// serialises to one sweep.
describe('#6152 review — the verdict cache cannot outlive the deadline it publishes', () => {
  const DEADLINE = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_MARKER];

  async function snapshotWritesAt(now) {
    installHealthPipelineMock({ [PORTWATCH_MARKER]: ABSENT }, { now });
    const inner = globalThis.fetch;
    const sets = [];
    globalThis.fetch = async (url, init) => {
      for (const command of JSON.parse(init.body)) {
        // Snapshot writes only — the refresh lock is also a `health:verdict:*`
        // SET and carries its own unrelated TTL.
        const key = String(command[1]);
        if (command[0] === 'SET' && key.startsWith('health:verdict') && !key.includes('refresh-lock')) {
          sets.push(command);
        }
      }
      return inner(url, init);
    };
    const res = await handleHealth(new Request('https://api.worldmonitor.app/api/health', {
      headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
    }), undefined, { now });
    const body = await res.json();
    return { sets, body };
  }

  it('shortens the TTL to the remaining grace, on both snapshot keys', async () => {
    const now = DEADLINE - 30_000;
    const { sets, body } = await snapshotWritesAt(now);

    assert.equal(
      body.summary?.contentFreshnessPendingUntil?.portwatchPortActivity,
      new Date(DEADLINE).toISOString(),
      'precondition: this sweep really did publish a deadline',
    );
    assert.equal(sets.length, 2, 'one sweep writes the full and compact snapshots together');
    for (const command of sets) {
      assert.deepEqual(
        command.slice(3),
        ['EX', '30'],
        'a snapshot promising 30s of grace must not be cacheable for the full 60s',
      );
    }
  });

  it('keeps the full TTL once no deadline is published', async () => {
    // Past the window the grace is gone, so the sweep publishes no deadline and
    // there is nothing for the TTL to be clamped to.
    const { sets, body } = await snapshotWritesAt(DEADLINE + 60_000);
    assert.equal(body.summary?.contentFreshnessPendingUntil, undefined);
    assert.equal(sets.length, 2);
    for (const command of sets) assert.deepEqual(command.slice(3), ['EX', '60']);
  });
});
