// #6080 — the MCP freshness envelope and /api/health must not disagree about
// the same seed-meta key.
//
// #6060 gave health a per-entity content dimension for PortWatch: a 174/174
// run whose decision-critical country (CN/HK) content is past a 72h budget is
// STALE_CONTENT, not OK. The MCP envelope over that same key kept answering
// only the transport/cardinality questions, so an MCP consumer read
// `stale: false` for the exact key the operator surface called content-stale.
//
// #4293 closed this identical shape on the cardinality dimension for this key
// and this tool. These tests hold the two surfaces together on the content
// dimension, and pin the `_freshnessChecks` mirror claim to health's real
// exported config rather than to a comment.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const { classifyKey, SEED_META, ACTIVATION_MARKERS } = __testing__;

const NOW = Date.parse('2026-08-02T14:42:58.000Z');
const MINUTE_MS = 60_000;
const PORTWATCH_META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const PORTWATCH_DATA_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const ACTIVATION_KEY = 'seed-activated:supply_chain:portwatch-ports:content-freshness';

// The production observation from the #6060 audit: CN last observed
// 2026-07-29T12:02:43.475Z, i.e. ~98h before the 14:42:58 health snapshot and
// therefore past the 72h content budget.
const CN_OBSERVED_AT = Date.parse('2026-07-29T12:02:43.475Z');

function contentFreshnessOf(overrides = {}) {
  return {
    budgetMinutes: 4320,
    assessedAt: NOW,
    coveredCount: 174,
    freshCount: 174,
    staleCount: 0,
    unknownCount: 0,
    staleCountries: [],
    staleCountriesTruncated: 0,
    oldestObservedAt: NOW - 60 * MINUTE_MS,
    oldestObservedCountry: 'US',
    oldestAgeMinutes: 60,
    criticalCountries: ['CN', 'HK'],
    criticalFreshCount: 2,
    criticalStaleCountries: [],
    criticalMissingCountries: 0,
    criticalOldestObservedAt: NOW - 60 * MINUTE_MS,
    criticalOldestObservedCountry: 'CN',
    criticalOldestAgeMinutes: 60,
    ...overrides,
  };
}

// A run exactly like the 12:03 UTC production run: OK, 174 seeded, complete
// coverage, zero refreshFailures. The transport half is genuinely healthy —
// which is precisely why only the content dimension can catch this.
function completeRun(contentFreshness) {
  return {
    fetchedAt: NOW - 159 * MINUTE_MS,
    recordCount: 174,
    coverage: {
      target: 174,
      referenceCountryCount: 174,
      published: 174,
      complete: true,
      missingCountries: [],
      unidentifiedMissingCount: 0,
      refreshFailures: [],
    },
    ...(contentFreshness === undefined ? {} : { contentFreshness }),
  };
}

// The audit fixture: complete transport, stale China content.
const STALE_CONTENT_META = completeRun(contentFreshnessOf({
  freshCount: 173,
  staleCount: 1,
  staleCountries: ['CN'],
  criticalFreshCount: 1,
  criticalStaleCountries: ['CN'],
  criticalOldestObservedAt: CN_OBSERVED_AT,
  criticalOldestObservedCountry: 'CN',
  criticalOldestAgeMinutes: Math.round((NOW - CN_OBSERVED_AT) / MINUTE_MS),
}));

const FRESH_META = completeRun(contentFreshnessOf());

function healthVerdict(meta, { activated = true } = {}) {
  return classifyKey(
    'portwatchPortActivity',
    PORTWATCH_DATA_KEY,
    {},
    {
      keyStrens: new Map([[PORTWATCH_DATA_KEY, 4096]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[PORTWATCH_META_KEY, JSON.stringify(meta)]]),
      keyMetaErrors: new Map(),
      activatedNames: new Set(activated ? ['portwatchContentFreshness'] : []),
      now: NOW,
    },
  );
}

// Reads the SHIPPED registry declaration rather than a hand-written check, so
// dropping the contract from cache-tools.ts fails these tests instead of
// leaving them passing against a fixture that no longer reflects production.
function portwatchCheck() {
  const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_chokepoint_status');
  assert.ok(tool, 'get_chokepoint_status must exist');
  const check = tool._freshnessChecks?.find((candidate) => candidate.key === PORTWATCH_META_KEY);
  assert.ok(check, 'get_chokepoint_status must declare a PortWatch freshness check');
  return check;
}

