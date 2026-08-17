/**
 * Issue #5736 — history ingestion needs a durable health signal.
 *
 * `appendSeedHistory` is fail-open by contract: the canonical publish has
 * already committed when the hook runs, so every history failure logs a warning
 * and returns. Before this, nothing outside the log stream could tell that
 * history had stopped accumulating — a missing RELAY_SHARED_SECRET or a
 * systematically rejecting relay produced a healthy-looking seed run forever.
 *
 * These tests pin the three halves of the fix:
 *   1. the pure state machine (`describeHistoryAppendOutcome` +
 *      `projectHistoryIngestHealth`) — states, error codes, and which fields
 *      freeze while the relay is down;
 *   2. `recordHistoryIngestHealth` — what it writes, and that it stays
 *      fail-open and read-consistent when Upstash misbehaves;
 *   3. the end-to-end gap that motivated the issue: a prolonged relay rejection
 *      MUST become visible in /api/health and /api/seed-health while the
 *      collector's own canonical publication keeps reporting healthy.
 *
 * Run: ./node_modules/.bin/tsx --test tests/seed-history-ingest-health.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import sovereignStatus from '../scripts/shared/sovereign-status.json' with { type: 'json' };

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
};

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
// Pins currentResilienceCacheFormula() to 'pc' so the seed-health data probe
// below is answerable — mirrors tests/seed-health-portwatch-port-activity.test.mjs.
process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';

const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v11:US';
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const EDUCATION_META_KEY = 'seed-meta:resilience:education-attainment';
const EDUCATION_DATA_KEY = 'resilience:education-attainment:v1';
const PORTWATCH_META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY =
  'seed-activated:supply_chain:portwatch-ports:content-freshness';

const {
  appendSeedHistory,
  makeSeedHistoryAfterPublish,
  HISTORY_INGEST_ALARM_AFTER_FAILURES,
  HISTORY_INGEST_SOURCE_VERSION,
  HISTORY_INGEST_TTL_SECONDS,
  describeHistoryAppendOutcome,
  historyIngestActivationKey,
  historyIngestErrorCode,
  historyIngestHealthKey,
  historyIngestMetaKey,
  projectHistoryIngestHealth,
  recordHistoryIngestHealth,
} = await import('../scripts/_seed-history.mjs');

const { __testing__: healthTesting } = await import('../api/health.js');
const { default: seedHealthHandler } = await import('../api/seed-health.js');

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const DOMAIN = 'conflict';
const RESOURCE = 'acled-intel';
const AT = Date.UTC(2026, 6, 28, 12, 0, 0);
const MINUTE = 60_000;

/** One successful relay append. */
const SUCCESS = { inserted: 7, skipped: 3, chunks: 1, abandoned: 0, failedChunks: 0 };

function project(previous, { result = null, error = null, at = AT, runId = 'run-1' } = {}) {
  return projectHistoryIngestHealth(previous, {
    domain: DOMAIN,
    resource: RESOURCE,
    runId,
    at,
    outcome: describeHistoryAppendOutcome(result, error),
  });
}

function relayRejection(status = 401) {
  const err = new Error(`intel-history relay returned HTTP ${status}: unauthorized`);
  err.name = 'SeedHistoryError';
  err.status = status;
  return err;
}

// ── The pure state machine ────────────────────────────────────────────────────

