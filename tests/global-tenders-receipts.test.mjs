import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGlobalTenders, fetchWorldBank, fetchSam } from '../scripts/seed-global-tenders.mjs';
import { fetchBulgaria, fetchChile } from '../scripts/_global-tender-feeds.mjs';
import { observeTenderRequest, readTenderBody } from '../scripts/_global-tender-receipts.mjs';

const NOW = Date.parse('2026-11-01T02:00:00Z');
const receipt = () => ({ sources: [] });

test('natural source receipts distinguish HTTP success from a body timeout and hide secrets', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('secret body at https://private.test?api_key=secret'), { name: 'TimeoutError' });
    return { procnotices: {}, total: 0 };
  } });
  const originalDelay = process.env.WM_SEED_RETRY_DELAY_MS;
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  t.after(() => {
    if (originalDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
    else process.env.WM_SEED_RETRY_DELAY_MS = originalDelay;
  });
  const run = receipt();
  const snapshot = await fetchGlobalTenders({ now: NOW, receipt: run, adapters: [['world-bank', fetchWorldBank]] });
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].outcome, 'ok');
  assert.equal(run.sources[0].fetchedCount, 0);
  assert.equal(run.sources[0].requests[0].status, 200);
  assert.equal(run.sources[0].requests[0].phase, 'body');
  assert.equal(run.sources[0].requests[0].failure, 'TimeoutError');
  assert.equal(run.sources[0].requests[1].phase, 'complete');
  assert.doesNotMatch(JSON.stringify(run), /secret|api_key|private\.test/);
  assert.equal(Object.hasOwn(snapshot, 'receipt'), false);
});

test('Bulgaria receipt preserves requested, attempted and selected daily buckets', async () => {
  const run = receipt();
  await fetchGlobalTenders({ now: NOW, receipt: run, adapters: [['bulgaria-eop', (options) => fetchBulgaria({
    ...options,
    fetchTextFn: async (url) => {
      if (url.includes('2026-10-31')) throw Object.assign(new Error('403'), { status: 403 });
      return '<ListBucketResult><Contents><Key>OCDS.json</Key></Contents></ListBucketResult>';
    },
    fetchJsonFn: async () => ({ releases: [] }),
  })]] });
  assert.equal(run.sources.length, 1);
  assert.deepEqual(run.sources[0].bucket, {
    requestedDate: '2026-10-31', attemptedDates: ['2026-10-31', '2026-10-30'],
    selectedDate: '2026-10-30', fallbackStatus: 403,
  });
});

test('failed Bulgaria fallback keeps its attempts without claiming a selected bucket', async () => {
  const run = receipt();
  await fetchGlobalTenders({ now: NOW, receipt: run, adapters: [['bulgaria-eop', (options) => fetchBulgaria({
    ...options, fetchTextFn: async () => { throw Object.assign(new Error('403 secret'), { status: 403 }); },
  })]] });
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].outcome, 'error');
  assert.equal(run.sources[0].bucket.selectedDate, null);
  assert.deepEqual(run.sources[0].bucket.attemptedDates, ['2026-10-31', '2026-10-30']);
  assert.doesNotMatch(JSON.stringify(run), /secret/);
});

test('parallel source requests keep separate traces and bound stored request detail', async () => {
  const run = receipt();
  const source = (name, count, fail) => [name, async () => {
    for (let i = 0; i < count; i++) {
      const response = await observeTenderRequest(`https://${name}.test/private?api_key=secret`, { timeoutMs: 50 }, async () => {
        await Promise.resolve();
        if (fail) throw Object.assign(new Error('secret'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        return Response.json({ secret: 'payload' });
      });
      await readTenderBody(response, 'json');
    }
    return { records: [], status: { source: name, state: 'ok', recordCount: 0, fetchedAt: new Date(NOW).toISOString() } };
  }];
  await fetchGlobalTenders({ now: NOW, receipt: run, adapters: [source('ted', 35, false), source('sam', 1, true)] });
  const [ok, failed] = run.sources;
  assert.equal(ok.requestCount, 35);
  assert.equal(ok.requests.length, 32);
  assert.equal(ok.requestsTruncated, true);
  assert.ok(ok.requests.every(request => request.host === 'ted.test' && request.phase === 'complete'));
  assert.equal(failed.requestCount, 1);
  assert.equal(failed.requests[0].host, 'sam.test');
  assert.equal(failed.requests[0].phase, 'headers');
  assert.equal(failed.requests[0].status, null);
  assert.equal(failed.requests[0].failure, 'UND_ERR_CONNECT_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(run), /secret|api_key|payload|private/);
});

test('Bulgaria primary bucket success needs no fallback', async () => {
  const run = receipt();
  await fetchGlobalTenders({ now: NOW, receipt: run, adapters: [['bulgaria-eop', options => fetchBulgaria({
    ...options,
    fetchTextFn: async () => '<ListBucketResult><Contents><Key>OCDS.json</Key></Contents></ListBucketResult>',
    fetchJsonFn: async () => ({ releases: [] }),
  })]] });
  assert.deepEqual(run.sources[0].bucket, {
    requestedDate: '2026-10-31', attemptedDates: ['2026-10-31'], selectedDate: '2026-10-31', fallbackStatus: null,
  });
});

test('paced SAM receipts count previous records as retained without claiming a fetch', async () => {
  for (const state of ['ok', 'stale']) {
    const lastSuccessfulAt = new Date(NOW - 10 * 60_000).toISOString();
    const run = receipt();
    const previousSnapshot = {
      tenders: [{ id: 'sam-1', source: 'sam', title: 'Network services', status: 'active', deadline: '2099-01-01T00:00:00Z' }],
      sourceStatuses: [{ source: 'sam', state, fetchedAt: lastSuccessfulAt, lastSuccessfulAt, recordCount: 1, stale: state !== 'ok' }],
    };
    await fetchGlobalTenders({ now: NOW, receipt: run, previousSnapshot, adapters: [['sam', options => fetchSam({
      ...options, apiKey: 'secret', fetchJsonFn: () => assert.fail('paced run must not query the provider'),
    })]] });
    assert.equal(run.sources[0].outcome, 'paced');
    assert.equal(run.sources[0].effectiveState, state);
    assert.equal(run.sources[0].requestCount, 0);
    assert.equal(run.sources[0].fetchedCount, 0);
    assert.equal(run.sources[0].retainedCount, 1);
    assert.equal(run.sources[0].lastSuccessfulAt, lastSuccessfulAt);
  }
});

test('a failed detail batch settles started sibling requests before completing its source receipt', async () => {
  let releaseSibling;
  const sibling = new Promise(resolve => { releaseSibling = resolve; });
  const run = receipt();
  let completed = false;
  const pending = fetchGlobalTenders({ now: NOW, receipt: run, adapters: [['chile-mercado-publico', options => fetchChile({
    ...options,
    fetchJsonFn: async (url, requestOptions) => readTenderBody(await observeTenderRequest(url, requestOptions, async () => {
      if (url.includes('listaOCDS')) return Response.json({ data: Array.from({ length: 6 }, (_, i) => ({ ocid: `ocds-70d2nz-${i}` })) });
      if (url.endsWith('/0')) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      await sibling;
      return Response.json({ releases: [] });
    }), 'json'),
  })]] }).then(() => { completed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'source completion must wait for its started detail batch');
  } finally {
    releaseSibling();
    await pending;
  }
  assert.equal(run.sources[0].outcome, 'error');
  assert.equal(run.sources[0].requestCount, 5, 'do not start a second batch after failure');
  assert.ok(run.sources[0].requests.every(request => request.completedAt));
});