// `activated: null` models "the marker was never read, or the read failed" —
// the third state the map deliberately distinguishes from a read absence.
function mcpStale(meta, { activated = true } = {}) {
  return evaluateFreshness(
    [portwatchCheck()],
    [meta],
    NOW,
    activated === null ? new Map() : new Map([[ACTIVATION_KEY, activated]]),
  ).stale;
}

describe('#6080 — MCP freshness envelope vs /api/health on PortWatch content', () => {
  it('cannot report fresh for the seed-meta health calls content-stale', () => {
    const health = healthVerdict(STALE_CONTENT_META);

    assert.equal(
      health.status,
      'STALE_CONTENT',
      'precondition: health must see the audit fixture as content-stale',
    );
    assert.equal(
      mcpStale(STALE_CONTENT_META),
      true,
      'MCP must not answer stale:false for a key health calls STALE_CONTENT',
    );
  });

  it('stays fresh on both surfaces when the critical content is inside budget', () => {
    const health = healthVerdict(FRESH_META);

    assert.equal(health.status, 'OK', 'precondition: health sees a healthy run');
    assert.equal(
      mcpStale(FRESH_META),
      false,
      'the content dimension must not flip stale on a genuinely healthy run',
    );
  });

  // Mutation proof for the acceptance gate: with the content contract removed
  // from the check, the very same fixture goes back to disagreeing. This is
  // what makes the assertion above load-bearing rather than incidentally true.
  it('diverges again if the content contract is dropped from the check', () => {
    const { requireContentFreshness: _dropped, ...withoutContentDimension } = portwatchCheck();

    assert.equal(
      evaluateFreshness([withoutContentDimension], [STALE_CONTENT_META], NOW).stale,
      false,
      'without the content contract the transport+cardinality answer is fresh — the #6080 divergence',
    );
    assert.equal(
      healthVerdict(STALE_CONTENT_META).status,
      'STALE_CONTENT',
      'while health still alarms — proving the dimension is what closes the gap',
    );
  });

  // The producer's counts are a measurement taken at seeder-run time and
  // seed-meta is rewritten only on a canonical-advancing 12h run. Health
  // re-ages against read time; MCP must too, or it re-opens the divergence
  // between two runs rather than at deploy.
  it('re-ages the producer measurement on both surfaces', () => {
    // Seeder counted CN fresh at 71h. Both surfaces read that meta 12h later,
    // by which time the observation is 83h old and past the 72h budget.
    const meta = completeRun(contentFreshnessOf({
      criticalFreshCount: 2,
      criticalStaleCountries: [],
      criticalOldestObservedAt: NOW - 83 * 60 * MINUTE_MS,
      criticalOldestObservedCountry: 'CN',
      criticalOldestAgeMinutes: 71 * 60, // the producer's own frozen number
    }));

    assert.equal(healthVerdict(meta).status, 'STALE_CONTENT');
    assert.equal(mcpStale(meta), true, 'MCP must not trust the frozen producer count either');
  });
});