describe('projectHistoryIngestHealth', () => {
  it('records a successful append as healthy and advances fetchedAt', () => {
    const { record, meta } = project(null, { result: SUCCESS });

    assert.equal(record.state, 'healthy');
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.lastSuccessAt, AT);
    assert.equal(record.lastHealthyAt, AT);
    assert.equal(record.lastInserted, 7);
    assert.equal(record.lastDeduped, 3);
    assert.equal(record.lastErrorCode, null);

    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.recordCount, 10, 'relay-accepted volume is inserted + deduped');
    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.sourceVersion, HISTORY_INGEST_SOURCE_VERSION);
  });

  it('reports an unconfigured relay as a distinct, non-alarming state', () => {
    const { record, meta } = project(null, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET', 'OPENROUTER_API_KEY'] },
    });

    assert.equal(record.state, 'unconfigured');
    assert.deepEqual(record.missingConfig, ['RELAY_SHARED_SECRET', 'OPENROUTER_API_KEY']);
    assert.equal(record.lastSuccessAt, null, 'nothing was ever appended');
    // fetchedAt advances so an un-provisioned deployment reads as
    // NOT_CONFIGURED forever instead of decaying into an unclearable stale warn.
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'unavailable');
    assert.equal(meta.consecutiveFailures, 0);
  });

  it('freezes fetchedAt from the first failure and escalates at the alarm threshold', () => {
    const healthy = project(null, { result: SUCCESS }).record;

    const first = project(healthy, { result: null, error: relayRejection(401), at: AT + MINUTE });
    assert.equal(first.record.state, 'failing');
    assert.equal(first.record.consecutiveFailures, 1);
    assert.equal(first.record.lastAttemptAt, AT + MINUTE);
    assert.equal(first.meta.fetchedAt, AT, 'the last HEALTHY append, not the last attempt');
    assert.equal(
      first.meta.sourceState,
      'ok',
      'one failed tick is not yet the prolonged failure worth alarming on',
    );

    const second = project(first.record, {
      result: null,
      error: relayRejection(401),
      at: AT + 2 * MINUTE,
    });
    assert.equal(second.record.consecutiveFailures, 2);
    assert.equal(second.meta.fetchedAt, AT);
    assert.equal(second.meta.sourceState, 'degraded');
    assert.equal(second.meta.lastErrorCode, 'http_401');
    assert.equal(second.record.lastErrorReason, 'intel-history relay returned HTTP 401: unauthorized');

    assert.equal(
      HISTORY_INGEST_ALARM_AFTER_FAILURES,
      2,
      'the escalation point is a pinned contract, not an implementation detail',
    );
  });

  it('holds the last known good volume while the relay is down', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const failing = project(healthy, { error: relayRejection(500), at: AT + MINUTE });

    assert.equal(
      failing.meta.recordCount,
      10,
      'a down relay must not be reported as a contradictory zero-record run',
    );
    assert.equal(failing.record.lastSuccessAt, AT);
  });

  it('has no healthy timestamp when the very first append fails', () => {
    const { record, meta } = project(null, { error: relayRejection(403) });

    assert.equal(record.lastHealthyAt, null);
    assert.equal(record.lastSuccessAt, null);
    assert.equal(meta.fetchedAt, null, 'never-ingested + failing must classify as stale');
    assert.equal(meta.recordCount, 0);
  });

  it('clears the failure count on recovery but keeps the last error for post-mortem', () => {
    let state = project(null, { error: relayRejection(401) }).record;
    state = project(state, { error: relayRejection(401), at: AT + MINUTE }).record;
    const recovered = project(state, { result: SUCCESS, at: AT + 2 * MINUTE });

    assert.equal(recovered.record.state, 'healthy');
    assert.equal(recovered.record.consecutiveFailures, 0);
    assert.equal(recovered.meta.sourceState, 'ok');
    assert.equal(recovered.meta.fetchedAt, AT + 2 * MINUTE);
    assert.equal(recovered.record.lastErrorCode, 'http_401');
    assert.equal(recovered.record.lastErrorAt, AT + MINUTE);
  });

  it('ignores a corrupt or non-object previous record instead of throwing', () => {
    for (const previous of [null, undefined, 'garbage', 42, []]) {
      const { record } = project(previous, { error: relayRejection(500) });
      assert.equal(record.consecutiveFailures, 1);
    }
  });

  // ── Runs that reached nothing ──────────────────────────────────────────────
  //
  // appendSeedHistory RESOLVES rather than throws when its wall-clock budget
  // dies before a single chunk is POSTed; it only throws on
  // `chunks === 0 && failedChunks > 0`. Treating that as healthy would advance
  // fetchedAt on a run that delivered nothing.

  it('treats a run where no chunk reached the relay as failing, not healthy', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const budgetDied = {
      inserted: 0, skipped: 0, chunks: 0, abandoned: 12, failedChunks: 0,
    };

    const { record, meta } = project(healthy, { result: budgetDied, at: AT + MINUTE });

    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'budget_exhausted');
    assert.equal(record.consecutiveFailures, 1);
    assert.equal(
      meta.fetchedAt,
      AT,
      'a run that delivered nothing must not advance the healthy clock',
    );
  });

  it('escalates a relay that eats the budget on every run', () => {
    const budgetDied = {
      inserted: 0, skipped: 0, chunks: 0, abandoned: 12, failedChunks: 0,
    };
    let state = project(null, { result: SUCCESS }).record;
    let projected;
    for (let tick = 1; tick <= 2; tick++) {
      projected = project(state, { result: budgetDied, at: AT + tick * MINUTE });
      state = projected.record;
    }
    assert.equal(projected.meta.sourceState, 'degraded');
  });

  it('keeps a run with no candidate records healthy', () => {
    // Nothing was offered, so nothing was lost — distinct from "offered and
    // dropped" above. appendSeedHistory returns this without touching the relay.
    const empty = { inserted: 0, skipped: 0, chunks: 0, abandoned: 0, failedChunks: 0 };
    const { record, meta } = project(null, { result: empty });

    assert.equal(record.state, 'healthy');
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'ok');
  });

  it('escalates a collector that loses chunks on every run', () => {
    const lossy = { inserted: 4, skipped: 0, chunks: 1, abandoned: 0, failedChunks: 2 };

    // Never a hard failure — every run reaches the relay and delivers
    // something, so the total-failure counter alone would sit at zero forever
    // while records are dropped on every tick.
    let state = project(null, { result: SUCCESS }).record;
    let projected;
    for (let tick = 1; tick <= 2; tick++) {
      projected = project(state, { result: lossy, at: AT + tick * MINUTE });
      state = projected.record;
    }

    assert.equal(projected.record.state, 'healthy');
    assert.equal(projected.record.lastFailedChunks, 2);
    assert.equal(
      projected.meta.fetchedAt,
      AT + 2 * MINUTE,
      'the relay is reachable, so this is not staleness',
    );
    assert.equal(projected.meta.sourceState, 'degraded', 'but the loss must surface');
  });

  it('lets a clean run clear a lossy streak', () => {
    const lossy = { inserted: 4, skipped: 0, chunks: 1, abandoned: 0, failedChunks: 2 };
    const dropped = project(project(null, { result: SUCCESS }).record, {
      result: lossy,
      at: AT + MINUTE,
    }).record;
    assert.equal(dropped.consecutiveFailures, 1);

    const clean = project(dropped, { result: SUCCESS, at: AT + 2 * MINUTE });
    assert.equal(clean.record.consecutiveFailures, 0);
    assert.equal(clean.meta.sourceState, 'ok');
  });

  // ── Credential removed after a success ────────────────────────────────────

  it('treats a credential removed after a success as a regression, not an opt-out', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const { record, meta } = project(healthy, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
      at: AT + MINUTE,
    });

    assert.equal(record.state, 'unconfigured');
    assert.deepEqual(record.missingConfig, ['RELAY_SHARED_SECRET']);
    assert.equal(record.lastErrorCode, 'config_removed');
    assert.equal(record.consecutiveFailures, 1);
    assert.equal(
      meta.fetchedAt,
      AT,
      'the staleness clock must not reset when a working relay loses its credential',
    );
    assert.equal(
      meta.sourceState,
      'degraded',
      'no threshold: a variable is either configured or it is not',
    );
  });

  it('keeps a never-provisioned deployment silent', () => {
    // The distinguishing fact is lastSuccessAt: absent here, present above.
    let state = project(null, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
    }).record;
    assert.equal(state.lastSuccessAt, null);

    for (let tick = 1; tick <= 5; tick++) {
      const next = project(state, {
        result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
        at: AT + tick * MINUTE,
      });
      state = next.record;
      assert.equal(next.meta.sourceState, 'unavailable');
      assert.equal(next.meta.fetchedAt, AT + tick * MINUTE);
      assert.equal(next.record.consecutiveFailures, 0);
    }
  });
});

