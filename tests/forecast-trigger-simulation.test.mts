/**
 * Functional tests for triggerSimulation handler. Mirrors the
 * scenario-handler.test.mjs pattern (mock globalThis.fetch, parse pipeline
 * bodies, scriptable Upstash REST responses). Covers the security invariants
 * the plan ships:
 *   - 403 for free callers (defense-in-depth; gateway gates separately)
 *   - 429 for queue-depth backpressure
 *   - 200 no_package when pointer absent
 *   - 200 already-handled for both NX-collision AND outcome-already-written
 *     (and asserts internal codes never leak to external response)
 *   - 503 for Redis transport errors
 *   - happy path returns queued=true with opaque pkgFingerprint
 *
 * See #3734 + docs/plans/2026-05-18-003-...md U4.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers: Record<string, string> = {}) {
  const req = new Request('https://worldmonitor.app/api/forecast/v1/trigger-simulation', {
    method: 'POST',
    headers,
  });
  return { request: req, pathParams: {}, headers };
}

function proCtx() {
  return makeCtx({ 'X-WorldMonitor-Key': 'pro-test-key' });
}

/**
 * Install a fetch mock that handles three call styles used by the trigger
 * handler's underlying primitives:
 *   1. URL-based GET: `/get/<key>` → returns `{result: <string|null>}`.
 *      Used by simulation-queue's redisGetThrowing helper.
 *   2. POST pipeline body (array-of-commands) → `[{result}, ...]` array.
 *      Used by runRedisPipeline (queue depth, ZADD, EXPIRE, SET-NX).
 *   3. POST single command body → `{result}` object.
 *      Used by the .mjs seeder's redisCommand.
 *
 * `cmdResponder` handles cases 2 + 3 (command-shaped). Case 1 is dispatched
 * via the URL prefix and uses `getResponder` (key → string|null).
 */
function installFetch(
  cmdResponder: (cmd: unknown[]) => unknown,
  getResponder: (key: string) => string | null = () => null,
): unknown[][] {
  const recordedCommands: unknown[][] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();

    // Case 1: URL-based GET (`/get/<encoded-key>`).
    const getMatch = url.match(/\/get\/(.+)$/);
    if (getMatch && (!init || (init.method ?? 'GET') === 'GET')) {
      const key = decodeURIComponent(getMatch[1]);
      const result = getResponder(key);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }

    // Cases 2 + 3: POST with command body.
    const parsed = init?.body ? JSON.parse(String(init.body)) as unknown : [];
    const isPipeline = Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0]);
    const commands: unknown[][] = isPipeline ? (parsed as unknown[][]) : [parsed as unknown[]];
    for (const c of commands) recordedCommands.push(c);
    const results = commands.map(cmdResponder);
    const responseBody = isPipeline ? results : results[0];
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  return recordedCommands;
}

const VALID_RUN_ID = '1734567890123-abc';
const PKG_KEY = 'seed-data/forecast-traces/2026/05/18/' + VALID_RUN_ID + '/simulation-package.json';