describe('#6080 — deployment-order grace matches health exactly', () => {
  // The producer is a 12h Railway cron; both consumers redeploy in minutes.
  // Before the first publish there is no block to read, and that must not
  // alarm — on either surface, or they disagree during the rollout window.
  const NO_BLOCK_META = completeRun(undefined);

  it('graces an absent block until the producer has published once', () => {
    assert.equal(healthVerdict(NO_BLOCK_META, { activated: false }).status, 'OK');
    assert.equal(
      mcpStale(NO_BLOCK_META, { activated: false }),
      false,
      'pre-activation absence is deploy lag, not a fault',
    );
  });

  it('fails closed once the block has disappeared after activation', () => {
    assert.equal(healthVerdict(NO_BLOCK_META, { activated: true }).status, 'COVERAGE_DEGRADED');
    assert.equal(
      mcpStale(NO_BLOCK_META, { activated: true }),
      true,
      'a producer that stops publishing the block must not read fresh',
    );
  });

  // Grace covers ABSENCE only. A present block is always evaluated, so the
  // rollout window can never be used to smuggle a broken block past either
  // surface.
  // Grace is earned by evidence, not by the absence of evidence. If the marker
  // was never read — an unreadable key, or a caller that supplies no state at
  // all — MCP must not infer "pre-activation" from its own ignorance, or a
  // Redis blip (or a future call site that forgets the argument) silently
  // disables the alarm for good.
  it('refuses grace when the marker state is unknown rather than read-absent', () => {
    assert.equal(
      mcpStale(NO_BLOCK_META, { activated: null }),
      true,
      'an unread marker must fail closed, not grant an unbounded grace',
    );
  });

  it('refuses grace when no activation state is supplied at all', () => {
    assert.equal(
      evaluateFreshness([portwatchCheck()], [NO_BLOCK_META], NOW).stale,
      true,
      'a caller that cannot supply activation state gets the fail-closed answer',
    );
  });

  // The registry test above asserts every content contract names a marker.
  // This is the runtime half of that pair: a contract WITHOUT one can never be
  // graced, so the two guards together make "grace" unreachable except through
  // a marker that was actually read.
  it('never graces a content contract that declares no activation marker', () => {
    const { contentFreshnessActivationKey: _none, ...unmarked } = portwatchCheck();

    assert.equal(
      evaluateFreshness([unmarked], [NO_BLOCK_META], NOW, new Map()).stale,
      true,
      'no marker to read means no evidence of pre-activation',
    );
  });

  it('evaluates a malformed block even before activation', () => {
    // The producer narrows its declared scope to CN, dropping HK — an attempt
    // to shrink the alarm set from the side that is being alarmed on.
    const narrowedScope = completeRun(contentFreshnessOf({
      criticalCountries: ['CN'],
      criticalFreshCount: 1,
    }));

    assert.equal(healthVerdict(narrowedScope, { activated: false }).status, 'COVERAGE_DEGRADED');
    assert.equal(
      mcpStale(narrowedScope, { activated: false }),
      true,
      'a present-but-unusable block fails closed regardless of the marker',
    );
  });
});

// Every assertion in this file is only as good as the fixture it runs on. If
// the hand-built block drifts from what the seeder actually publishes, the
// suite keeps passing while proving nothing about production.
describe('#6080 — the fixture is the shape the producer really publishes', () => {
  it('matches buildContentFreshnessReport field for field', async () => {
    const { buildContentFreshnessReport } = await import(
      '../scripts/_portwatch-content-freshness.mjs'
    );
    const real = buildContentFreshnessReport({
      countryData: new Map([
        ['CN', { fetchedAt: new Date(NOW - 60 * MINUTE_MS).toISOString() }],
        ['HK', { fetchedAt: new Date(NOW - 60 * MINUTE_MS).toISOString() }],
      ]),
      now: NOW,
    });

    assert.deepEqual(
      Object.keys(contentFreshnessOf()).sort(),
      Object.keys(real).sort(),
      'fixture and producer must publish the same field set',
    );
    // Types matter as much as names — the assessor parses counts with an
    // integer guard and timestamps with a finite-number guard, so a fixture
    // that swapped a count for an array would sail past a key-set check.
    for (const key of Object.keys(real)) {
      const fixtureValue = contentFreshnessOf()[key];
      if (real[key] === null || fixtureValue === null) continue;
      assert.equal(
        Array.isArray(fixtureValue),
        Array.isArray(real[key]),
        `${key}: fixture and producer disagree on array-ness`,
      );
      assert.equal(
        typeof fixtureValue,
        typeof real[key],
        `${key}: fixture and producer disagree on type`,
      );
    }
  });
});

describe('#6080 — the mirror claim in cache-tools.ts is enforced', () => {
  it('matches api/health.js::SEED_META field for field', () => {
    const check = portwatchCheck();
    const health = SEED_META.portwatchPortActivity;

    assert.equal(check.key, health.key);
    assert.equal(check.maxStaleMin, health.maxStaleMin);
    assert.equal(check.minRecordCount, health.minRecordCount);
    assert.deepEqual(
      check.requireContentFreshness,
      health.requireContentFreshness,
      'the consumer-pinned scope and budget must be identical on both surfaces',
    );
    assert.equal(
      check.contentFreshnessActivationKey,
      ACTIVATION_MARKERS[health.contentFreshnessActivation],
      'both surfaces must grace on the same durable marker, or their windows differ',
    );
  });

  // Acceptance: "confirm no other tool's `stale` flips as a side effect".
  // Walks the WHOLE registry, not just CACHE_TOOLS: the RPC and analysis tools
  // build their own FreshnessCheck arrays and call evaluateFreshness without
  // activation state, so a content contract declared there would be evaluated
  // with no marker to read.
  it('is the only check in the whole registry that opts into the content dimension', () => {
    const optedIn = TOOL_REGISTRY.flatMap((tool) => (tool._freshnessChecks ?? [])
      .filter((check) => check.requireContentFreshness)
      .map((check) => `${tool.name}:${check.key}`));

    assert.deepEqual(optedIn, [`get_chokepoint_status:${PORTWATCH_META_KEY}`]);
  });

  // Belt and braces for the same hole: a check that opts in without naming its
  // activation marker can never be graced, so it would alarm for a full cron
  // interval after any deploy that precedes the producer.
  it('pairs the content contract with an activation marker', () => {
    for (const tool of TOOL_REGISTRY) {
      for (const check of tool._freshnessChecks ?? []) {
        if (!check.requireContentFreshness) continue;
        assert.equal(
          typeof check.contentFreshnessActivationKey,
          'string',
          `${tool.name}:${check.key} declares a content contract with no activation marker`,
        );
      }
    }
  });
});

