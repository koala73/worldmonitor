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
import { readFileSync } from 'node:fs';
import { createForecastServiceRoutes, type ForecastServiceHandler } from '../src/generated/server/worldmonitor/forecast/v1/service_server.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';
import { ApiError } from '../src/generated/server/worldmonitor/forecast/v1/service_server.ts';

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

const allFailedOutcome = {
  runId: '1734567890999-allfailed',
  outcomeKey: 'seed-data/forecast-traces/2026/05/19/allfailed/simulation-outcome.json',
  schemaVersion: 'v1',
  theaterCount: 0,
  eligibleTheaterCount: 2,
  failedTheaterCount: 2,
  allTheatersFailed: true,
  completionStatus: 'all_theaters_failed',
  generatedAt: 1700000002000,
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

  it('rejects malformed and oversized run IDs before any Redis work', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ result: null });
    }) as typeof fetch;
    for (const runId of ['arbitrary', '../latest', '1734567890123-abc\n', '9'.repeat(1000) + '-abc', '1734567890123-' + 'a'.repeat(65), null, 123]) {
      await assert.rejects(getSimulationOutcome(makeCtx(), { runId: runId as string }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    }
    assert.equal(calls, 0);
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

  it('publishes a valid query example and enforces its constraints through the generated route', async () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/ForecastService.openapi.json', import.meta.url), 'utf8'));
    const parameter = spec.paths['/api/forecast/v1/get-simulation-outcome'].get.parameters.find((p: { name: string }) => p.name === 'runId');
    const field = spec.components.schemas.GetSimulationOutcomeRequest.properties.runId;
    assert.equal(parameter.schema.pattern, '^([0-9]{13,}-[A-Za-z0-9-]{1,64})?$');
    assert.equal(parameter.schema.maxLength, 128);
    assert.equal(parameter.example, field.example);
    assert.equal(parameter.example, '1789387200000-abc123');
    assert.match(parameter.example, new RegExp(parameter.schema.pattern));
    const route = createForecastServiceRoutes({ getSimulationOutcome } as ForecastServiceHandler, {
      validateRequest: validateGeneratedRequest, onError: mapErrorToResponse,
    }).find(r => r.path.endsWith('/get-simulation-outcome'))!;
    let reads = 0;
    installFetch(() => { reads++; return outcomePayload; });
    for (const runId of ['example-id', '../secret', '1734567890123-abc\n', '1'.repeat(129) + '-abc', '1734567890123-' + 'a'.repeat(65)]) {
      const response = await route.handler(new Request('https://wm.test/api/forecast/v1/get-simulation-outcome?' + new URLSearchParams({ runId })));
      assert.equal(response.status, 400);
      assert.ok(Array.isArray((await response.json()).violations));
      assert.equal(reads, 0);
    }
    for (const runId of ['', parameter.example, '1734567890123-AbC-123', '1'.repeat(63) + '-' + 'a'.repeat(64)]) {
      const response = await route.handler(new Request('https://wm.test/api/forecast/v1/get-simulation-outcome?' + new URLSearchParams({ runId })));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).found, true);
    }
    assert.equal(reads, 4);
  });

  it('Path 1 — by-run hit returns the outcome with processing=false, note=""', async () => {
    installFetch((key) => {
      if (key === `${BY_RUN_PREFIX}:${VALID_RUN_ID}`) return outcomePayload;
      return null;
    });
    const res = await getSimulationOutcome(makeCtx(), { runId: VALID_RUN_ID });
    assert.equal(res.found, true);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.ok(!('outcomeKey' in res), 'public outcome response must not disclose its internal storage key');
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

  it('surfaces all-failed simulation metadata from the outcome pointer', async () => {
    installFetch((key) => {
      if (key === LATEST_KEY) return allFailedOutcome;
      return null;
    });
    const res = await getSimulationOutcome(makeCtx(), { runId: '' });
    assert.equal(res.found, true);
    assert.equal(res.theaterCount, 0);
    assert.equal(res.eligibleTheaterCount, 2);
    assert.equal(res.failedTheaterCount, 2);
    assert.equal(res.allTheatersFailed, true);
    assert.equal(res.completionStatus, 'all_theaters_failed');
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
