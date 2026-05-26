/**
 * Functional tests for ScenarioService handlers. Tests the typed handlers
 * directly (not the HTTP gateway). Covers the security invariants the legacy
 * edge functions enforced:
 *   - run-scenario: 405 (via sebuf service-config method=POST), scenarioId
 *     validation against the template registry, iso2 regex, queue-depth
 *     backpressure, PRO gate, AbortSignal.timeout on Redis fetches.
 *   - get-scenario-status: JOB_ID_RE path-traversal guard, PRO gate.
 *   - list-scenario-templates: catalog shape preservation.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}) {
  const req = new Request('https://worldmonitor.app/api/scenario/v1/run-scenario', {
    method: 'POST',
    headers,
  });
  return { request: req, pathParams: {}, headers };
}

function proCtx() {
  return makeCtx({ 'X-WorldMonitor-Key': 'pro-test-key' });
}

let runScenario;
let getScenarioStatus;
let listScenarioTemplates;
let ValidationError;
let ApiError;

describe('ScenarioService handlers', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

    const runMod = await import('../server/worldmonitor/scenario/v1/run-scenario.ts');
    const statusMod = await import('../server/worldmonitor/scenario/v1/get-scenario-status.ts');
    const templatesMod = await import('../server/worldmonitor/scenario/v1/list-scenario-templates.ts');
    runScenario = runMod.runScenario;
    getScenarioStatus = statusMod.getScenarioStatus;
    listScenarioTemplates = templatesMod.listScenarioTemplates;
    const gen = await import('../src/generated/server/worldmonitor/scenario/v1/service_server.ts');
    ValidationError = gen.ValidationError;
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('runScenario', () => {
    it('rejects non-PRO callers with 403', async () => {
      await assert.rejects(
        () => runScenario(makeCtx(), { scenarioId: 'taiwan-strait-full-closure', iso2: '' }),
        (err) => err instanceof ApiError && err.statusCode === 403,
      );
    });

    it('rejects missing scenarioId with ValidationError', async () => {
      await assert.rejects(
        () => runScenario(proCtx(), { scenarioId: '', iso2: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'scenarioId',
      );
    });

    it('rejects unknown scenarioId with ValidationError', async () => {
      await assert.rejects(
        () => runScenario(proCtx(), { scenarioId: 'not-a-real-scenario', iso2: '' }),
        (err) => err instanceof ValidationError && /Unknown scenario/.test(err.violations[0].description),
      );
    });

    it('rejects malformed iso2 with ValidationError', async () => {
      await assert.rejects(
        () => runScenario(proCtx(), { scenarioId: 'taiwan-strait-full-closure', iso2: 'usa' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'iso2',
      );
    });

    it('accepts empty iso2 (treated as scope-all)', async () => {
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        const body = JSON.parse(String(init?.body));
        // Pipeline format: [[CMD, ...args]]; LLEN returns 0, RPUSH returns new length 1.
        const results = body.map((cmd) => cmd[0] === 'LLEN' ? { result: 0 } : { result: 1 });
        return new Response(JSON.stringify(results), { status: 200 });
      };
      const res = await runScenario(proCtx(), { scenarioId: 'taiwan-strait-full-closure', iso2: '' });
      assert.match(res.jobId, /^scenario:\d{13}:[a-z0-9]{8}$/);
      assert.equal(res.status, 'pending');
      // statusUrl preserved from the legacy v1 contract — server-computed,
      // URL-encoded jobId, safe for callers to follow directly. Locked in
      // because sebuf's 200-only convention breaks the 202/202-body pairing
      // from the pre-migration contract, and statusUrl is the safe alternative.
      assert.equal(
        res.statusUrl,
        `/api/scenario/v1/get-scenario-status?jobId=${encodeURIComponent(res.jobId)}`,
      );
      const pushCall = calls.find((c) => String(c.body).includes('RPUSH'));
      assert.ok(pushCall, 'RPUSH pipeline must be dispatched');
      const pushed = JSON.parse(pushCall.body);
      assert.equal(pushed[0][0], 'RPUSH');
      assert.equal(pushed[0][1], 'scenario-queue:pending');
      const payload = JSON.parse(pushed[0][2]);
      assert.equal(payload.scenarioId, 'taiwan-strait-full-closure');
      assert.equal(payload.iso2, null);
    });

    it('rejects when queue depth exceeds 100 with 429 ApiError', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify([{ result: 101 }]), { status: 200 });
      await assert.rejects(
        () => runScenario(proCtx(), { scenarioId: 'taiwan-strait-full-closure', iso2: '' }),
        (err) => err instanceof ApiError && err.statusCode === 429 && /capacity/i.test(err.message),
      );
    });

    it('returns 502 when Upstash RPUSH fails', async () => {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body[0][0] === 'LLEN') {
          return new Response(JSON.stringify([{ result: 0 }]), { status: 200 });
        }
        // RPUSH fails — pipeline helper returns []; handler surfaces as 502.
        return new Response('upstream error', { status: 500 });
      };
      await assert.rejects(
        () => runScenario(proCtx(), { scenarioId: 'taiwan-strait-full-closure', iso2: '' }),
        (err) => err instanceof ApiError && err.statusCode === 502,
      );
    });

    it('Redis pipeline fetches carry AbortSignal.timeout (source assertion)', () => {
      const src = readFileSync(join(root, 'server/_shared/redis.ts'), 'utf8');
      assert.match(
        src,
        /runRedisPipeline[\s\S]*?AbortSignal\.timeout/,
        'runRedisPipeline must use AbortSignal.timeout to prevent hanging edge isolates',
      );
    });
  });

  describe('getScenarioStatus', () => {
    it('rejects non-PRO callers with 403', async () => {
      await assert.rejects(
        () => getScenarioStatus(makeCtx(), { jobId: 'scenario:1712345678901:abcdefgh' }),
        (err) => err instanceof ApiError && err.statusCode === 403,
      );
    });

    it('rejects missing jobId with ValidationError', async () => {
      await assert.rejects(
        () => getScenarioStatus(proCtx(), { jobId: '' }),
        (err) => err instanceof ValidationError,
      );
    });

    it('rejects path-traversal jobId with ValidationError', async () => {
      await assert.rejects(
        () => getScenarioStatus(proCtx(), { jobId: '../../etc/passwd' }),
        (err) => err instanceof ValidationError,
      );
    });

    it('rejects malformed jobId (wrong suffix charset)', async () => {
      await assert.rejects(
        () => getScenarioStatus(proCtx(), { jobId: 'scenario:1712345678901:ABCDEFGH' }),
        (err) => err instanceof ValidationError,
      );
    });

    it('returns pending when Redis key is absent', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ result: null }), { status: 200 });
      const res = await getScenarioStatus(proCtx(), { jobId: 'scenario:1712345678901:abcdefgh' });
      assert.equal(res.status, 'pending');
      assert.equal(res.result, undefined);
    });

    it('passes through processing status', async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ result: JSON.stringify({ status: 'processing', startedAt: 123 }) }),
          { status: 200 },
        );
      const res = await getScenarioStatus(proCtx(), { jobId: 'scenario:1712345678901:abcdefgh' });
      assert.equal(res.status, 'processing');
    });

    it('returns shaped ScenarioResult when worker marks status=done', async () => {
      const workerResult = {
        scenarioId: 'taiwan-strait-full-closure',
        template: { name: 'taiwan_strait', disruptionPct: 100, durationDays: 30, costShockMultiplier: 1.45 },
        affectedChokepointIds: ['taiwan_strait'],
        currentDisruptionScores: { taiwan_strait: 42 },
        topImpactCountries: [{ iso2: 'JP', totalImpact: 1500, impactPct: 100 }],
      };
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            result: JSON.stringify({ status: 'done', result: workerResult, completedAt: 456 }),
          }),
          { status: 200 },
        );
      const res = await getScenarioStatus(proCtx(), { jobId: 'scenario:1712345678901:abcdefgh' });
      assert.equal(res.status, 'done');
      assert.ok(res.result);
      assert.deepEqual(res.result.affectedChokepointIds, ['taiwan_strait']);
      assert.equal(res.result.topImpactCountries.length, 1);
      assert.equal(res.result.topImpactCountries[0].iso2, 'JP');
      assert.equal(res.result.topImpactCountries[0].impactPct, 100);
      assert.equal(res.result.template?.disruptionPct, 100);
    });

    it('returns failed status with error message', async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            result: JSON.stringify({ status: 'failed', error: 'computation_error', failedAt: 789 }),
          }),
          { status: 200 },
        );
      const res = await getScenarioStatus(proCtx(), { jobId: 'scenario:1712345678901:abcdefgh' });
      assert.equal(res.status, 'failed');
      assert.equal(res.error, 'computation_error');
    });
  });

  describe('listScenarioTemplates', () => {
    it('returns catalog with the core template fields', async () => {
      const res = await listScenarioTemplates(makeCtx(), {});
      assert.ok(Array.isArray(res.templates));
      assert.ok(res.templates.length >= 6, 'catalog seeded with 6 templates');
      const taiwan = res.templates.find((t) => t.id === 'taiwan-strait-full-closure');
      assert.ok(taiwan);
      assert.equal(taiwan.disruptionPct, 100);
      assert.equal(taiwan.durationDays, 30);
      assert.deepEqual(taiwan.affectedChokepointIds, ['taiwan_strait']);
      assert.deepEqual(taiwan.affectedHs2, ['84', '85', '87']);
    });

    it('empty affectedHs2 array means ALL sectors (preserves null-as-wildcard)', async () => {
      const res = await listScenarioTemplates(makeCtx(), {});
      const suez = res.templates.find((t) => t.id === 'suez-bab-simultaneous');
      assert.ok(suez);
      // Template declares affectedHs2: null (all sectors); wire emits [].
      assert.deepEqual(suez.affectedHs2, []);
    });
  });
});