// The evaluator can be correct while nothing reads the marker in production.
// These drive the real executeTool against a stubbed Upstash so the dispatch
// wiring is observable rather than assumed.
describe('#6080 — executeTool reads the activation marker', () => {
  const CHOKEPOINT = CACHE_TOOLS.find((tool) => tool.name === 'get_chokepoint_status');

  // Speaks both Upstash shapes executeTool uses: `GET /get/<key>` for payloads
  // and metas, and `POST /pipeline` carrying EXISTS commands for the activation
  // markers. `markers` is the set of marker keys that exist in Redis.
  async function runWithRedis(
    stored,
    { markers = [], failActivationRead = false, activationEntryError = false } = {},
  ) {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const present = new Set(markers);
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/pipeline')) {
        if (failActivationRead) throw new TypeError('fetch failed');
        const commands = JSON.parse(init.body);
        return new Response(
          JSON.stringify(commands.map(([, key]) => (activationEntryError
            ? { error: 'ERR max request size exceeded' }
            : { result: present.has(key) ? 1 : 0 }))),
          { status: 200 },
        );
      }
      const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
      const value = Object.hasOwn(stored, key) ? stored[key] : null;
      return new Response(JSON.stringify({ result: value }), { status: 200 });
    };
    try {
      return await executeTool(CHOKEPOINT, {});
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  }

  // executeTool stamps its own Date.now(), so these fixtures are built
  // relative to real time rather than the frozen NOW above.
  function liveMeta({ criticalAgeHours }) {
    const liveNow = Date.now();
    return JSON.stringify({
      fetchedAt: liveNow - 60 * MINUTE_MS,
      recordCount: 174,
      contentFreshness: {
        budgetMinutes: 4320,
        assessedAt: liveNow,
        coveredCount: 174,
        freshCount: 174,
        staleCount: 0,
        unknownCount: 0,
        staleCountries: [],
        staleCountriesTruncated: 0,
        oldestObservedAt: liveNow - 60 * MINUTE_MS,
        oldestObservedCountry: 'US',
        oldestAgeMinutes: 60,
        criticalCountries: ['CN', 'HK'],
        criticalFreshCount: 2,
        criticalStaleCountries: [],
        criticalMissingCountries: 0,
        criticalOldestObservedAt: liveNow - criticalAgeHours * 60 * MINUTE_MS,
        criticalOldestObservedCountry: 'CN',
        criticalOldestAgeMinutes: criticalAgeHours * 60,
      },
    });
  }

  // Every other key the tool reads, fresh, so only the content dimension can
  // move `stale`.
  function baseKeys(portwatchMeta) {
    const liveNow = Date.now();
    const freshMeta = JSON.stringify({ fetchedAt: liveNow - 60_000, recordCount: 10 });
    return {
      'supply_chain:transit-summaries:v1': JSON.stringify({ ok: true }),
      'supply_chain:chokepoint_transits:v1': JSON.stringify({ ok: true }),
      'supply_chain:portwatch-ports:v1:_countries': JSON.stringify(['CN', 'HK']),
      'energy:chokepoint-baselines:v1': JSON.stringify({ ok: true }),
      'portwatch:chokepoints:ref:v1': JSON.stringify({ ok: true }),
      'energy:chokepoint-flows:v1': JSON.stringify({ ok: true }),
      'seed-meta:supply_chain:transit-summaries': freshMeta,
      'seed-meta:supply_chain:chokepoint_transits': freshMeta,
      'seed-meta:supply_chain:portwatch-ports': portwatchMeta,
      'seed-meta:energy:chokepoint-baselines': freshMeta,
      'seed-meta:portwatch:chokepoints-ref': freshMeta,
      'seed-meta:energy:chokepoint-flows': freshMeta,
    };
  }

  const blockLessMeta = () => JSON.stringify({
    fetchedAt: Date.now() - 60_000,
    recordCount: 174,
  });

  it('flags stale content end-to-end through the tool', async () => {
    const result = await runWithRedis(
      baseKeys(liveMeta({ criticalAgeHours: 98 })),
      { markers: [ACTIVATION_KEY] },
    );
    assert.equal(result.stale, true);
  });

  it('stays fresh end-to-end when critical content is inside budget', async () => {
    const result = await runWithRedis(
      baseKeys(liveMeta({ criticalAgeHours: 6 })),
      { markers: [ACTIVATION_KEY] },
    );
    assert.equal(result.stale, false);
  });

  // Proves the marker is actually READ, not just accepted as a parameter: the
  // identical block-less meta answers differently either side of the marker.
  it('lets the marker decide a block-less run, proving the read is wired', async () => {
    const preActivation = await runWithRedis(baseKeys(blockLessMeta()));
    assert.equal(preActivation.stale, false, 'marker read and absent — still in grace');

    const postActivation = await runWithRedis(
      baseKeys(blockLessMeta()),
      { markers: [ACTIVATION_KEY] },
    );
    assert.equal(postActivation.stale, true, 'marker present — the missing block is a fault');
  });

  // The marker read must not be able to take the tool down: it is a freshness
  // hint, and the payload reads all succeeded.
  it('still returns the payload when the marker read fails', async () => {
    const result = await runWithRedis(
      baseKeys(liveMeta({ criticalAgeHours: 6 })),
      { markers: [ACTIVATION_KEY], failActivationRead: true },
    );

    assert.ok(result.data, 'the tool must still return its payload');
    assert.equal(result.stale, false, 'a readable, in-budget block still answers fresh');
  });

  it('still flags stale content when the marker read fails', async () => {
    const result = await runWithRedis(
      baseKeys(liveMeta({ criticalAgeHours: 98 })),
      { markers: [ACTIVATION_KEY], failActivationRead: true },
    );

    assert.equal(result.stale, true, 'grace only ever covers an ABSENT block');
  });

  // The fail-open both review models found: post-activation, a block-less meta
  // is a producer regression, and a blip on the marker key must not be able to
  // relabel it as deploy lag.
  it('does not let a failed marker read launder a missing block into grace', async () => {
    const result = await runWithRedis(
      baseKeys(blockLessMeta()),
      { markers: [ACTIVATION_KEY], failActivationRead: true },
    );

    assert.equal(
      result.stale,
      true,
      'unknown activation state must fail closed, not re-enter an expired grace',
    );
  });

  // Upstash reports per-command failures inside a 200 pipeline response, so a
  // transport-level success can still carry an unusable entry. That entry is
  // not evidence of absence and must not be read as one.
  it('does not treat a per-command pipeline error as a read absence', async () => {
    const result = await runWithRedis(
      baseKeys(blockLessMeta()),
      { markers: [ACTIVATION_KEY], activationEntryError: true },
    );

    assert.equal(
      result.stale,
      true,
      'an errored EXISTS entry is unknown state, not a marker that is absent',
    );
  });

});