describe('historyIngestErrorCode', () => {
  it('prefers the transport facts an operator acts on', () => {
    assert.equal(historyIngestErrorCode(relayRejection(429)), 'http_429');

    const budget = new Error('intel-history relay budget exhausted');
    budget.budgetExhausted = true;
    budget.name = 'SeedHistoryError';
    assert.equal(historyIngestErrorCode(budget), 'budget_exhausted');
  });

  it('falls back to a stable code derived from the error class', () => {
    const embedder = new Error('embeddings provider returned HTTP 402');
    embedder.name = 'EmbeddingProviderError';
    assert.equal(historyIngestErrorCode(embedder), 'embedding_provider_error');
    assert.equal(historyIngestErrorCode(new Error('boom')), 'error');
    assert.equal(historyIngestErrorCode(null), null);
  });
});

// ── The Redis writer ──────────────────────────────────────────────────────────

/**
 * Upstash stub. `getResult` is the raw string the record GET returns (null =
 * key absent). Captures every pipeline body so key names and TTLs are testable.
 */
function stubUpstash({ getResult = null, getStatus = 200, pipelineStatus = 200, pipelineBody } = {}) {
  const calls = { gets: [], pipelines: [] };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/pipeline')) {
      calls.pipelines.push(JSON.parse(init.body));
      return {
        ok: pipelineStatus >= 200 && pipelineStatus < 300,
        status: pipelineStatus,
        json: async () => pipelineBody ?? [{ result: 'OK' }, { result: 'OK' }, { result: 'OK' }],
      };
    }
    calls.gets.push(String(url));
    return {
      ok: getStatus >= 200 && getStatus < 300,
      status: getStatus,
      json: async () => ({ result: getResult }),
    };
  };
  return { fetchImpl, calls };
}

async function withCapturedWarn(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  try {
    return { value: await fn(), warns };
  } finally {
    console.warn = original;
  }
}

const ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

