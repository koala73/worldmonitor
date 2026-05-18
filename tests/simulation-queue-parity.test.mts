/**
 * Parity test for the simulation enqueue pipeline.
 *
 * Loads BOTH the .mjs seeder's `enqueueSimulationTask(runId, pkgFingerprint)`
 * AND the TS handler-side `enqueueSimulationTaskForServer(runId, pkgFingerprint)`
 * and asserts they produce identical Redis state from identical inputs across
 * every reason-code path: happy, missing_run_id, invalid_run_id_format,
 * duplicate, redis_error. See #3734 + docs/plans/2026-05-18-003-...md U3.
 *
 * Also locks the worker's pkgFingerprint truthy-guard predicate via a
 * structural assertion (a behavioral integration test would require mocking
 * R2 + multi-LLM calls — overkill for verifying a 2-line predicate).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

type FetchCall = { url: string; body: unknown };

interface CallRecorder {
  calls: FetchCall[];
}

/**
 * Wrap globalThis.fetch with a recorder + scriptable response generator.
 *
 * `cmdResponder` receives a single command tuple (e.g. `['SET', key, ...]`)
 * and returns the per-command `{result}` object Upstash REST emits.
 *
 * Auto-detects the body shape:
 *   - Array of commands (pipeline / TS runRedisPipeline) → returns
 *     `[{result}, {result}, ...]` array shape.
 *   - Single command (the .mjs seeder's redisCommand) → returns the
 *     `{result}` object directly, matching Upstash's per-command POST.
 *
 * Also normalizes the recorded `body` to an array-of-commands so the
 * assertion code below can treat both call styles uniformly.
 */
function installFetch(recorder: CallRecorder, cmdResponder: (cmd: unknown[]) => unknown): void {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const parsed = init?.body ? JSON.parse(String(init.body)) as unknown : [];
    // Detect shape: pipeline = array-of-arrays; single command = array-of-strings.
    const isPipeline = Array.isArray(parsed)
      && parsed.length > 0
      && Array.isArray(parsed[0]);
    const commands: unknown[][] = isPipeline
      ? (parsed as unknown[][])
      : [parsed as unknown[]];
    recorder.calls.push({ url, body: commands });
    const results = commands.map(cmdResponder);
    const responseBody = isPipeline ? results : results[0];
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
}