// #6080 review: hardening MCP to fail closed on an unreadable marker created a
// NARROW, DELIBERATE asymmetry with health, which softens the same condition.
// Health cannot distinguish "marker errored" from "marker absent" — it collapses
// both into `activatedNames` not containing the name (api/health.js:2026,
// `if (!r?.error && Number(r?.result) === 1)`) — so a per-command error there
// still grants the grace.
//
// The disagreement is one input class wide (block absent AND the marker read
// errors) and runs in the SAFE direction: MCP over-alarms, it never reports
// fresh for something health calls stale, which is the failure #6080 exists to
// prevent. Pinned here so the direction cannot silently flip, and tracked for
// alignment on health's side in #6095.
describe('#6080 — the one accepted divergence, and its direction', () => {
  const NO_BLOCK = completeRun(undefined);

  it('has MCP fail closed where health softens an unreadable marker', () => {
    // `activated: false` is health's error bucket as well as its absent bucket.
    assert.equal(
      healthVerdict(NO_BLOCK, { activated: false }).status,
      'OK',
      'health softens a marker it could not read',
    );
    assert.equal(
      mcpStale(NO_BLOCK, { activated: null }),
      true,
      'MCP fails closed on the same input',
    );
  });

  it('never diverges in the unsafe direction', () => {
    // The invariant that actually matters: for every activation state, MCP
    // must not answer fresh while health answers stale.
    for (const activated of [true, false, null]) {
      for (const meta of [STALE_CONTENT_META, FRESH_META, NO_BLOCK]) {
        const healthStale = healthVerdict(meta, { activated: activated === true }).status !== 'OK';
        if (!healthStale) continue;
        assert.equal(
          mcpStale(meta, { activated }),
          true,
          `MCP reported fresh where health alarmed (activated=${activated})`,
        );
      }
    }
  });
});

