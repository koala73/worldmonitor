// SAM.gov request-budget regression tests (#5444, #8505).
//
// SAM.gov enforces a small per-key daily quota (10/day for non-federal keys).
// Pre-fix, the hourly seed fetched SAM every tick AND retried 429s in-run —
// ~72 requests/day against a 10/day budget — so the source pinned at HTTP 429
// and its age climbed past the 180-minute staleness ceiling (health
// SEED_ERROR, empty US tender queries). The fix spreads the budget: skip the
// request while the last ATTEMPT is fresher than SAM_MIN_FETCH_INTERVAL, and
// never spend in-run retries at all. The quota is spent by attempts, not
// successes: the first fix gated on the last success, which a failed run
// carries forward unchanged, so once a failure was older than the interval
// every hourly tick hit SAM again, and each tick cost three requests because
// timeouts were still retried (#8505). Snapshots here separate fetchedAt
// (last attempt) from lastSuccessfulAt on purpose; conflating them is how
// the regression escaped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';

import { __testing__, fetchGlobalTenders, fetchSam, fetchTed } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-07-22T12:00:00Z');
const OPEN_TENDER = {
  id: 'sam-1',
  source: 'sam',
  title: 'Cybersecurity support services',
  status: 'active',
  deadline: '2099-01-01T00:00:00Z',
};

function samSnapshot(lastSuccessfulAt) {
  return {
    tenders: [OPEN_TENDER],
    sourceStatuses: [
      {
        source: 'sam',
        state: 'ok',
        recordCount: 1,
        fetchedAt: lastSuccessfulAt,
        lastSuccessfulAt,
        stale: false,
      },
    ],
  };
}

function stubHttpsGet({ status = 200, body = '', headers = {} } = {}) {
  const calls = [];
  const responses = [];
  const httpsGetFn = (url, options, onResponse) => {
    calls.push({ url: String(url), options });
    const request = new EventEmitter();
    request.destroy = (error) => request.emit('error', error);
    queueMicrotask(() => {
      const response = Readable.from(body ? [Buffer.from(body)] : []);
      response.statusCode = status;
      response.headers = headers;
      responses.push(response);
      onResponse(response);
    });
    return request;
  };
  return { calls, responses, httpsGetFn };
}

test('fetchGlobalTenders does not promote a paced stale/error SAM snapshot to healthy', async (t) => {
  for (const priorState of ['stale', 'error']) {
    await t.test(priorState, async () => {
      const calls = [];
      const lastSuccessfulAt = new Date(NOW - 10 * 60_000).toISOString();
      const previousSnapshot = samSnapshot(lastSuccessfulAt);
      previousSnapshot.fetchedAt = Date.parse(lastSuccessfulAt);
      previousSnapshot.sourceStatuses[0] = {
        ...previousSnapshot.sourceStatuses[0],
        state: priorState,
        stale: true,
        error: 'prior SAM failure',
      };

      const result = await fetchGlobalTenders({
        now: NOW,
        previousSnapshot,
        adapters: [[
          'sam',
          (options) => fetchSam({
            ...options,
            apiKey: 'test-key',
            fetchJsonFn: async (url) => {
              calls.push(String(url));
              return { opportunitiesData: [] };
            },
          }),
        ]],
      });

      assert.equal(calls.length, 0, 'paced degraded state must not spend a SAM request');
      assert.notEqual(result.sourceStatuses[0].state, 'ok', 'paced degraded state must not become healthy');
      assert.equal(result.sourceStatuses[0].stale, true);
      assert.equal(result.sourceStatuses[0].error, 'prior SAM failure');
      assert.equal(result.availability, 'stale');
    });
  }
});

test('fetchSam paces on the last attempt, not the last success (#8505)', async () => {
  const calls = [];
  const previousSnapshot = samSnapshot(new Date(NOW - 13 * 3_600_000).toISOString());
  previousSnapshot.sourceStatuses[0] = {
    ...previousSnapshot.sourceStatuses[0],
    state: 'stale',
    stale: true,
    error: 'request timeout',
    fetchedAt: new Date(NOW - 58 * 60_000).toISOString(),
  };

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    fetchJsonFn: async (url) => {
      calls.push(String(url));
      return { opportunitiesData: [] };
    },
    previousSnapshot,
  });

  assert.equal(calls.length, 0, 'SAM meters attempts, so a 58-minute-old failed attempt must still pace');
  assert.equal(result.status.paced, true);
  assert.equal(result.status.state, 'stale');
});