describe('triggerSimulation handler (#3734 U4)', () => {
  let triggerSimulation: typeof import('../server/worldmonitor/forecast/v1/trigger-simulation').triggerSimulation;
  let ApiError: typeof import('../src/generated/server/worldmonitor/forecast/v1/service_server').ApiError;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mod = await import('../server/worldmonitor/forecast/v1/trigger-simulation.ts');
    triggerSimulation = mod.triggerSimulation;
    const gen = await import('../src/generated/server/worldmonitor/forecast/v1/service_server.ts');
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('rejects free caller with 403', async () => {
    installFetch(() => ({ result: 0 }));
    await assert.rejects(
      () => triggerSimulation(makeCtx(), { clientVersion: '' }),
      (err) => err instanceof ApiError && err.statusCode === 403 && /Pro subscription/.test(err.message),
    );
  });

  it('rejects with 429 when queue depth exceeds MAX_QUEUE_DEPTH', async () => {
    installFetch((cmd) => cmd[0] === 'ZCARD' ? { result: 101 } : { result: 0 });
    await assert.rejects(
      () => triggerSimulation(proCtx(), { clientVersion: '' }),
      (err) => err instanceof ApiError && err.statusCode === 429 && /capacity/i.test(err.message),
    );
  });

  it('returns no_package when package pointer is absent', async () => {
    installFetch(
      (cmd) => cmd[0] === 'ZCARD' ? { result: 0 } : { result: null },
      (_key) => null, // no pointer
    );
    const res = await triggerSimulation(proCtx(), { clientVersion: '' });
    assert.deepEqual(res, { queued: false, runId: '', pkgFingerprint: '', reason: 'no_package' });
  });

  it('returns already-handled when outcome.runId === pointer.runId (post-completion)', async () => {
    const pointerPayload = JSON.stringify({ runId: VALID_RUN_ID, pkgKey: PKG_KEY });
    const outcomePayload = JSON.stringify({ runId: VALID_RUN_ID });
    installFetch(
      (cmd) => cmd[0] === 'ZCARD' ? { result: 0 } : { result: null },
      (key) => {
        if (key === 'forecast:simulation-package:latest') return pointerPayload;
        if (key === 'forecast:simulation-outcome:latest') return outcomePayload;
        return null;
      },
    );
    const res = await triggerSimulation(proCtx(), { clientVersion: '' });
    assert.equal(res.queued, false);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.equal(res.reason, 'already-handled');
    assert.ok(/^[a-f0-9]{16}$/.test(res.pkgFingerprint), 'pkgFingerprint must be 16-char hex');
  });

  it('returns already-handled on NX-collision (already-queued)', async () => {
    const pointerPayload = JSON.stringify({ runId: VALID_RUN_ID, pkgKey: PKG_KEY });
    installFetch(
      (cmd) => {
        if (cmd[0] === 'ZCARD') return { result: 0 };
        if (cmd[0] === 'SET') return { result: null }; // NX collision
        return { result: 0 };
      },
      (key) => {
        if (key === 'forecast:simulation-package:latest') return pointerPayload;
        return null; // no outcome yet
      },
    );
    const res = await triggerSimulation(proCtx(), { clientVersion: '' });
    assert.equal(res.queued, false);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.equal(res.reason, 'already-handled');
  });

  it('happy path: returns queued=true with opaque pkgFingerprint', async () => {
    const pointerPayload = JSON.stringify({ runId: VALID_RUN_ID, pkgKey: PKG_KEY });
    installFetch(
      (cmd) => {
        if (cmd[0] === 'ZCARD') return { result: 0 };
        if (cmd[0] === 'SET') return { result: 'OK' };
        return { result: 1 };
      },
      (key) => {
        if (key === 'forecast:simulation-package:latest') return pointerPayload;
        return null;
      },
    );
    const res = await triggerSimulation(proCtx(), { clientVersion: '' });
    assert.equal(res.queued, true);
    assert.equal(res.runId, VALID_RUN_ID);
    assert.equal(res.reason, '');
    assert.ok(/^[a-f0-9]{16}$/.test(res.pkgFingerprint),
      `pkgFingerprint must be 16-char hex, got: ${res.pkgFingerprint}`);
    assert.notEqual(res.pkgFingerprint, PKG_KEY,
      'pkgFingerprint must NOT be the raw R2 path (Sec7 round 2 — bucket layout disclosure)');
  });

  it('throws 503 on Redis transport error during pointer read', async () => {
    // ZCARD succeeds; GET on the package pointer fails. The URL form is
    // `/get/<key>` so we discriminate by URL substring.
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (init?.method === 'POST' || init === undefined && url.endsWith('.example')) {
        // Pipeline (ZCARD) — handled below
      }
      if (url.includes('/get/')) {
        return new Response('upstream error', { status: 503 });
      }
      // ZCARD pipeline
      return new Response(JSON.stringify([{ result: 0 }]), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => triggerSimulation(proCtx(), { clientVersion: '' }),
      (err) => err instanceof ApiError && err.statusCode === 503,
    );
  });

  it('throws 503 on Redis transport error during enqueue SET', async () => {
    const pointerPayload = JSON.stringify({ runId: VALID_RUN_ID, pkgKey: PKG_KEY });
    let setSeen = false;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      // GET on the package pointer → return the pointer payload
      if (url.includes('/get/forecast%3Asimulation-package%3Alatest')) {
        return new Response(JSON.stringify({ result: pointerPayload }), { status: 200 });
      }
      // GET on the outcome → return null (no completed outcome)
      if (url.includes('/get/forecast%3Asimulation-outcome%3Alatest')) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      // Pipeline POSTs
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      const isPipeline = Array.isArray(body) && body.length > 0 && Array.isArray(body[0]);
      const commands = isPipeline ? (body as unknown[][]) : [body as unknown[]];
      const hasSet = commands.some((c) => c[0] === 'SET');
      if (hasSet) {
        setSeen = true;
        return new Response('upstream error', { status: 503 });
      }
      const results = commands.map((cmd) => cmd[0] === 'ZCARD' ? { result: 0 } : { result: 0 });
      return new Response(JSON.stringify(isPipeline ? results : results[0]), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => triggerSimulation(proCtx(), { clientVersion: '' }),
      (err) => err instanceof ApiError && err.statusCode === 503,
    );
    assert.ok(setSeen, 'test must have reached the SET call to validate the failure path');
  });

  it('REGRESSION: external response must never contain internal idempotency codes', async () => {
    // Cron-timing-oracle defense (Sec4 round 1+2): the external response
    // collapses 'already-queued' and 'already-completed-this-cycle' into a
    // single 'already-handled' code. Internal logs keep the distinction.
    const pointerPayload = JSON.stringify({ runId: VALID_RUN_ID, pkgKey: PKG_KEY });
    const outcomePayload = JSON.stringify({ runId: VALID_RUN_ID });
    installFetch(
      (cmd) => cmd[0] === 'ZCARD' ? { result: 0 } : { result: null },
      (key) => {
        if (key === 'forecast:simulation-package:latest') return pointerPayload;
        if (key === 'forecast:simulation-outcome:latest') return outcomePayload;
        return null;
      },
    );
    const res = await triggerSimulation(proCtx(), { clientVersion: '' });
    assert.notEqual(res.reason, 'already-queued',
      "external response leaks internal code 'already-queued' — must collapse to 'already-handled'");
    assert.notEqual(res.reason, 'already-completed-this-cycle',
      "external response leaks internal code 'already-completed-this-cycle' — must collapse to 'already-handled'");
    assert.equal(res.reason, 'already-handled');
  });
});