// The assessor's fail-closed rules are shared code, but the two surfaces reach
// them through independently-written gates, so agreement on the malformed
// shapes has to be asserted, not assumed.
describe('#6080 — both surfaces agree across the unusable state space', () => {
  const SHAPES = {
    scalar_block: 42,
    array_block: [],
    string_block: 'not-an-object',
    null_block: null,
    empty_critical_scope: contentFreshnessOf({ criticalCountries: [], criticalFreshCount: 0 }),
    narrowed_scope: contentFreshnessOf({ criticalCountries: ['CN'], criticalFreshCount: 1 }),
    counts_inconsistent: contentFreshnessOf({ freshCount: 100, staleCount: 2, unknownCount: 0 }),
    fresh_exceeds_covered: contentFreshnessOf({ freshCount: 500 }),
    critical_fresh_exceeds_declared: contentFreshnessOf({ criticalFreshCount: 9 }),
    missing_counts: contentFreshnessOf({ coveredCount: null, freshCount: null }),
  };

  for (const [label, block] of Object.entries(SHAPES)) {
    it(`fails closed on both surfaces: ${label}`, () => {
      const meta = completeRun(block);
      assert.notEqual(
        healthVerdict(meta).status,
        'OK',
        `health must not accept ${label}`,
      );
      assert.equal(mcpStale(meta), true, `MCP must not accept ${label}`);
    });
  }

  const REASON_CASES = [
    ['stale_count_unusable', { staleCount: 'unknown' }],
    ['unknown_count_unusable', { unknownCount: 'unknown' }],
    ['critical_fresh_exceeds_covered', {
      coveredCount: 1,
      freshCount: 1,
      staleCount: 0,
      unknownCount: 0,
      criticalFreshCount: 2,
    }],
  ];

  for (const [reason, overrides] of REASON_CASES) {
    it(`names the shared fail-closed reason on both surfaces: ${reason}`, () => {
      const meta = completeRun(contentFreshnessOf(overrides));
      const health = healthVerdict(meta);

      assert.equal(health.status, 'COVERAGE_DEGRADED');
      assert.ok(
        health.contentFreshness.unusableReasons.includes(reason),
        `health must expose ${reason}`,
      );
      assert.equal(mcpStale(meta), true, `MCP must fail closed for ${reason}`);
    });
  }

  // Clock skew: an observation dated in the future is an upstream clock error
  // or a forecast mislabelled as an observation — never evidence of freshness.
  it('fails closed on both surfaces for a future-dated observation', () => {
    const meta = completeRun(contentFreshnessOf({
      criticalOldestObservedAt: NOW + 60 * MINUTE_MS,
      criticalOldestAgeMinutes: -60,
    }));

    assert.equal(healthVerdict(meta).status, 'STALE_CONTENT');
    assert.equal(mcpStale(meta), true);
  });

  // The assessor compares raw milliseconds inclusively, so exactly-at-budget is
  // stale. Rounded minutes would accept up to 29,999ms over on both surfaces.
  it('agrees at the raw millisecond budget boundary', () => {
    const budgetMs = 4320 * MINUTE_MS;
    for (const extraMs of [0, 1]) {
      const meta = completeRun(contentFreshnessOf({
        criticalOldestObservedAt: NOW - (budgetMs + extraMs),
      }));
      assert.equal(healthVerdict(meta).status, 'STALE_CONTENT', `health at +${extraMs}ms`);
      assert.equal(mcpStale(meta), true, `MCP at +${extraMs}ms`);
    }
    const inside = completeRun(contentFreshnessOf({
      criticalOldestObservedAt: NOW - (budgetMs - 1),
    }));
    assert.equal(healthVerdict(inside).status, 'OK', 'health 1ms inside budget');
    assert.equal(mcpStale(inside), false, 'MCP 1ms inside budget');
  });
});