test('fetchGlobalTenders retries a failing SAM source once per interval across hourly ticks (#8505)', async () => {
  const attempts = [];
  const lastSuccessfulAt = new Date(NOW - 180 * 60_000).toISOString();
  let snapshot = samSnapshot(lastSuccessfulAt);
  snapshot.fetchedAt = Date.parse(lastSuccessfulAt);
  for (let tick = 0; tick < 13; tick += 1) {
    snapshot = await fetchGlobalTenders({
      now: NOW + tick * 3_600_000,
      previousSnapshot: snapshot,
      adapters: [[
        'sam',
        (options) => fetchSam({
          ...options,
          apiKey: 'test-key',
          fetchJsonFn: async () => {
            attempts.push(tick);
            throw new Error('request timeout');
          },
        }),
      ]],
    });
  }

  assert.deepEqual(attempts, [0, 3, 6, 9, 12], 'a 150-minute gate on hourly ticks spends one request every third tick');
  assert.equal(snapshot.sourceStatuses[0].state, 'stale');
  assert.equal(snapshot.sourceStatuses[0].error, 'request timeout');
});

// mergeTenderSourceResults has two failure branches and the outage above only
// reaches the one that retains records. A SAM outage that outlives its retained
// tenders (isOpenOpportunity drops them past responseDeadLine), or that starts
// while SAM holds none, lands in the zero-record branch instead. Both must
// report the paced status's own attempt time or the gate paces forever (#8505).
test('a zero-record SAM source still retries once per interval across hourly ticks (#8505)', async () => {
  const attempts = [];
  let snapshot = {
    tenders: [],
    fetchedAt: NOW - 180 * 60_000,
    sourceStatuses: [{
      source: 'sam',
      state: 'error',
      recordCount: 0,
      fetchedAt: new Date(NOW - 180 * 60_000).toISOString(),
      lastSuccessfulAt: new Date(NOW - 13 * 3_600_000).toISOString(),
      stale: false,
    }],
  };
  for (let tick = 0; tick < 13; tick += 1) {
    snapshot = await fetchGlobalTenders({
      now: NOW + tick * 3_600_000,
      previousSnapshot: snapshot,
      adapters: [[
        'sam',
        (options) => fetchSam({
          ...options,
          apiKey: 'test-key',
          fetchJsonFn: async () => {
            attempts.push(tick);
            throw new Error('request timeout');
          },
        }),
      ]],
    });
  }

  assert.deepEqual(attempts, [0, 3, 6, 9, 12], 'a zero-record SAM must keep retrying once per 150-minute window');
  assert.equal(snapshot.sourceStatuses[0].recordCount, 0);
});

test('an unconfigured SAM run spends no request, so it does not start the pacing clock (#8505)', async () => {
  const unconfigured = await fetchGlobalTenders({
    now: NOW,
    previousSnapshot: null,
    adapters: [['sam', (options) => fetchSam({ ...options, apiKey: '' })]],
  });
  assert.equal(unconfigured.sourceStatuses[0].state, 'unavailable');

  const calls = [];
  const restored = await fetchGlobalTenders({
    now: NOW + 60 * 60_000,
    previousSnapshot: unconfigured,
    adapters: [[
      'sam',
      (options) => fetchSam({
        ...options,
        apiKey: 'test-key',
        fetchJsonFn: async () => {
          calls.push(1);
          return { opportunitiesData: [] };
        },
      }),
    ]],
  });

  assert.equal(calls.length, 1, 'a restored credential must fetch at once, not wait out an interval it never spent');
  assert.equal(restored.sourceStatuses[0].state, 'ok');
});

test('fetchSam skips the request while the previous success is inside the budget interval', async () => {
  const calls = [];
  const fetchJsonFn = async (url) => {
    calls.push(String(url));
    return { opportunitiesData: [] };
  };
  const lastSuccessfulAt = new Date(NOW - 10 * 60_000).toISOString();

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    fetchJsonFn,
    previousSnapshot: samSnapshot(lastSuccessfulAt),
  });

  assert.equal(calls.length, 0, 'must not spend a SAM request inside the pacing interval');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.status.paced, true);
  assert.equal(result.status.lastSuccessfulAt, lastSuccessfulAt, 'real success time must be preserved');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'sam-1');
});

test('fetchSam fetches again once the previous success is older than the interval', async () => {
  const calls = [];
  const fetchJsonFn = async (url, options) => {
    calls.push({ url: String(url), options });
    return { opportunitiesData: [] };
  };
  const lastSuccessfulAt = new Date(NOW - 200 * 60_000).toISOString();

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    fetchJsonFn,
    previousSnapshot: samSnapshot(lastSuccessfulAt),
  });

  assert.equal(calls.length, 1, 'stale-enough prior success must trigger a real fetch');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.status.paced, undefined);
});

