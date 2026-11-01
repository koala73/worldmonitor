import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPortwatchRequestTrace } from '../scripts/_portwatch-request-diagnostics.mjs';

describe('PortWatch diagnostic safety', () => {
  it('omits credentials and unknown query/header fields and redacts echoed credentials', (t) => {
    const lines = [];
    t.mock.method(console, 'warn', (line) => lines.push(line));
    const url = 'https://user:password@services.example/query?where=1%3D1&resultOffset=1000&token=private-token&custom=private-value';
    const trace = createPortwatchRequestTrace(url, 'proxy');
    trace.fail(new Error(`Failed ${url} Bearer private-bearer`), {
      phase: 'arcgis',
      response: { status: 200, headers: { 'retry-after': '30', 'authorization': 'private-header' } },
      arcgisError: { code: 400, message: 'Invalid query', details: [url], secret: 'private-extra' },
    });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.endpoint, 'https://services.example/query');
    assert.deepEqual(record.query, { where: '1=1', resultOffset: '1000' });
    assert.deepEqual(record.headers, { 'retry-after': '30' });
    assert.doesNotMatch(lines[0], /user:password|private-token|private-bearer|private-value|private-header|private-extra/);
  });

  for (const character of ['界', '?']) {
    it(`bounds large ${character} provider details, query fields and cyclic aggregate causes`, (t) => {
      const lines = [];
      t.mock.method(console, 'warn', (line) => lines.push(line));
      const huge = character.repeat(100_000);
      const error = new AggregateError(Array.from({ length: 50 }, () => new Error(huge)), huge);
      error.cause = error;
      const trace = createPortwatchRequestTrace(`https://services.example/query?where=${huge}`, 'direct');
      trace.fail(error, { phase: 'arcgis', arcgisError: { code: 400, message: huge, details: Array(100).fill(huge) } });

      assert.equal(lines.length, 1);
      assert.ok(Buffer.byteLength(lines[0]) < 16_384);
      const record = JSON.parse(lines[0]);
      assert.match(record.query.where, /\[truncated\]$/);
      assert.equal(record.causes.length, 4);
      assert.equal(record.causes[1].parent, 0);
      assert.equal(record.arcgisError.details.length, 4);
    });
  }

  it('keeps diagnostic creation silent and ignores a failed log sink', (t) => {
    const warn = t.mock.method(console, 'warn', () => { throw new Error('log sink failed'); });
    const trace = createPortwatchRequestTrace('invalid URL', 'direct');
    assert.equal(warn.mock.callCount(), 0);
    assert.doesNotThrow(() => trace.fail(new Error('transport failed'), { phase: 'fetch' }));
    assert.equal(warn.mock.callCount(), 1);
  });

  for (const body of ['<html>Service unavailable</html>', JSON.stringify({ error: { message: 'x'.repeat(65_536) } })]) {
    it(`keeps HTTP diagnostics when the received body is ${body.startsWith('<') ? 'not JSON' : 'over the parse limit'}`, (t) => {
      const lines = [];
      t.mock.method(console, 'warn', (line) => lines.push(line));
      const error = Object.freeze(Object.assign(new Error('HTTP 503'), { status: 503 }));
      createPortwatchRequestTrace('https://services.example/query', 'proxy').fail(error, {
        phase: 'http', response: { status: 503, buffer: Buffer.from(body), headers: { 'retry-after': '60' } },
      });
      const record = JSON.parse(lines[0]);
      assert.equal(record.status, 503);
      assert.equal(record.causes[0].message, error.message);
      assert.deepEqual(record.headers, { 'retry-after': '60' });
      assert.equal(record.arcgisError, undefined);
    });
  }

  it('preserves the proxy transport phase and CONNECT status on a frozen error', (t) => {
    const lines = [];
    t.mock.method(console, 'warn', (line) => lines.push(line));
    const error = Object.freeze(Object.assign(new Error('proxy CONNECT failed'), {
      status: 522,
      proxyConnect: true,
      proxyFailure: { stage: 'proxy_connect', httpStatus: null, proxyConnectStatus: 522 },
    }));
    createPortwatchRequestTrace('https://services.example/query', 'proxy').fail(error, { phase: 'fetch' });
    const record = JSON.parse(lines[0]);
    assert.deepEqual(record.causes[0].proxyFailure, error.proxyFailure);
    assert.equal(record.status, null, 'a gateway CONNECT rejection is not an origin HTTP response');
  });
});