describe('recordHistoryIngestHealth', () => {
  it('writes the record, the seed-meta projection, and the activation marker', async () => {
    const { fetchImpl, calls } = stubUpstash();

    const record = await recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, runId: 'run-9', result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    );

    assert.equal(record.state, 'healthy');
    assert.equal(calls.gets.length, 1);
    assert.match(calls.gets[0], /intel-history%3Aingest-health%3Aconflict%3Aacled-intel%3Av1$/);

    assert.equal(calls.pipelines.length, 1);
    const [recordCmd, metaCmd, activationCmd] = calls.pipelines[0];

    assert.deepEqual(recordCmd.slice(0, 2), ['SET', historyIngestHealthKey(DOMAIN, RESOURCE)]);
    assert.deepEqual(recordCmd.slice(3), ['EX', HISTORY_INGEST_TTL_SECONDS]);
    assert.equal(JSON.parse(recordCmd[2]).lastRunId, 'run-9');

    assert.deepEqual(metaCmd.slice(0, 2), ['SET', historyIngestMetaKey(DOMAIN, RESOURCE)]);
    assert.deepEqual(metaCmd.slice(3), ['EX', HISTORY_INGEST_TTL_SECONDS]);
    const meta = JSON.parse(metaCmd[2]);
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'ok');
    assert.equal(
      typeof meta._seed,
      'undefined',
      'seed-meta must stay bare-shape — every reader parses it top-level',
    );

    assert.deepEqual(
      activationCmd,
      ['SET', historyIngestActivationKey(DOMAIN, RESOURCE), '1'],
      'the activation marker carries NO TTL: it must outlive the 7-day record',
    );
  });

  it('continues the failure streak from the persisted record', async () => {
    const previous = project(project(null, { result: SUCCESS }).record, {
      error: relayRejection(401),
      at: AT,
    }).record;
    const { fetchImpl, calls } = stubUpstash({ getResult: JSON.stringify(previous) });

    const { value: record } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: null, error: relayRejection(401) },
      { env: ENV, fetchImpl, now: () => AT + MINUTE },
    ));

    assert.equal(record.consecutiveFailures, 2);
    assert.equal(JSON.parse(calls.pipelines[0][1][2]).sourceState, 'degraded');
  });

  it('skips the write entirely when the previous record cannot be read', async () => {
    const { fetchImpl, calls } = stubUpstash({ getStatus: 500 });

    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    ));

    assert.equal(value, null);
    assert.deepEqual(
      calls.pipelines,
      [],
      'rebuilding from a lost previous would reset the failure count and drop lastSuccessAt',
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0], /ingest-health write failed \(non-fatal\)/);
  });

  it('treats a corrupt stored record as absent rather than failing the write', async () => {
    const { fetchImpl, calls } = stubUpstash({ getResult: '{not json' });

    const record = await recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    );

    assert.equal(record.state, 'healthy');
    assert.equal(calls.pipelines.length, 1);
  });

  it('never throws when the pipeline write fails', async () => {
    for (const options of [{ pipelineStatus: 503 }, { pipelineBody: [{ result: 'OK' }, { error: 'ERR wrongtype' }] }]) {
      const { fetchImpl } = stubUpstash(options);
      const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
        { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
        { env: ENV, fetchImpl, now: () => AT },
      ));
      assert.equal(value, null);
      assert.equal(warns.length, 1);
    }
  });

  it('a meta write that never lands cannot hide a stalled ingest', async () => {
    // The 3-command pipeline is not transactional, so a per-command failure can
    // land the record while the meta write is skipped. The meta then keeps its
    // PREVIOUS value — and on this path that value can only be an earlier
    // healthy observation, never a newer one. Prove the staleness backstop is
    // therefore untouched: the retained meta ages exactly as it would have.
    const healthy = project(null, { result: SUCCESS });
    const { fetchImpl, calls } = stubUpstash({
      getResult: JSON.stringify(healthy.record),
      pipelineBody: [{ result: 'OK' }, { error: 'ERR backend unavailable' }, { result: 'OK' }],
    });

    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: null, error: relayRejection(500) },
      { env: ENV, fetchImpl, now: () => AT + MINUTE },
    ));

    assert.equal(value, null, 'the caller learns the write did not fully land');
    assert.equal(warns.length, 1);

    // Health still reads the retained meta. Its fetchedAt is the last healthy
    // append, so the ordinary budget still expires on schedule.
    const retained = healthy.meta;
    assert.equal(retained.fetchedAt, AT);

    const ingestKey = healthTesting.STANDALONE_KEYS.intelHistoryIngestConflictAcled;
    const maxStaleMin = healthTesting.SEED_META.intelHistoryIngestConflictAcled.maxStaleMin;
    const entry = healthTesting.classifyKey(
      'intelHistoryIngestConflictAcled',
      ingestKey,
      { allowOnDemand: true },
      {
        keyStrens: new Map([[ingestKey, 512]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[
          healthTesting.SEED_META.intelHistoryIngestConflictAcled.key,
          JSON.stringify(retained),
        ]]),
        keyMetaErrors: new Map(),
        activationStates: new Map([['intelHistoryIngestConflictAcled', true]]),
        now: AT + (maxStaleMin + 1) * MINUTE,
      },
    );
    assert.equal(entry.status, 'STALE_SEED', 'the alarm survives a lost meta write');
    assert.equal(calls.pipelines.length, 1);
  });

  it('no-ops without Upstash credentials instead of exiting the seeder', async () => {
    const { fetchImpl, calls } = stubUpstash();
    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: {}, fetchImpl, now: () => AT },
    ));

    assert.equal(value, null);
    assert.deepEqual(calls.gets, []);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /no Upstash credentials/);
  });
});

describe('makeSeedHistoryAfterPublish', () => {
  it('records a projection failure as an ingest failure without appending', async () => {
    // buildRecords runs inside the same try as append, so a payload the
    // projection cannot handle throws before the relay is ever contacted. That
    // is still an ingest failure and must reach the health record rather than
    // vanishing into a log line.
    const observations = [];
    let appendCalls = 0;
    const hook = makeSeedHistoryAfterPublish({
      domain: DOMAIN,
      resource: RESOURCE,
      buildRecords: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    });

    const { warns } = await withCapturedWarn(() => hook({}, { runId: 'run-7' }, {
      append: async () => {
        appendCalls++;
        return SUCCESS;
      },
      recordHealth: async (observation) => {
        observations.push(observation);
        return null;
      },
    }));

    assert.equal(appendCalls, 0, 'nothing can be appended when the projection failed');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].result, null);
    assert.equal(observations[0].error.name, 'TypeError');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /append failed \(non-fatal\)/);

    // ...and it lands as a failing outcome, not a silent healthy one.
    const { record, meta } = projectHistoryIngestHealth(null, {
      domain: DOMAIN,
      resource: RESOURCE,
      runId: 'run-7',
      at: AT,
      outcome: describeHistoryAppendOutcome(observations[0].result, observations[0].error),
    });
    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'type_error');
    assert.equal(meta.fetchedAt, null);
  });
});

// ── Real producer -> real projection ─────────────────────────────────────────
//
// Everything above pins the projection against a hand-written result literal.
// That leaves one seam unguarded: if `appendSeedHistory`'s own return contract
// drifts — a renamed counter, a path that starts resolving where it used to
// throw — the projection keeps reading a shape the producer no longer emits and
// the alarm goes quiet with every test still green. These drive the REAL
// producer, with only the network stubbed, into the REAL reducer.

