import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

process.env.WIDGET_AGENT_KEY = 'server-widget-key';
process.env.PRO_WIDGET_KEY = 'server-pro-key';
process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key,second-enterprise-key';
process.env.RELAY_SHARED_SECRET = 'server-only-relay-secret';

const { default: handler, __setWidgetAgentSpendDepsForTests } = await import('../api/widget-agent.ts');

const originalFetch = globalThis.fetch;
let relayFetches = 0;
let pipelineCalls = 0;
let lastSpendId = '';

function allowRelay(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://proxy.worldmonitor.app/widget-agent/health') {
      return Response.json({ ok: true });
    }
    assert.equal(url, 'https://proxy.worldmonitor.app/widget-agent');
    relayFetches += 1;
    assert.equal(new Headers(init?.headers).get('x-relay-key'), 'server-only-relay-secret');
    lastSpendId = new Headers(init?.headers).get('X-WM-Widget-Spend-Id') ?? '';
    return new Response('data: {"type":"done"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function postRequest(headers: Record<string, string> = {}, body = '{"prompt":"Build a widget"}'): Request {
  return new Request('https://www.worldmonitor.app/api/widget-agent', {
    method: 'POST',
    headers: {
      Origin: 'https://www.worldmonitor.app',
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': 'browser-test-key',
      ...headers,
    },
    body,
  });
}

after(() => {
  globalThis.fetch = originalFetch;
  __setWidgetAgentSpendDepsForTests(null);
});

describe('widget-agent spend guard', () => {
  it('blocks an exhausted daily meter before the relay and rolls the reservation back', async () => {
    relayFetches = 0;
    pipelineCalls = 0;
    const ops: string[] = [];
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async (commands) => {
        pipelineCalls += 1;
        const op = String(commands[0]?.[0] ?? '');
        ops.push(op);
        if (op === 'DECR') return [{ result: 50 }];
        return [{ result: 51 }, { result: 1 }];
      },
    });

    const res = await handler(postRequest());

    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'));
    const body = await res.json() as { error?: string; limit?: number };
    assert.equal(body.error, 'Direct LLM daily quota exceeded');
    assert.equal(body.limit, 50);
    assert.deepEqual(ops, ['INCR', 'DECR']);
    assert.equal(relayFetches, 0);
  });

  it('returns the per-identity rate-limit response before reserving quota', async () => {
    relayFetches = 0;
    pipelineCalls = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
      }),
      runRedisPipeline: async () => {
        pipelineCalls += 1;
        return [{ result: 1 }];
      },
    });

    const res = await handler(postRequest());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '30');
    assert.equal(pipelineCalls, 0);
    assert.equal(relayFetches, 0);
  });

  it('rejects an oversized declared body before quota or the relay', async () => {
    relayFetches = 0;
    pipelineCalls = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => {
        pipelineCalls += 1;
        return [{ result: 1 }];
      },
    });

    const res = await handler(postRequest({}, 'x'.repeat(163_841)));

    assert.equal(res.status, 413);
    assert.equal(pipelineCalls, 0);
    assert.equal(relayFetches, 0);
  });

  it('fails closed when the quota pipeline is empty and does not call the relay', async () => {
    relayFetches = 0;
    pipelineCalls = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => [],
    });

    const res = await handler(postRequest());

    assert.equal(res.status, 503);
    const body = await res.json() as { error?: string };
    assert.equal(body.error, 'Direct LLM quota unavailable');
    assert.equal(relayFetches, 0);
  });

  it('cancels an oversized stream without waiting for EOF or trusting content-length', async () => {
    let cancelled = false;
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => { throw new Error('must not reserve'); },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(163_841)); },
      cancel() { cancelled = true; },
    });
    const req = new Request(postRequest({ 'content-length': '1' }), {
      body, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await handler(req);
    assert.equal(res.status, 413);
    assert.equal(cancelled, true);
  });

  it('accepts the exact byte limit and preserves split UTF-8 characters', async () => {
    const raw = JSON.stringify({ prompt: 'é' + 'x'.repeat(163_825) });
    const bytes = new TextEncoder().encode(raw);
    assert.equal(bytes.byteLength, 163_840);
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => [{ result: 1 }, { result: 1 }],
    });
    globalThis.fetch = async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).prompt, JSON.parse(raw).prompt);
      return new Response('done');
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });
    const res = await handler(new Request(postRequest(), {
      body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    assert.equal(res.status, 200);
  });

  it('forwards a successful reservation with the validated spend identity', async () => {
    relayFetches = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => [{ result: 1 }, { result: 1 }],
    });

    const res = await handler(postRequest());

    assert.equal(res.status, 200);
    assert.equal(relayFetches, 1);
    assert.match(lastSpendId, /^wm:[0-9a-f]{32}$/);
  });

  it('keys the spend bucket on the credential that actually validated', async () => {
    // #8376 added this digest; #8269 later replaced the credential it read with
    // a boolean. Both merged cleanly with no textual conflict, so no merge check
    // caught it. Pin the material itself: a boolean-only auth result hashes the
    // same string for every enterprise key and merges tenants into one meter.
    relayFetches = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => null,
      runRedisPipeline: async () => [{ result: 1 }, { result: 1 }],
    });

    assert.equal((await handler(postRequest())).status, 200);
    const firstSpendId = lastSpendId;
    assert.match(firstSpendId, /^wm:[0-9a-f]{32}$/);

    assert.equal(
      (await handler(postRequest({ 'X-WorldMonitor-Key': 'second-enterprise-key' }))).status,
      200,
    );
    const secondSpendId = lastSpendId;
    assert.notEqual(secondSpendId, firstSpendId);

    // The same credential arriving by protected cookie shares the header's bucket.
    const viaCookie = await handler(new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'Content-Type': 'application/json',
        Cookie: '__Host-wm-pro-key=second-enterprise-key',
      },
      body: '{"prompt":"Build a widget"}',
    }));

    assert.equal(viaCookie.status, 200);
    assert.equal(lastSpendId, secondSpendId);
    assert.equal(relayFetches, 3);
  });

  it('does not reserve quota for the health check', async () => {
    pipelineCalls = 0;
    allowRelay();
    __setWidgetAgentSpendDepsForTests({
      checkRateLimit: async () => {
        throw new Error('health check must not be rate limited');
      },
      runRedisPipeline: async () => {
        pipelineCalls += 1;
        return [{ result: 1 }];
      },
    });

    const res = await handler(new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'GET',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'X-WorldMonitor-Key': 'browser-test-key',
      },
    }));

    assert.equal(res.status, 200);
    assert.equal(pipelineCalls, 0);
  });
});