test('fetchSam without a previous snapshot fetches (first run unchanged)', async () => {
  const calls = [];
  const fetchJsonFn = async () => {
    calls.push(1);
    return { opportunitiesData: [] };
  };
  await fetchSam({ apiKey: 'test-key', now: NOW, fetchJsonFn });
  assert.equal(calls.length, 1);
});

test('fetchSam default transport uses IPv4 and streams a successful JSON response', async () => {
  const { calls, httpsGetFn } = stubHttpsGet({
    body: JSON.stringify({ opportunitiesData: [] }),
  });

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    httpsGetFn,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.family, 4, 'SAM must avoid Railway\'s unreachable IPv6 route');
  assert.ok(calls[0].options.signal instanceof AbortSignal, 'SAM must retain an absolute request deadline');
  assert.equal(result.status.state, 'ok');
});

test('the SAM native transport rejects request semantics it cannot preserve without opening a socket', async (t) => {
  for (const [name, options] of [
    ['non-GET method', { method: 'POST' }],
    ['non-null body', { body: 'payload' }],
  ]) {
    await t.test(name, async () => {
      const { calls, httpsGetFn } = stubHttpsGet();

      await assert.rejects(
        () => __testing__.createSamFetchJson(httpsGetFn)('https://api.sam.gov/opportunities/v2/search', options),
        (error) => {
          assert.equal(error.nonRetryable, true);
          return true;
        },
      );
      assert.equal(calls.length, 0);
    });
  }
});

// SAM meters attempts, not successes: a request that reset or timed out may
// already count against the 10/day budget, so the next 150-minute window is
// the only retry (#8505).
test('the SAM transport spends exactly one request on a transient native error', async (t) => {
  for (const [name, failure] of [
    ['ECONNRESET', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['request timeout', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const httpsGetFn = (url, options) => {
        calls.push({ url: String(url), options });
        const request = new EventEmitter();
        queueMicrotask(() => request.emit('error', failure));
        return request;
      };

      await assert.rejects(
        () => fetchSam({ apiKey: 'test-key', now: NOW, fetchJsonFn: __testing__.createSamFetchJson(httpsGetFn) }),
        (error) => error === failure,
      );
      assert.equal(calls.length, 1, `${name} must not be retried in-run: every attempt may be metered`);
    });
  }
});

test('the SAM transport deadline also covers connection setup', async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  await assert.rejects(
    () => __testing__.createSamFetchJson()(`https://127.0.0.1:${port}/opportunities/v2/search`, {
      maxRetries: 0,
      timeoutMs: 50,
    }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'ABORT_ERR');
      return true;
    },
  );
});

test('SAM no-content responses do not retry after Response construction', async (t) => {
  for (const status of [204, 205, 304]) {
    await t.test(String(status), async () => {
      const { calls, httpsGetFn } = stubHttpsGet({ status });

      await assert.rejects(
        () => fetchSam({ apiKey: 'test-key', now: NOW, httpsGetFn }),
        status === 304 ? /HTTP 304/ : SyntaxError,
      );
      assert.equal(calls.length, 1);
    });
  }
});

test('an invalid SAM status destroys the response and is not retried', async () => {
  const { calls, responses, httpsGetFn } = stubHttpsGet({ status: 700 });

  await assert.rejects(
    () => fetchSam({ apiKey: 'test-key', now: NOW, httpsGetFn }),
    (error) => {
      assert.equal(error.nonRetryable, true);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(responses[0].destroyed, true);
});

test('a SAM redirect stays visible and is not followed or retried', async () => {
  const { calls, httpsGetFn } = stubHttpsGet({
    status: 302,
    headers: { location: 'https://example.com/redirected' },
  });

  await assert.rejects(
    () => fetchSam({ apiKey: 'test-key', now: NOW, httpsGetFn }),
    /HTTP 302/,
  );
  assert.equal(calls.length, 1);
});

test('a SAM 429 is not retried in-run (no quota burn)', async () => {
  const { calls, httpsGetFn } = stubHttpsGet({ status: 429 });

  await assert.rejects(
    () => fetchSam({
      apiKey: 'test-key',
      now: NOW,
      fetchJsonFn: __testing__.createSamFetchJson(httpsGetFn),
    }),
    /HTTP 429/,
  );
  assert.equal(calls.length, 1, '429 must fail fast instead of burning retry attempts');
  assert.equal(calls[0].options.family, 4);
});

test('a non-SAM adapter still retries HTTP 429 through the default fetch path', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => '',
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ notices: [] }),
    };
  };

  const result = await fetchTed({ now: NOW });

  assert.equal(calls.length, 2, 'non-SAM adapters must retain the default 429 retry');
  assert.equal(result.status.state, 'ok');
});