describe('appendSeedHistory outcomes reach the projection intact', () => {
  const RELAY_ENV = {
    CONVEX_SITE_URL: 'https://example.convex.site',
    RELAY_SHARED_SECRET: 'test-secret',
    OPENROUTER_API_KEY: 'sk-test',
  };

  const candidates = Array.from({ length: 3 }, (_, i) => ({
    dedupeKey: `conflict:acled-intel:evt-${i}`,
    title: `Event ${i}`,
    occurredAt: AT + i * 1000,
  }));

  const stubEmbed = async (texts) => texts.map(() => new Array(512).fill(0.1));

  async function runProducerThenProject(deps) {
    let result = null;
    let error = null;
    try {
      result = await appendSeedHistory(
        { domain: DOMAIN, resource: RESOURCE, runId: 'run-1', records: candidates },
        { env: RELAY_ENV, embed: stubEmbed, ...deps },
      );
    } catch (err) {
      error = err;
    }
    return projectHistoryIngestHealth(null, {
      domain: DOMAIN,
      resource: RESOURCE,
      runId: 'run-1',
      at: AT,
      outcome: describeHistoryAppendOutcome(result, error),
    });
  }

  it('a relay rejecting every chunk lands as failing with the HTTP code', async () => {
    const { record, meta } = await withCapturedWarn(() => runProducerThenProject({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
        json: async () => ({}),
      }),
      sleep: async () => {},
    })).then((r) => r.value);

    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'http_401');
    assert.equal(meta.fetchedAt, null);
    assert.equal(meta.sourceState, 'ok', 'one failed run is below the alarm threshold');
  });

  it('a budget that dies before the first POST lands as failing, not healthy', async () => {
    // The producer RESOLVES here rather than throwing — the exact shape that
    // used to be folded into `healthy` and kept the alarm green forever.
    let calls = 0;
    const { value: projected, warns } = await withCapturedWarn(() => runProducerThenProject({
      // Clock jumps past the deadline during embedding, so the chunk loop never
      // sends anything and the run is reported as fully abandoned.
      now: () => (calls++ === 0 ? AT : AT + 10 * MINUTE),
      budgetMs: 1_000,
      fetchImpl: async () => {
        throw new Error('the relay must never be contacted in this scenario');
      },
    }));

    assert.equal(projected.record.state, 'failing');
    assert.equal(projected.record.lastErrorCode, 'budget_exhausted');
    assert.equal(projected.meta.fetchedAt, null, 'nothing was delivered');
    assert.match(warns.join(' '), /budget exhausted/);
  });

  it('a fully accepted run lands as healthy with the relay-accepted volume', async () => {
    const { record, meta } = await runProducerThenProject({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ inserted: 2, skipped: 1 }),
      }),
    });

    assert.equal(record.state, 'healthy');
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.recordCount, 3, 'inserted + deduped, straight from the relay');
    assert.equal(meta.sourceState, 'ok');
  });

  it('carries every counter the relay reports into the record', () => {
    // The producer's return shape and this reducer are edited by different
    // changes at different times (`retracted` arrived with #5743 while this
    // record was in review). Pin that a counter the producer emits reaches the
    // durable record, so the next addition cannot land silently half-wired.
    const producerShape = {
      inserted: 2, skipped: 1, retracted: 4, chunks: 1, abandoned: 0, failedChunks: 0,
    };
    const { record, meta } = project(null, { result: producerShape });

    assert.equal(record.lastInserted, 2);
    assert.equal(record.lastDeduped, 1);
    assert.equal(record.lastRetracted, 4);
    assert.equal(record.lastChunks, 1);
    assert.equal(
      meta.recordCount,
      3,
      'a retraction removes a row rather than accepting one, so it stays out of the volume',
    );
  });

  it('an unconfigured relay lands as unconfigured and names the missing variable', async () => {
    const { value: projected } = await withCapturedWarn(() => runProducerThenProject({
      env: {},
      fetchImpl: async () => {
        throw new Error('no network when unconfigured');
      },
    }));

    assert.equal(projected.record.state, 'unconfigured');
    assert.deepEqual(projected.record.missingConfig, [
      'CONVEX_SITE_URL (or CONVEX_URL)',
      'RELAY_SHARED_SECRET',
      'OPENROUTER_API_KEY',
    ]);
    assert.equal(projected.meta.sourceState, 'unavailable');
  });
});

// ── The gap that motivated the issue ─────────────────────────────────────────

const COLLECTORS = [
  {
    domain: 'conflict',
    resource: 'acled-intel',
    healthName: 'intelHistoryIngestConflictAcled',
    seedHealthDomain: 'intel-history:conflict:acled-intel',
    collectorHealthName: 'acledIntel',
    collectorMetaKey: 'seed-meta:conflict:acled-intel',
    collectorDataKey: 'conflict:acled:v1:all:0:0',
  },
  {
    domain: 'military',
    resource: 'cross-strait-activity',
    healthName: 'intelHistoryIngestMilitaryCrossStrait',
    seedHealthDomain: 'intel-history:military:cross-strait-activity',
    collectorHealthName: 'crossStraitActivity',
    collectorMetaKey: 'seed-meta:military:cross-strait-activity',
    collectorDataKey: 'military:cross-strait-activity:v1',
  },
  {
    domain: 'energy',
    resource: 'intelligence',
    healthName: 'intelHistoryIngestEnergyIntelligence',
    seedHealthDomain: 'intel-history:energy:intelligence',
    collectorHealthName: 'energyIntelligence',
    collectorMetaKey: 'seed-meta:energy:intelligence',
    collectorDataKey: 'energy:intelligence:feed:v1',
  },
];

