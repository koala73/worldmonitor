import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { withSourceRequestDiagnostics } from '../scripts/lib/source-request-diagnostics.mjs';

async function capture(fn) {
  const logs = [];
  const original = console.warn;
  console.warn = line => logs.push(JSON.parse(line));
  try { await fn(logs); } finally { console.warn = original; }
}

test('logs safe rejection metadata and preserves response identity', async () => {
  await capture(async logs => {
    const response = new Response('secret body', { status: 403, headers: {
      server: 'cloudflare', 'cf-ray': 'abc123def4567890-YYZ', 'cf-mitigated': 'challenge',
      'content-type': 'text/html; secret=value', 'set-cookie': 'secret-cookie', 'x-secret': 'secret-value',
    } });
    const actual = await withSourceRequestDiagnostics({ source: 'nrcan', route: 'proxy', attempt: 2 }, async observe => {
      observe(response); return response;
    });
    assert.equal(actual, response);
    assert.equal(await actual.text(), 'secret body');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 403);
    assert.equal(logs[0].cfRay, 'abc123def4567890-YYZ');
    assert.equal(logs[0].challenge, true);
    assert.equal(logs[0].contentType, 'text/html');
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('preserves error identity, bounds native codes and ignores hostile headers', async () => {
  await capture(async logs => {
    const error = new TypeError('secret URL', { cause: Object.assign(new Error('secret credentials'), { code: 'ECONNRESET' }) });
    await assert.rejects(withSourceRequestDiagnostics({ source: 'tps', stage: 'calls:ids' }, async () => { throw error; }), e => e === error);
    assert.equal(logs[0].errorCode, 'ECONNRESET');
    assert.equal(logs[0].phase, 'fetch');
    assert.ok(!JSON.stringify(logs).includes('secret'));
    await withSourceRequestDiagnostics({ source: 'nrcan', route: 'direct', attempt: 0 }, async observe => {
      observe({ status: 403, headers: { 'cf-ray': 'secret/path\n', server: 'secret', 'content-type': 'secret', 'cf-mitigated': 'secret' } });
    });
    assert.equal(logs[1].cfRay, null);
    assert.equal(logs[1].server, 'other');
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('native fetch correlates overlapping requests, body failure and header timeout; cleans listeners', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/headers') return;
    if (req.url === '/body') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); return; }
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const signal = AbortSignal.timeout(1000);
  try {
    await capture(async logs => {
      await Promise.all([
        assert.rejects(withSourceRequestDiagnostics({ source: 'tps', stage: 'calls:ids' }, async observe => {
          const response = await fetch(`${url}/headers`, { signal }); observe(response); return response.text();
        })),
        assert.rejects(withSourceRequestDiagnostics({ source: 'tps', stage: 'calls:source' }, async observe => {
          const response = await fetch(`${url}/body`, { signal: AbortSignal.timeout(1200) }); observe(response); return response.text();
        })),
        withSourceRequestDiagnostics({ source: 'tps', stage: 'calls:package' }, async observe => {
          const response = await fetch(`${url}/ok`); observe(response); return response.text();
        }),
      ]);
      assert.equal(logs.length, 2);
      const headers = logs.find(x => x.stage === 'calls:ids');
      const body = logs.find(x => x.stage === 'calls:source');
      assert.equal(headers.phase, 'request_sent');
      assert.equal(headers.status, null);
      assert.equal(headers.headersMs, null);
      assert.ok(headers.sentMs >= 0);
      assert.ok(headers.localPort > 0);
      assert.equal(body.phase, 'response_headers');
      assert.equal(body.status, 200);
      assert.ok(body.headersMs >= 0);
      assert.notEqual(headers.requestId, body.requestId);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(channel('undici:request:create').hasSubscribers, false);
});

test('logging failure cannot turn a successful fetch into failure', async () => {
  const original = console.warn;
  console.warn = () => { throw new Error('logger failed'); };
  try {
    assert.equal(await withSourceRequestDiagnostics({ source: 'nrcan', route: 'direct', attempt: 0 }, async observe => {
      observe({ status: 200 }); return 'ok';
    }), 'ok');
  } finally { console.warn = original; }
});

test('NRCan adapter logs each refusal without changing direct/proxy budgets or retries', async t => {
  const { fetchApprovedAtom, NRCAN_ATOM_URL } = await import('../scripts/seismology/nrcan-atom.mjs');
  const timeout = AbortSignal.timeout;
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return timeout(ms); });
  await capture(async logs => {
    const attempts = [];
    let directCalls = 0;
    await assert.rejects(fetchApprovedAtom(NRCAN_ATOM_URL, {
      proxyAuth: 'secret-user:secret-password@gateway.invalid:10001',
      fetchFn: async (_url, options) => {
        directCalls++;
        assert.equal(options.redirect, 'error');
        assert.equal(options.signal.aborted, false);
        return new Response('secret challenge body', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
      },
      proxyFetchFn: async (_url, options) => {
        attempts.push(options.attempt);
        return { ok: false, status: 403, buffer: Buffer.from('secret proxy body'), headers: {
          'cf-ray': 'abc123def4567890-YYZ', 'content-type': 'text/html', server: 'cloudflare',
        } };
      },
    }), error => error.nonRetryable === true && error.message === 'direct HTTP 403; proxy HTTP 403');
    assert.equal(directCalls, 1);
    assert.deepEqual(budgets, [15000]);
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.deepEqual(logs.map(x => [x.route, x.attempt, x.status]), [
      ['direct', 0, 403], ['proxy', 0, 403], ['proxy', 1, 403], ['proxy', 2, 403],
    ]);
    assert.equal(logs[0].challenge, true);
    assert.equal(logs[1].cfRay, 'abc123def4567890-YYZ');
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('NRCan distinguishes a CONNECT rejection from an origin response', async () => {
  const { fetchApprovedAtom, NRCAN_ATOM_URL } = await import('../scripts/seismology/nrcan-atom.mjs');
  await capture(async logs => {
    const rejected = Object.assign(new Error('secret tunnel details'), { proxyConnect: true, status: 407 });
    await assert.rejects(fetchApprovedAtom(NRCAN_ATOM_URL, {
      proxyAuth: 'secret', fetchFn: async () => new Response('', { status: 403 }),
      proxyFetchFn: async () => { throw rejected; },
    }), error => error === rejected && error.nonRetryable === true);
    assert.equal(logs.length, 2);
    assert.equal(logs[1].proxyConnect, true);
    assert.equal(logs[1].status, 407);
    assert.equal(logs[1].headersMs, null);
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('TPS adapter preserves timeout budget and reports the native cause', async t => {
  const { fetchTpsCallsAttended } = await import('../scripts/lib/tps-open-data.mjs');
  const timeout = AbortSignal.timeout;
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return timeout(ms); });
  await capture(async logs => {
    const result = await fetchTpsCallsAttended({ fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      throw Object.assign(new Error('secret'), { name: 'TimeoutError', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout:calls:package');
    assert.deepEqual(budgets, [30000]);
    assert.equal(logs[0].errorCode, 'UND_ERR_CONNECT_TIMEOUT');
    assert.equal(logs[0].stage, 'calls:package');
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('NRCan direct body failures retain the original error and request diagnostics', async () => {
  const { fetchApprovedAtom, NRCAN_ATOM_URL } = await import('../scripts/seismology/nrcan-atom.mjs');
  await capture(async logs => {
    const error = Object.assign(new Error('secret body failure'), { code: 'ECONNRESET' });
    const response = new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    await assert.rejects(fetchApprovedAtom(NRCAN_ATOM_URL, { fetchFn: async () => response }), e => e === error);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].phase, 'response_headers');
    assert.equal(logs[0].outcome, 'error');
    assert.equal(logs[0].errorCode, 'ECONNRESET');
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});

test('a header-write start does not claim a completed request transmission', async () => {
  await capture(async logs => {
    await assert.rejects(withSourceRequestDiagnostics({ source: 'tps' }, async () => {
      const request = {};
      channel('undici:request:create').publish({ request });
      channel('undici:client:sendHeaders').publish({ request, socket: {} });
      throw new Error('write failed');
    }));
    assert.equal(logs[0].phase, 'request_write_started');
    assert.ok(logs[0].writeStartedMs >= 0);
    assert.equal(logs[0].sentMs, null);
  });
});

test('proxy body failure retains validated status without inventing a header timestamp', async () => {
  await capture(async logs => {
    const error = Object.assign(new Error('secret'), { proxyFailure: { stage: 'response_body', httpStatus: 403 } });
    await assert.rejects(withSourceRequestDiagnostics({ source: 'nrcan', route: 'proxy' }, async () => { throw error; }), e => e === error);
    assert.equal(logs[0].phase, 'response_body');
    assert.equal(logs[0].status, 403);
    assert.equal(logs[0].headersMs, null);
    const invalid = Object.assign(new Error('secret'), { proxyFailure: { stage: 'secret', httpStatus: 999 } });
    await assert.rejects(withSourceRequestDiagnostics({ source: 'nrcan', route: 'proxy' }, async () => { throw invalid; }));
    assert.equal(logs[1].phase, 'fetch');
    assert.equal(logs[1].status, null);
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
});
