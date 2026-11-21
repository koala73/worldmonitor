import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestCslEntries } from '../scripts/_csl-sanctions.mjs';
import { gtfsrtAdapter } from '../scripts/lib/gtfsrt.mjs';

test('CSL preserves a safe nested transport code without exposing error text', async () => {
  const records = [];
  const warn = console.warn;
  console.warn = line => records.push(JSON.parse(line));
  try {
    const result = await ingestCslEntries({ fetchFn: async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('secret-url?token=private'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    } });
    assert.equal(result.error, 'fetch failed (cause: UND_ERR_CONNECT_TIMEOUT)');
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'csl');
    assert.equal(records[0].errorCode, 'UND_ERR_CONNECT_TIMEOUT');
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally { console.warn = warn; }
});

test('GTFS records refusal headers while retaining its public HTTP error', async () => {
  const records = [];
  const warn = console.warn;
  console.warn = line => records.push(JSON.parse(line));
  try {
    await assert.rejects(gtfsrtAdapter('https://gtfsrt.ttc.ca/alerts/all?format=binary', {
      allowedHosts: ['gtfsrt.ttc.ca'],
      fetch: async () => new Response('private response body', { status: 500, headers: { server: 'cloudflare', 'cf-ray': 'a5355c0d69d7fd13-SIN' } }),
    }), { code: 'HTTP_ERROR', message: 'HTTP 500' });
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'gtfsrt');
    assert.equal(records[0].status, 500);
    assert.equal(records[0].cfRay, 'a5355c0d69d7fd13-SIN');
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally { console.warn = warn; }
});