describe('registration parity', () => {
  for (const collector of COLLECTORS) {
    it(`${collector.domain}/${collector.resource} keys match what the writer publishes`, () => {
      const {
        STANDALONE_KEYS,
        SEED_META,
        ACTIVATION_MARKERS,
        ZERO_RECORD_DATA_OK_KEYS,
        ON_DEMAND_KEYS,
      } = healthTesting;

      assert.ok(
        ON_DEMAND_KEYS.has(collector.healthName),
        'without this membership the pre-first-report window is EMPTY (crit), not EMPTY_ON_DEMAND (warn)',
      );

      assert.equal(
        STANDALONE_KEYS[collector.healthName],
        historyIngestHealthKey(collector.domain, collector.resource),
      );
      assert.equal(
        SEED_META[collector.healthName]?.key,
        historyIngestMetaKey(collector.domain, collector.resource),
      );
      assert.equal(
        ACTIVATION_MARKERS[collector.healthName],
        historyIngestActivationKey(collector.domain, collector.resource),
      );
      assert.ok(
        ZERO_RECORD_DATA_OK_KEYS.has(collector.healthName),
        'a fully-deduped run legitimately accepts zero records',
      );
    });

    it(`${collector.domain}/${collector.resource} budgets agree across both health surfaces`, async () => {
      const { SEED_META } = healthTesting;
      const source = await import('node:fs/promises')
        .then((fs) => fs.readFile(new URL('../api/seed-health.js', import.meta.url), 'utf8'));

      const metaKey = historyIngestMetaKey(collector.domain, collector.resource);
      const entry = new RegExp(
        `'${collector.seedHealthDomain}':\\s*\\{[^}]*key:\\s*'${metaKey}'[^}]*intervalMin:\\s*(\\d+)[^}]*activationKey:\\s*'${historyIngestActivationKey(collector.domain, collector.resource)}'`,
      ).exec(source);

      assert.ok(entry, `api/seed-health.js must register ${collector.seedHealthDomain}`);
      assert.equal(
        Number(entry[1]) * 2,
        SEED_META[collector.healthName].maxStaleMin,
        'intervalMin*2 must equal api/health.js maxStaleMin so both surfaces alarm together',
      );
    });
  }
});

describe('a prolonged relay rejection is visible in /api/health', () => {
  const { classifyKey, BOOTSTRAP_KEYS, STANDALONE_KEYS, SEED_META } = healthTesting;

  /**
   * Classify one ingest-health entry alongside its collector, from the exact
   * bytes the writer would have persisted.
   */
  function classifyPair(collector, { ingestMeta, ingestRecord }) {
    const now = AT + 5 * MINUTE;
    const ingestKey = STANDALONE_KEYS[collector.healthName];
    // crossStraitActivity is a bootstrap key; the other two are standalone.
    const collectorKey = BOOTSTRAP_KEYS[collector.collectorHealthName]
      ?? STANDALONE_KEYS[collector.collectorHealthName];

    const ctx = {
      keyStrens: new Map([
        [ingestKey, ingestRecord ? JSON.stringify(ingestRecord).length : 0],
        [collectorKey, 4_096],
      ]),
      keyErrors: new Map(),
      keyMetaValues: new Map([
        [SEED_META[collector.healthName].key, ingestMeta ? JSON.stringify(ingestMeta) : null],
        // The collector itself published normally throughout.
        [collector.collectorMetaKey, JSON.stringify({ fetchedAt: now, recordCount: 120, sourceVersion: 'x' })],
      ]),
      keyMetaErrors: new Map(),
      // Past the deployment window: softening is revoked, so this is the real
      // classification an operator would see in production.
      activationStates: new Map([[collector.healthName, true]]),
      now,
    };

    return {
      ingest: classifyKey(collector.healthName, ingestKey, { allowOnDemand: true }, ctx),
      collector: classifyKey(collector.collectorHealthName, collectorKey, { allowOnDemand: true }, ctx),
    };
  }

  for (const collector of COLLECTORS) {
    it(`${collector.domain}/${collector.resource}: SEED_ERROR on the ingest key, OK on the collector`, () => {
      let state = projectHistoryIngestHealth(null, {
        domain: collector.domain,
        resource: collector.resource,
        runId: 'run-1',
        at: AT,
        outcome: describeHistoryAppendOutcome(SUCCESS, null),
      }).record;

      // Two consecutive ticks where the relay refuses every chunk.
      let projected;
      for (let tick = 1; tick <= 2; tick++) {
        projected = projectHistoryIngestHealth(state, {
          domain: collector.domain,
          resource: collector.resource,
          runId: `run-${tick + 1}`,
          at: AT + tick * MINUTE,
          outcome: describeHistoryAppendOutcome(null, relayRejection(401)),
        });
        state = projected.record;
      }

      const { ingest, collector: canonical } = classifyPair(collector, {
        ingestMeta: projected.meta,
        ingestRecord: projected.record,
      });

      assert.equal(ingest.status, 'SEED_ERROR', 'the store is silently receiving nothing');
      assert.equal(
        canonical.status,
        'OK',
        'canonical publication is genuinely fine — seed-meta semantics are unchanged',
      );
    });

    it(`${collector.domain}/${collector.resource}: softens the pre-first-report window`, () => {
      // A Vercel deploy ships this registry immediately; the record only exists
      // after the collector's next Railway tick (up to 6h for energy). Without
      // the ON_DEMAND softening asserted above, that window is EMPTY -> crit.
      const ingestKey = healthTesting.STANDALONE_KEYS[collector.healthName];
      const ctx = {
        keyStrens: new Map([[ingestKey, 0]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[SEED_META[collector.healthName].key, null]]),
        keyMetaErrors: new Map(),
        // Marker READ and absent: nothing has reported yet (#6095 — an
        // unreadable marker is a different, non-softening state).
        activationStates: new Map([[collector.healthName, false]]),
        now: AT,
      };

      const entry = classifyKey(collector.healthName, ingestKey, { allowOnDemand: true }, ctx);
      assert.equal(entry.status, 'EMPTY_ON_DEMAND');
      assert.equal(entry.onDemand, true);
      assert.equal(healthTesting.STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');

      // ...and the softening is revoked the moment the durable marker lands.
      const activated = classifyKey(
        collector.healthName,
        ingestKey,
        { allowOnDemand: true },
        { ...ctx, activationStates: new Map([[collector.healthName, true]]) },
      );
      assert.equal(activated.status, 'EMPTY');
      assert.equal(healthTesting.STATUS_COUNTS.EMPTY, 'crit');
    });

    it(`${collector.domain}/${collector.resource}: healthy ingest classifies OK`, () => {
      const { record, meta } = projectHistoryIngestHealth(null, {
        domain: collector.domain,
        resource: collector.resource,
        runId: 'run-1',
        at: AT + 5 * MINUTE,
        outcome: describeHistoryAppendOutcome(SUCCESS, null),
      });

      const { ingest } = classifyPair(collector, { ingestMeta: meta, ingestRecord: record });
      assert.equal(ingest.status, 'OK');
      assert.equal(ingest.records, 10);
    });

    it(`${collector.domain}/${collector.resource}: an unconfigured relay is visible but never an alarm`, () => {
      const { record, meta } = projectHistoryIngestHealth(null, {
        domain: collector.domain,
        resource: collector.resource,
        runId: 'run-1',
        at: AT + 5 * MINUTE,
        outcome: describeHistoryAppendOutcome({ skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] }, null),
      });

      const { ingest } = classifyPair(collector, { ingestMeta: meta, ingestRecord: record });
      assert.equal(ingest.status, 'NOT_CONFIGURED');
      assert.equal(healthTesting.STATUS_COUNTS.NOT_CONFIGURED, 'ok');
    });

    it(`${collector.domain}/${collector.resource}: staleness catches a sub-threshold failure`, () => {
      const healthy = projectHistoryIngestHealth(null, {
        domain: collector.domain,
        resource: collector.resource,
        runId: 'run-1',
        at: AT,
        outcome: describeHistoryAppendOutcome(SUCCESS, null),
      }).record;

      // ONE failure — below HISTORY_INGEST_ALARM_AFTER_FAILURES, so sourceState
      // is still 'ok' and SEED_ERROR cannot fire. The frozen fetchedAt is the
      // independent second alarm: if the collector's cadence never delivers a
      // second failing tick, "no successful append in N intervals" must still
      // surface on its own.
      const { record, meta } = projectHistoryIngestHealth(healthy, {
        domain: collector.domain,
        resource: collector.resource,
        runId: 'run-2',
        at: AT + MINUTE,
        outcome: describeHistoryAppendOutcome(null, relayRejection(500)),
      });
      assert.equal(meta.sourceState, 'ok', 'the SEED_ERROR path must not be what makes this red');

      const maxStaleMin = SEED_META[collector.healthName].maxStaleMin;
      const ingestKey = STANDALONE_KEYS[collector.healthName];
      const ctx = {
        keyStrens: new Map([[ingestKey, JSON.stringify(record).length]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[SEED_META[collector.healthName].key, JSON.stringify(meta)]]),
        keyMetaErrors: new Map(),
        activationStates: new Map([[collector.healthName, true]]),
        now: AT + (maxStaleMin + 1) * MINUTE,
      };

      const entry = classifyKey(collector.healthName, ingestKey, { allowOnDemand: true }, ctx);
      assert.equal(entry.status, 'STALE_SEED');
      assert.equal(entry.maxStaleMin, maxStaleMin);
    });
  }
});

