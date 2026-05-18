/**
 * Functional tests for getSimulationOutcome handler — runId filter, processing
 * state, tombstone-aware fallback. See #3734 + docs/plans/2026-05-18-003-...md U6.
 *
 * Five paths covered:
 *   1. By-run hit (real outcome) → returns it, processing=false, note=''.
 *   2. Tombstone hit (worker write transiently failed) → falls through to
 *      :latest with the tombstone note text.
 *   3. By-run miss + runId currently in queue → returns processing=true.
 *   4. By-run miss + runId not queued + :latest available → falls through
 *      to :latest with the expiry note text.
 *   5. No runId supplied → existing :latest path, unchanged.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_RUN_ID = '1734567890123-abc';
const BY_RUN_PREFIX = 'forecast:simulation-outcome:by-run';
const LATEST_KEY = 'forecast:simulation-outcome:latest';
const QUEUE_KEY = 'forecast:simulation-task-queue:v1';

function makeCtx() {
  const req = new Request('https://worldmonitor.app/api/forecast/v1/get-simulation-outcome');
  return { request: req, pathParams: {}, headers: {} };
}

const outcomePayload = {
  runId: VALID_RUN_ID,
  outcomeKey: 'seed-data/forecast-traces/2026/05/18/' + VALID_RUN_ID + '/simulation-outcome.json',
  schemaVersion: 'v1',
  theaterCount: 1,
  generatedAt: 1700000000000,
  uiTheaters: [
    { theaterId: 'T1', theaterLabel: 'Theater 1', stateKind: '', topPaths: [], dominantReactions: [], stabilizers: [], invalidators: [] },
  ],
};

const tombstonePayload = {
  runId: VALID_RUN_ID,
  error: 'by_run_write_failed',
  tombstoneAt: Date.now(),
};

const otherRunIdOutcome = {
  runId: '9999999999999-zzz',
  outcomeKey: 'seed-data/forecast-traces/2026/05/19/different/simulation-outcome.json',
  schemaVersion: 'v1',
  theaterCount: 2,
  generatedAt: 1700000001000,
  uiTheaters: [],
};

describe('getSimulationOutcome runId filter (#3734 U6)', () => {
  let getSimulationOutcome: typeof import('../server/worldmonitor/forecast/v1/get-simulation-outcome').getSimulationOutcome;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import('../server/worldmonitor/forecast/v1/get-simulation-outcome.ts');
    getSimulationOutcome = mod.getSimulationOutcome;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  /**
   * Install a fetch mock handling:
   *   - GET /get/<encoded-key> → URL-based reads (getRawJson)
   *   - POST /<pipeline-body> → ZRANGE for listProcessingRunIds
   */
  function installFetch(
    getResponder: (key: string) => unknown,
    pipelineResponder: (cmd: unknown[]) => unknown = () => ({ result: [] }),
  ) {
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const getMatch = url.match(/\/get\/(.+)$/);
      if (getMatch) {
        const key = decodeURIComponent(getMatch[1]);
        const raw = getResponder(key);
        const result = raw === null || raw === undefined
          ? null
          : (typeof raw === 'string' ? raw : JSON.stringify(raw));
        return new Response(JSON.stringify({ result }), { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      const isPipeline = Array.isArray(body) && body.length > 0 && Array.isArray(body[0]);
      const commands: unknown[][] = isPipeline ? (body as unknown[][]) : [body as unknown[]];
      const results = commands.map(pipelineResponder);
      const responseBody = isPipeline ? results : results[0];
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }) as typeof fetch;
  }

  it('Path 1 — by-run hit returns the outcome with processing=false, note=""', async () => {
    installFetch((key) => {
      if (key === `${BY_RUN_PREFIX}:${VALID_RUN_ID}`) return outcomePayload;
      return null;
    });
    const res = await getSimulationOutcome(makeCtx(), { runId: VALID_RUN_ID });
    assert.equal(res.found, true);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.equal(res.note, '');
    assert.equal(res.processing, false);
    assert.ok(res.theaterSummariesJson.length > 0, 'theater summaries must be populated');
  });

  it('Path 2 — tombstone hit falls through to :latest with tombstone note', async () => {
    installFetch((key) => {
      if (key === `${BY_RUN_PREFIX}:${VALID_RUN_ID}`) return tombstonePayload;
      if (key === LATEST_KEY) return outcomePayload;
      return null;
    });
    const res = await getSimulationOutcome(makeCtx(), { runId: VALID_RUN_ID });
    assert.equal(res.found, true);
    assert.equal(res.runId, VALID_RUN_ID, ':latest happens to match req.runId here');
    assert.match(res.note, /by-run lookup failed/, 'note must signal Redis transient failure');
    assert.equal(res.processing, false);
  });

  it('Path 3 — by-run miss + runId in queue returns processing=true (with no-cache marker)', async () => {
    installFetch(
      (_key) => null, // no by-run, no :latest
      (cmd) => {
        if (cmd[0] === 'ZRANGE') return { result: [VALID_RUN_ID] };
        return { result: 0 };
      },
    );
    const ctx = makeCtx();
    const res = await getSimulationOutcome(ctx, { runId: VALID_RUN_ID });
    assert.equal(res.found, false);
    assert.equal(res.processing, true);
    assert.equal(res.runId, VALID_RUN_ID);
    // Human review on PR #3811: processing=true is transient — the gateway's
    // `slow` cache tier (30-min CDN) would serve stale "still processing"
    // long after the worker completed. The handler MUST mark X-No-Cache on
    // this branch so polling clients see the outcome land.
    const { drainResponseHeaders } = await import('../server/_shared/response-headers.ts');
    const headers = drainResponseHeaders(ctx.request);
    assert.equal(headers?.['X-No-Cache'], '1',
      'processing=true response must carry X-No-Cache to opt out of the gateway cache tier');
  });

  it('Path 4 — by-run miss + not queued + :latest available falls through with expiry note', async () => {
    installFetch(
      (key) => {
        if (key === LATEST_KEY) return otherRunIdOutcome;
        return null;
      },
      (cmd) => cmd[0] === 'ZRANGE' ? { result: [] } : { result: 0 },
    );
    const res = await getSimulationOutcome(makeCtx(), { runId: VALID_RUN_ID });
    assert.equal(res.found, true);
    assert.equal(res.runId, otherRunIdOutcome.runId, ':latest runId surfaces (caller asked for VALID_RUN_ID)');
    assert.match(res.note, /may have expired beyond 24h retention/, 'note must signal expiry');
    assert.equal(res.processing, false);
  });

  it('Path 5 — no runId supplied returns :latest unchanged (existing behavior)', async () => {
    installFetch((key) => {
      if (key === LATEST_KEY) return outcomePayload;
      return null;
    });
    const res = await getSimulationOutcome(makeCtx(), { runId: '' });
    assert.equal(res.found, true);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.equal(res.note, '');
    assert.equal(res.processing, false);
  });

  it('NOT_FOUND when runId supplied + nothing anywhere + no :latest', async () => {
    installFetch(
      (_key) => null,
      (cmd) => cmd[0] === 'ZRANGE' ? { result: [] } : { result: 0 },
    );
    const res = await getSimulationOutcome(makeCtx(), { runId: VALID_RUN_ID });
    assert.equal(res.found, false);
    assert.equal(res.processing, false);
  });
});