describe('simulation-queue parity (#3734 U3)', () => {
  let enqueueSimulationTaskMjs: (runId: string, pkgFingerprint?: string) =>
    Promise<{ queued: boolean; reason: string }>;
  let enqueueSimulationTaskForServer: (runId: string, pkgFingerprint: string) =>
    Promise<{ queued: boolean; reason: string }>;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    const mjs = await import('../scripts/seed-forecasts.mjs') as {
      enqueueSimulationTask: typeof enqueueSimulationTaskMjs;
    };
    enqueueSimulationTaskMjs = mjs.enqueueSimulationTask;
    const ts = await import('../server/_shared/simulation-queue.ts');
    enqueueSimulationTaskForServer = ts.enqueueSimulationTaskForServer;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  const VALID_RUN_ID = '1734567890123-abc';
  const FINGERPRINT = 'a1b2c3d4e5f6abcd';

  it('happy path: both implementations enqueue identically', async () => {
    const happyResponder = (cmd: unknown[]) =>
      cmd[0] === 'SET' ? { result: 'OK' } : { result: 1 };

    // .mjs run
    const mjsRecorder: CallRecorder = { calls: [] };
    installFetch(mjsRecorder, happyResponder);
    const mjsRes = await enqueueSimulationTaskMjs(VALID_RUN_ID, FINGERPRINT);

    // TS run
    const tsRecorder: CallRecorder = { calls: [] };
    installFetch(tsRecorder, happyResponder);
    const tsRes = await enqueueSimulationTaskForServer(VALID_RUN_ID, FINGERPRINT);

    // Response shape parity
    assert.deepEqual(mjsRes, { queued: true, reason: '' });
    assert.deepEqual(tsRes, { queued: true, reason: '' });

    // Command-sequence parity: SET -> ZADD -> EXPIRE in the right order
    const mjsCmds = mjsRecorder.calls.flatMap((c) => c.body as unknown[][]).map((c) => c[0]);
    const tsCmds = tsRecorder.calls.flatMap((c) => c.body as unknown[][]).map((c) => c[0]);
    assert.deepEqual(mjsCmds, ['SET', 'ZADD', 'EXPIRE'],
      '.mjs must emit SET NX -> ZADD -> EXPIRE');
    assert.deepEqual(tsCmds, ['SET', 'ZADD', 'EXPIRE'],
      'TS must emit SET NX -> ZADD -> EXPIRE');

    // SET payload parity (both implementations must include the pkgFingerprint field)
    const mjsSet = (mjsRecorder.calls[0].body as unknown[][])[0];
    const tsSet = (tsRecorder.calls[0].body as unknown[][])[0];
    const mjsPayload = JSON.parse(String(mjsSet[2]));
    const tsPayload = JSON.parse(String(tsSet[2]));
    assert.equal(mjsPayload.runId, VALID_RUN_ID);
    assert.equal(tsPayload.runId, VALID_RUN_ID);
    assert.equal(mjsPayload.pkgFingerprint, FINGERPRINT);
    assert.equal(tsPayload.pkgFingerprint, FINGERPRINT);

    // Both implementations must use the same TTL value
    assert.equal(mjsSet[4], tsSet[4],
      `TTL must agree: .mjs=${mjsSet[4]}, TS=${tsSet[4]}`);
    // SET NX flag must be present in both
    assert.equal(mjsSet[5], 'NX', '.mjs must use SET NX');
    assert.equal(tsSet[5], 'NX', 'TS must use SET NX');
  });

  it('missing_run_id: both reject without any Redis traffic', async () => {
    const mjsRecorder: CallRecorder = { calls: [] };
    installFetch(mjsRecorder, () => ({ result: null }));
    const mjsRes = await enqueueSimulationTaskMjs('');
    assert.deepEqual(mjsRes, { queued: false, reason: 'missing_run_id' });
    assert.equal(mjsRecorder.calls.length, 0, '.mjs must not touch Redis for missing runId');

    const tsRecorder: CallRecorder = { calls: [] };
    installFetch(tsRecorder, () => ({ result: null }));
    const tsRes = await enqueueSimulationTaskForServer('', FINGERPRINT);
    assert.deepEqual(tsRes, { queued: false, reason: 'missing_run_id' });
    assert.equal(tsRecorder.calls.length, 0, 'TS must not touch Redis for missing runId');
  });

  it('invalid_run_id_format: both reject without Redis traffic', async () => {
    const mjsRecorder: CallRecorder = { calls: [] };
    installFetch(mjsRecorder, () => ({ result: null }));
    const mjsRes = await enqueueSimulationTaskMjs('not-an-epoch-id');
    assert.deepEqual(mjsRes, { queued: false, reason: 'invalid_run_id_format' });
    assert.equal(mjsRecorder.calls.length, 0);

    const tsRecorder: CallRecorder = { calls: [] };
    installFetch(tsRecorder, () => ({ result: null }));
    const tsRes = await enqueueSimulationTaskForServer('not-an-epoch-id', FINGERPRINT);
    assert.deepEqual(tsRes, { queued: false, reason: 'invalid_run_id_format' });
    assert.equal(tsRecorder.calls.length, 0);
  });

  it('duplicate (SET NX collision): both return reason=duplicate', async () => {
    // Upstash returns result=null for NX collision
    const mjsRecorder: CallRecorder = { calls: [] };
    installFetch(mjsRecorder, (cmd) =>
      cmd[0] === 'SET' ? { result: null } : { result: 0 });
    const mjsRes = await enqueueSimulationTaskMjs(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(mjsRes, { queued: false, reason: 'duplicate' });

    const tsRecorder: CallRecorder = { calls: [] };
    installFetch(tsRecorder, (cmd) =>
      cmd[0] === 'SET' ? { result: null } : { result: 0 });
    const tsRes = await enqueueSimulationTaskForServer(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(tsRes, { queued: false, reason: 'duplicate' });
  });

  it('redis_error: transport failure surfaces as reason=redis_error on both sides', async () => {
    // .mjs: redisCommand throws on !response.ok; the seeder's enqueue now
    // wraps that in try/catch and surfaces 'redis_error'.
    globalThis.fetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch;
    const mjsRes = await enqueueSimulationTaskMjs(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(mjsRes, { queued: false, reason: 'redis_error' });

    // TS: runRedisPipeline returns [] on !response.ok; enqueueSimulationTaskForServer
    // classifies absence-of-entry as redis_error.
    globalThis.fetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch;
    const tsRes = await enqueueSimulationTaskForServer(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(tsRes, { queued: false, reason: 'redis_error' });
  });

  it('ZADD failure: both rollback the task key and surface redis_error', async () => {
    // Regression for human review on PR #3811. The worker discovers tasks
    // EXCLUSIVELY via ZRANGE on SIMULATION_TASK_QUEUE_KEY. A task key
    // written without a corresponding queue member is invisible to the
    // worker until TTL — must NOT report queued:true.
    //
    // Simulate SET NX success → ZADD transport failure. Verify the
    // implementation issues a compensating DEL on the task key AND returns
    // reason=redis_error.
    const buildResponder = () => {
      let phase: 'set' | 'zadd-failed' = 'set';
      return (cmd: unknown[]): unknown => {
        if (cmd[0] === 'SET') { phase = 'zadd-failed'; return { result: 'OK' }; }
        if (cmd[0] === 'ZADD') return { result: null }; // simulate transport-shaped non-numeric
        if (cmd[0] === 'EXPIRE') return { result: 1 };
        if (cmd[0] === 'DEL') return { result: 1 };
        return { result: 0 };
      };
    };

    const mjsRecorder: CallRecorder = { calls: [] };
    installFetch(mjsRecorder, buildResponder());
    const mjsRes = await enqueueSimulationTaskMjs(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(mjsRes, { queued: false, reason: 'redis_error' },
      '.mjs must NOT return queued:true when ZADD result is non-numeric');
    const mjsCmds = mjsRecorder.calls.flatMap((c) => c.body as unknown[][]).map((c) => c[0]);
    assert.ok(mjsCmds.includes('DEL'),
      '.mjs must issue compensating DEL on the task key after ZADD failure');

    const tsRecorder: CallRecorder = { calls: [] };
    installFetch(tsRecorder, buildResponder());
    const tsRes = await enqueueSimulationTaskForServer(VALID_RUN_ID, FINGERPRINT);
    assert.deepEqual(tsRes, { queued: false, reason: 'redis_error' },
      'TS must NOT return queued:true when ZADD result is non-numeric');
    const tsCmds = tsRecorder.calls.flatMap((c) => c.body as unknown[][]).map((c) => c[0]);
    assert.ok(tsCmds.includes('DEL'),
      'TS must issue compensating DEL on the task key after ZADD failure');
  });

  it('backward-compat: .mjs auto-trigger continues to work with no pkgFingerprint arg', async () => {
    // The auto-trigger at seed-forecasts.mjs:16096 calls
    // enqueueSimulationTask(runId) without a fingerprint. Default param
    // makes pkgFingerprint='', stored in task payload as empty string.
    // The worker's truthy guard treats this as "skip verification."
    const recorder: CallRecorder = { calls: [] };
    installFetch(recorder, (cmd) =>
      cmd[0] === 'SET' ? { result: 'OK' } : { result: 1 });
    const res = await enqueueSimulationTaskMjs(VALID_RUN_ID);
    assert.deepEqual(res, { queued: true, reason: '' });
    const setCmd = (recorder.calls[0].body as unknown[][])[0];
    const payload = JSON.parse(String(setCmd[2]));
    assert.equal(payload.pkgFingerprint, '',
      'auto-trigger path must store empty fingerprint for worker truthy-guard skip');
  });
});

describe('worker pkgFingerprint predicate (#3734 U3 structural lock)', () => {
  it('processNextSimulationTask uses truthy-guard predicate (task.pkgFingerprint && ...)', () => {
    // Structural lock: ensures the worker predicate stays truthy-guarded so
    // pre-upgrade in-flight tasks (no pkgFingerprint field) AND auto-trigger
    // tasks (explicit empty string) both skip verification cleanly. Without
    // the truthy guard, every legacy/auto-trigger task would log
    // `package_rotated` spuriously, breaking R7.
    const src = readFileSync(resolve(root, 'scripts/seed-forecasts.mjs'), 'utf-8');
    assert.ok(
      /task\.pkgFingerprint\s*&&\s*task\.pkgFingerprint\s*!==\s*currentFingerprint/.test(src),
      'worker must use truthy guard: `task.pkgFingerprint && task.pkgFingerprint !== currentFingerprint`',
    );
    // The mismatch path must tag the outcome with _meta.packageRotated
    // (NOT a user-facing field per D8).
    assert.ok(
      /_meta:\s*packageRotated\s*\?/.test(src) || /packageRotated:\s*true/.test(src),
      'worker must tag outcome._meta.packageRotated on fingerprint mismatch',
    );
  });
});