describe('a prolonged relay rejection is visible in /api/seed-health', () => {
  const PREDICTION_META_KEY = 'seed-meta:prediction:markets';

  /**
   * Answer every seed-meta GET with a fresh, healthy record so the assertions
   * below isolate the ingest entries — including the resilience-intervals data
   * probe, whose absence would otherwise stale the aggregate for an unrelated
   * reason and make `overall` untrustworthy. `ingestMetaByKey` overrides
   * specific keys.
   */
  function installSeedHealthMock(ingestMetaByKey, { activated = true } = {}) {
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(init.body);
      const results = commands.map(([op, key]) => {
        if (op === 'EXISTS') {
          // The PortWatch content contract has its own activation marker. This
          // fixture does not provide that producer block, so keep it in the
          // pre-activation grace window while the history assertions exercise
          // the relay states.
          return {
            result: activated && key !== PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY ? 1 : 0,
          };
        }
        if (Object.hasOwn(ingestMetaByKey, key)) {
          const value = ingestMetaByKey[key];
          return { result: value == null ? null : JSON.stringify(value) };
        }
        if (key === RESILIENCE_INTERVAL_PROBE_KEY) {
          return {
            result: JSON.stringify({
              p05: 65.2,
              p95: 72.8,
              _formula: 'pc',
              _educationState: 'education-on',
              methodology: RESILIENCE_INTERVAL_METHODOLOGY,
              computedAt: '2026-06-11T12:00:00.000Z',
            }),
          };
        }
        if (key === EDUCATION_META_KEY) {
          return { result: JSON.stringify({
            fetchedAt: Date.now(),
            recordCount: sovereignStatus.entries.length,
            rankableRecordCount: sovereignStatus.entries.length,
          }) };
        }
        if (key === EDUCATION_DATA_KEY) {
          return { result: JSON.stringify({
            countries: Object.fromEntries(sovereignStatus.entries.map((entry, index) => [
              entry.iso2,
              { value: 35 + (index % 45), year: 2024 },
            ])),
          }) };
        }
        if (key === 'seed-meta:military:bases') {
          // #6845: the bases domain now carries a 100k integrity floor; the
          // generic fresh-and-healthy default below does not clear it.
          return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 125_380 }) };
        }
        if (key === PORTWATCH_META_KEY) {
          const observedAt = Date.now() - 60 * 60_000;
          return {
            result: JSON.stringify({
              fetchedAt: Date.now(),
              recordCount: 174,
              contentFreshness: {
                coveredCount: 174,
                freshCount: 174,
                staleCount: 0,
                unknownCount: 0,
                staleCountries: [],
                criticalCountries: ['CN', 'HK'],
                criticalFreshCount: 2,
                criticalStaleCountries: [],
                criticalMissingCountries: 0,
                criticalOldestObservedAt: observedAt,
                criticalOldestObservedCountry: 'CN',
              },
            }),
          };
        }
        if (key === PREDICTION_META_KEY) {
          return {
            result: JSON.stringify({
              fetchedAt: Date.now(),
              recordCount: 38,
              poolCounts: { geopolitical: 18, tech: 12, finance: 8 },
            }),
          };
        }
        return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 10_000 }) };
      });
      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }

  async function readSeedHealth() {
    const res = await seedHealthHandler(new Request('https://api.worldmonitor.app/api/seed-health', {
      headers: { 'X-WorldMonitor-Key': 'test-key' },
    }));
    return { res, body: await res.json() };
  }

  /**
   * Build each collector's seed-meta by running the REAL state machine over a
   * scripted sequence of outcomes, so these assertions break if the writer
   * changes. A hand-typed fixture would keep passing through a projection
   * regression — the /api/health half of this file already projects for the
   * same reason.
   */
  function projectMetaForAll(outcomes, { startAt = Date.now() - 10 * MINUTE } = {}) {
    const overrides = {};
    for (const collector of COLLECTORS) {
      let state = null;
      let projected = null;
      outcomes.forEach((outcome, i) => {
        projected = projectHistoryIngestHealth(state, {
          domain: collector.domain,
          resource: collector.resource,
          runId: `run-${i + 1}`,
          at: startAt + i * MINUTE,
          outcome: describeHistoryAppendOutcome(outcome.result ?? null, outcome.error ?? null),
        });
        state = projected.record;
      });
      overrides[historyIngestMetaKey(collector.domain, collector.resource)] = projected.meta;
    }
    return overrides;
  }

  it('reports a rejecting relay as error while the collector stays ok', async () => {
    installSeedHealthMock(projectMetaForAll([
      { result: SUCCESS },
      { error: relayRejection(401) },
      { error: relayRejection(401) },
    ]));

    const { res, body } = await readSeedHealth();
    assert.equal(res.status, 200);

    for (const collector of COLLECTORS) {
      const entry = body.seeds[collector.seedHealthDomain];
      assert.equal(entry.status, 'error', `${collector.seedHealthDomain} must alarm`);
      assert.equal(entry.stale, true);
      assert.equal(entry.lastErrorCode, 'http_401', 'the cause must be diagnosable from the API');
    }
    assert.equal(body.seeds['conflict:acled-intel'].status, 'ok');
    assert.equal(body.overall, 'warning');
  });

  it('reports a never-provisioned relay as not_configured, not a warning', async () => {
    installSeedHealthMock(projectMetaForAll(
      [{ result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] } }],
      { startAt: Date.now() },
    ));

    const { res, body } = await readSeedHealth();
    assert.equal(res.status, 200);
    assert.equal(body.overall, 'healthy');
    for (const collector of COLLECTORS) {
      const entry = body.seeds[collector.seedHealthDomain];
      assert.equal(entry.status, 'not_configured');
      assert.equal(entry.stale, false);
      assert.equal(entry.lastErrorCode, undefined, 'nothing has failed');
    }
  });

  it('alarms when a working relay loses its credential', async () => {
    // The issue's headline scenario. Distinguished from the never-provisioned
    // case above only by the earlier successful append.
    installSeedHealthMock(projectMetaForAll([
      { result: SUCCESS },
      { result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] } },
    ]));

    const { res, body } = await readSeedHealth();
    assert.equal(res.status, 200);
    assert.equal(body.overall, 'warning');
    for (const collector of COLLECTORS) {
      const entry = body.seeds[collector.seedHealthDomain];
      assert.equal(entry.status, 'error');
      assert.equal(entry.stale, true);
      assert.equal(entry.lastErrorCode, 'config_removed');
    }
    assert.equal(body.seeds['conflict:acled-intel'].status, 'ok');
  });

  it('does not echo the relay-controlled error reason', async () => {
    // lastErrorReason carries up to 200 chars of relay response body. It stays
    // in Redis; only the bounded lastErrorCode reaches the wire.
    installSeedHealthMock(projectMetaForAll([
      { result: SUCCESS },
      { error: relayRejection(401) },
      { error: relayRejection(401) },
    ]));

    const { body } = await readSeedHealth();
    for (const collector of COLLECTORS) {
      const entry = body.seeds[collector.seedHealthDomain];
      assert.equal(entry.lastErrorReason, undefined);
      assert.equal(entry.consecutiveFailures, undefined);
      assert.equal(entry.missingConfig, undefined);
    }
  });

  it('does not 503 before the first ingest report lands', async () => {
    const overrides = {};
    for (const collector of COLLECTORS) {
      overrides[historyIngestMetaKey(collector.domain, collector.resource)] = null;
    }
    installSeedHealthMock(overrides, { activated: false });

    const { res, body } = await readSeedHealth();
    assert.equal(res.status, 200, 'a Vercel deploy ahead of the first Railway tick must not page');
    assert.equal(body.overall, 'healthy');
    for (const collector of COLLECTORS) {
      assert.equal(body.seeds[collector.seedHealthDomain].status, 'pending-activation');
    }
  });

  it('alarms once the marker exists but the record has vanished', async () => {
    const overrides = {};
    for (const collector of COLLECTORS) {
      overrides[historyIngestMetaKey(collector.domain, collector.resource)] = null;
    }
    installSeedHealthMock(overrides, { activated: true });

    const { res, body } = await readSeedHealth();
    assert.equal(res.status, 503);
    for (const collector of COLLECTORS) {
      assert.equal(body.seeds[collector.seedHealthDomain].status, 'missing');
    }
  });
});
