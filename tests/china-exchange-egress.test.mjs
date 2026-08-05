import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import handler, {
  SZSE_EGRESS_MAX_RESPONSE_BYTES,
} from '../api/internal/china-exchange-egress.js';

const originalFetch = globalThis.fetch;
const originalSecret = process.env.RELAY_SHARED_SECRET;

const validBody = {
  seDate: ['2026-04-30', '2026-07-28'],
  channelCode: ['listedNotice_disc'],
  stock: ['300750'],
  pageSize: 50,
  pageNum: 1,
};

function request(body = validBody, {
  authorization = 'Bearer test-relay-secret',
  method = 'POST',
} = {}) {
  return new Request('https://api.worldmonitor.app/api/internal/china-exchange-egress', {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

async function assertUpstreamFailureResponse(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await response.json(), { error });
}

beforeEach(() => {
  process.env.RELAY_SHARED_SECRET = 'test-relay-secret';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.RELAY_SHARED_SECRET;
  else process.env.RELAY_SHARED_SECRET = originalSecret;
});

describe('internal China exchange egress', () => {
  it('fails closed before contacting SZSE when internal auth is invalid', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };

    const response = await handler(request(validBody, { authorization: 'Bearer wrong' }));

    assert.equal(response.status, 401);
    assert.equal(called, false);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  });

  it('fails closed when the shared secret is not configured', async () => {
    delete process.env.RELAY_SHARED_SECRET;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };

    const response = await handler(request(validBody, { authorization: 'Bearer ' }));

    assert.equal(response.status, 401);
    assert.equal(called, false);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  });

  it('accepts only the fixed reviewed SZSE request shape', async () => {
    const invalidBodies = [
      { ...validBody, stock: ['000001'] },
      { ...validBody, pageSize: 100 },
      { ...validBody, pageNum: 2 },
      { ...validBody, channelCode: ['other'] },
      { ...validBody, seDate: ['2025-01-01', '2026-07-28'] },
      { ...validBody, seDate: ['2026-02-31', '2026-04-30'] },
      { ...validBody, extra: 'unexpected' },
    ];

    for (const body of invalidBodies) {
      const response = await handler(request(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
  });

  it('cancels an oversized streaming request as soon as it crosses the byte cap', async () => {
    let cancelled = false;
    let reads = 0;
    const oversizedRequest = {
      method: 'POST',
      headers: new Headers({ Authorization: 'Bearer test-relay-secret' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return {
              done: false,
              value: new Uint8Array(2_049),
            };
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    };

    const response = await handler(oversizedRequest);

    assert.equal(response.status, 400);
    assert.equal(reads, 1);
    assert.equal(cancelled, true);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  });

  it('forwards the bounded official metadata request and returns the upstream JSON', async () => {
    const calls = [];
    const payload = {
      announceCount: 1,
      data: [{
        secCode: ['300750'],
        annId: '1225441596',
        title: '宁德时代：《董事会秘书工作细则》（2026年7月修订）',
        attachPath: '/disc/disk03/finalpage/2026-07-25/example.PDF',
        publishTime: '2026-07-25',
      }],
    };
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await handler(request());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(await response.json(), payload);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].input,
      'https://www.szse.cn/api/disc/announcement/annList?random=0.5',
    );
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].init.body), validBody);
    assert.deepEqual(calls[0].init.headers, {
      Accept: 'application/json',
      Referer: 'https://www.szse.cn/',
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
    });
  });

  it('preserves upstream failure status for the seeder fallback chain', async () => {
    globalThis.fetch = async () => new Response('upstream timeout', { status: 522 });

    const response = await handler(request());

    assert.equal(response.status, 522);
    assert.equal(await response.text(), 'upstream timeout');
  });

  it('maps an upstream TimeoutError to a no-store 504 JSON response', async () => {
    globalThis.fetch = async () => {
      throw Object.assign(new Error('upstream timed out'), { name: 'TimeoutError' });
    };

    const response = await handler(request());

    await assertUpstreamFailureResponse(response, 504, 'upstream_timeout');
  });

  it('maps an upstream AbortError to a no-store 504 JSON response', async () => {
    globalThis.fetch = async () => {
      throw Object.assign(new Error('upstream aborted'), { name: 'AbortError' });
    };

    const response = await handler(request());

    await assertUpstreamFailureResponse(response, 504, 'upstream_timeout');
  });

  it('maps an ordinary upstream fetch rejection to a no-store 502 JSON response', async () => {
    globalThis.fetch = async () => {
      throw new Error('upstream connection failed');
    };

    const response = await handler(request());

    await assertUpstreamFailureResponse(response, 502, 'upstream_fetch_failed');
  });

  it('maps a post-header upstream body failure to a no-store 502 JSON response', async () => {
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream body failed'));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const response = await handler(request());

    await assertUpstreamFailureResponse(response, 502, 'upstream_fetch_failed');
  });

  it('rejects an oversized upstream response without forwarding it', async () => {
    globalThis.fetch = async () => new Response(
      'x'.repeat(SZSE_EGRESS_MAX_RESPONSE_BYTES + 1),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const response = await handler(request());

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'upstream_response_too_large' });
  });

  it('rejects methods other than POST', async () => {
    const response = await handler(request(undefined, { method: 'GET' }));

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  });
});
