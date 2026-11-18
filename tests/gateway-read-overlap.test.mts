import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDomainGateway } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit';
import { issueSessionToken } from '../api/_session.js';

const SOURCE_PATH = '/api/news/v1/list-source-items';
const OTHER_PATH = '/api/test/v1/read';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let token: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  process.env.WM_SESSION_SECRET = 'gateway-overlap-test-secret-at-least-32-characters';
  process.env.UPSTASH_REDIS_REST_URL = 'https://overlap-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.USAGE_TELEMETRY;
  __resetRateLimitForTest();
  token = (await issueSessionToken()).token;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

function harness(path: string, handler: () => Promise<Response>) {
  __resetRateLimitForTest();
  const started = deferred<void>();
  const decision = deferred<boolean>();
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'overlap-redis.invalid');
    const commands = JSON.parse(String(init?.body)) as unknown[][];
    assert.ok(commands.every(command => /^evalsha$/i.test(String(command[0]))));
    started.resolve();
    const allowed = await decision.promise;
    return Response.json(commands.map(() => ({ result: [allowed ? 599 : -1, 600] })));
  };
  const gateway = createDomainGateway([{ method: 'GET', path, handler }]);
  const request = () => new Request(`https://www.worldmonitor.app${path}`, {
    headers: { Origin: 'https://www.worldmonitor.app', Cookie: `wm-session=${token}`, 'x-real-ip': '192.0.2.42' },
  });
  return { gateway, request, started, decision };
}

describe('gateway read-only cache handler / global limiter overlap', () => {
  it('starts an allowlisted handler before admission resolves and waits for both results', { timeout: 2_000 }, async () => {
    const handlerStarted = deferred<void>();
    const body = deferred<Response>();
    const h = harness(SOURCE_PATH, async () => {
      handlerStarted.resolve();
      return body.promise;
    });
    const pending = h.gateway(h.request());
    await h.started.promise;
    await handlerStarted.promise;
    let completed = false;
    void pending.then(() => { completed = true; });
    h.decision.resolve(true);
    await setImmediate();
    assert.equal(completed, false);
    body.resolve(Response.json({ items: [] }));
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [] });
    assert.equal(response.headers.get('Cache-Control'), 'private, max-age=300, stale-while-revalidate=60, stale-if-error=1800');
  });

  for (const rejects of [false, true]) {
    it(`preserves the limiter 429 and discards a ${rejects ? 'rejected' : 'successful'} handler`, async () => {
      let called = false;
      const h = harness(SOURCE_PATH, async () => {
        called = true;
        if (rejects) throw new Error('discard this rejection');
        return Response.json({ privateHandlerBody: true });
      });
      const pending = h.gateway(h.request());
      await h.started.promise;
      await setImmediate();
      assert.equal(called, true);
      h.decision.resolve(false);
      const response = await pending;
      assert.equal(response.status, 429);
      assert.ok(response.headers.has('Retry-After'));
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://www.worldmonitor.app');
      const limitedBody = await response.text();
      const control = harness(OTHER_PATH, async () => { throw new Error('limited control must not run'); });
      const baseline = control.gateway(control.request());
      await control.started.promise;
      control.decision.resolve(false);
      const baselineResponse = await baseline;
      assert.equal(limitedBody, await baselineResponse.text());
      for (const header of ['Cache-Control', 'Content-Type', 'Access-Control-Allow-Origin', 'RateLimit-Policy']) {
        assert.equal(response.headers.get(header), baselineResponse.headers.get(header));
      }
    });
  }

  it('retains the handler error boundary after admission succeeds', async () => {
    const h = harness(SOURCE_PATH, async () => { throw new Error('handler failed'); });
    const pending = h.gateway(h.request());
    await h.started.promise;
    h.decision.resolve(true);
    const response = await pending;
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: 'Internal server error' });
  });

  it('does not wait for discarded work or leak its late rejection', async () => {
    const finish = deferred<void>();
    const h = harness(SOURCE_PATH, async () => {
      await finish.promise;
      throw new Error('late discarded rejection');
    });
    const pending = h.gateway(h.request());
    await h.started.promise;
    h.decision.resolve(false);
    assert.equal((await pending).status, 429);
    finish.resolve();
    await setImmediate();
  });

  it('does not run the handler again for a caller this instance already denied', async () => {
    let calls = 0;
    const h = harness(SOURCE_PATH, async () => { calls += 1; return Response.json({}); });
    const limiterFetch = globalThis.fetch;
    let redisCalls = 0;
    globalThis.fetch = (async (input, init) => {
      redisCalls += 1;
      return limiterFetch(input, init);
    }) as typeof fetch;
    h.decision.resolve(false);
    assert.equal((await h.gateway(h.request())).status, 429);
    // The first denial is only learned from Redis, after the handler started.
    assert.equal(calls, 1);
    const repeat = await h.gateway(h.request());
    assert.equal(repeat.status, 429);
    assert.ok(repeat.headers.has('Retry-After'));
    assert.equal(calls, 1);
    assert.equal(redisCalls, 1);
  });

  it('does not run the handler for an unproven Cloudflare client IP', async () => {
    let called = false;
    process.env.CF_EDGE_PROOF_SECRET = 'overlap-edge-proof-secret';
    const h = harness(SOURCE_PATH, async () => { called = true; return Response.json({}); });
    const request = h.request();
    request.headers.set('cf-connecting-ip', '192.0.2.42');
    const response = await h.gateway(request);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('X-RateLimit-Mode'), 'edge-proof');
    assert.equal(called, false);
  });

  for (const allowed of [false, true]) {
    it(`keeps non-allowlisted handlers behind the ${allowed ? 'allowing' : 'denying'} limiter`, async () => {
      let called = false;
      const h = harness(OTHER_PATH, async () => {
        called = true;
        return Response.json({ ok: true });
      });
      const pending = h.gateway(h.request());
      await h.started.promise;
      await setImmediate();
      assert.equal(called, false);
      h.decision.resolve(allowed);
      assert.equal((await pending).status, allowed ? 200 : 429);
      assert.equal(called, allowed);
    });
  }

  it('still gates an allowlisted handler on authentication', async () => {
    let called = false;
    const h = harness(SOURCE_PATH, async () => { called = true; return Response.json({}); });
    const response = await h.gateway(new Request(`https://www.worldmonitor.app${SOURCE_PATH}`));
    assert.equal(response.status, 401);
    assert.equal(called, false);
  });
});
