import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { fetchRbaCurve } from '../scripts/seed-yield-curve-au.mjs';
import { contentMeta, latestExtraKeyEntry, yearExtraKeyEntry } from '../scripts/seed-yield-curves-shared.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const sourceUrl = 'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv';

async function rejectedResponse(response) {
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    assert.equal(url, sourceUrl);
    return response;
  };
  let message;
  await assert.rejects(fetchRbaCurve(), (error) => {
    message = error.message;
    assert.match(message, /^RBA HTTP 403: /);
    return true;
  });
  assert.equal(requests, 1, 'diagnostics must not make an extra source request');
  return { message, diagnostic: JSON.parse(message.slice('RBA HTTP 403: '.length)) };
}

it('reports denial evidence without disclosing response text, headers, or redirect credentials', async () => {
  const secret = 'never-log-this-credential';
  const response = new Response(`<html>Access Denied ${secret}</html>`, {
    status: 403,
    headers: { 'content-type': `text/html; secret=${secret}`, 'content-length': '1234', server: 'Apache', 'set-cookie': secret, 'x-request-id': secret },
  });
  Object.defineProperties(response, { url: { value: `https://other.example/${secret}?token=${secret}` }, redirected: { value: true } });
  const { message, diagnostic } = await rejectedResponse(response);
  assert.equal(message.includes(secret), false);
  assert.equal(diagnostic.event, 'rba_http_rejection');
  assert.equal(diagnostic.status, 403);
  assert.equal(diagnostic.bodyMarker, 'denial_marker');
  assert.equal(diagnostic.bodyState, 'complete');
  assert.equal(diagnostic.contentType, 'html');
  assert.equal(diagnostic.server, 'apache');
  assert.equal(diagnostic.declaredBytes, 1234);
  assert.equal(diagnostic.redirected, true);
  assert.equal(diagnostic.expectedUrl, false);
  assert.ok(Number.isFinite(diagnostic.elapsedMs));
  assert.ok(message.length < 600);
});

it('caps the sampled body and cancels the remainder without waiting for cancellation', { timeout: 2000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('captcha ' + 'x'.repeat(100_000))); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const { diagnostic } = await rejectedResponse(new Response(stream, { status: 403 }));
  assert.equal(cancelled, true);
  assert.equal(diagnostic.sampledBytes, 2048);
  assert.equal(diagnostic.bodyState, 'limit');
  assert.equal(diagnostic.bodyMarker, 'challenge_marker');
});

it('does not claim bytes were discarded when the body exactly fills the sample', async () => {
  const { diagnostic } = await rejectedResponse(new Response('x'.repeat(2048), { status: 403 }));
  assert.equal(diagnostic.sampledBytes, 2048);
  assert.equal(diagnostic.bodyState, 'limit');
});

it('bounds a stalled error body and does not replace the HTTP failure with a timeout', { timeout: 2000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const { diagnostic } = await rejectedResponse(new Response(stream, { status: 403 }));
  assert.equal(cancelled, true);
  assert.equal(diagnostic.bodyState, 'timeout');
  assert.equal(diagnostic.sampledBytes, 0);
  assert.equal(diagnostic.bodyMarker, 'empty');
});

it('keeps unknown header values and body errors out of the diagnostic', async () => {
  const secret = 'private-error-token';
  const stream = new ReadableStream({ start(controller) { controller.error(new Error(secret)); } });
  const { diagnostic, message } = await rejectedResponse(new Response(stream, {
    status: 403, headers: { server: secret, 'content-type': secret, 'content-length': secret },
  }));
  assert.equal(message.includes(secret), false);
  assert.equal(diagnostic.server, 'other');
  assert.equal(diagnostic.contentType, 'other');
  assert.equal(diagnostic.declaredBytes, null);
  assert.equal(diagnostic.bodyState, 'error');
});

it('distinguishes an absent response body', async () => {
  const { diagnostic } = await rejectedResponse(new Response(null, { status: 403 }));
  assert.equal(diagnostic.bodyState, 'absent');
  assert.equal(diagnostic.sampledBytes, 0);
});

// RBA publishes the same F2 table as an 8.2 MB workbook and a 200 KB CSV. The
// workbook's ExcelJS load peaked at 1.69 GB RSS against the 2 GB
// seed-bundle-yield-curves container, and the AU section stopped publishing on
// 2026-09-24, so the seeder reads the CSV (served with a UTF-8 BOM).
const csvFixture = () => `\ufeff${readFileSync(new URL('./fixtures/yield-curves/rba-f2-data.csv', import.meta.url), 'utf8')}`;

it('preserves successful CSV parsing, source clocks, latest and year publication', async () => {
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, sourceUrl);
    assert.match(init.headers.Accept, /text\/csv/);
    assert.ok(init.headers['User-Agent']);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(csvFixture());
  };
  const payload = await fetchRbaCurve();
  assert.equal(requests, 1);
  assert.deepEqual(payload.curves, [
    { date: '2013-05-20', tenors: { '10y': 3.229 } },
    { date: '2013-05-21', tenors: { '10y': 3.263 } },
    { date: '2026-09-15', tenors: { '2y': 5.055, '3y': 5.049, '5y': 5.098, '10y': 5.411 } },
    { date: '2026-09-16', tenors: { '2y': 5, '3y': 4.99, '5y': 5.041, '10y': 5.348 } },
  ]);
  assert.equal(payload.curves.at(-1).date, '2026-09-16');
  assert.deepEqual(Object.keys(payload.curves.at(-1).tenors).sort(), ['10y', '2y', '3y', '5y']);
  assert.equal(contentMeta(payload).newestItemAt, Date.parse('2026-09-16T00:00:00Z'));
  assert.deepEqual(latestExtraKeyEntry('AU').transform(payload).curves, payload.curves.slice(-1));
  assert.deepEqual(yearExtraKeyEntry('AU', 2026, true).transform(payload).curves, payload.curves.filter(c => c.date.startsWith('2026-')));
});

it('rejects a CSV whose series header moved instead of publishing shifted tenors', async () => {
  globalThis.fetch = async () => new Response(csvFixture().replace('FCMYGBAG2D,FCMYGBAG3D', 'FCMYGBAG3D,FCMYGBAG2D'));
  const payload = await fetchRbaCurve();
  assert.equal(payload.curves.at(-1).tenors['2y'], 4.99, 'columns are mapped by Series ID, not position');
  for (const broken of [
    csvFixture().replace('Series ID,', 'Series,'),
    csvFixture().replace('FCMYGBAG5D', 'FCMYGBAG5Y'),
    csvFixture().replace('FCMYGBAG5D', 'FCMYGBAG2D'),
  ]) {
    globalThis.fetch = async () => new Response(broken);
    await assert.rejects(fetchRbaCurve(), /RBA F2 parsed no business days/);
  }
});

it('skips impossible calendar dates instead of throwing', async () => {
  globalThis.fetch = async () => new Response(`${csvFixture()}00-Jan-2026,1,1,1,1,1\n32-Jan-2026,1,1,1,1,1\n30-Feb-2026,1,1,1,1,1\n`);
  const payload = await fetchRbaCurve();
  assert.equal(payload.curves.length, 4);
});
