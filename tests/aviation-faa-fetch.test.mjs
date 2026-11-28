// The FAA NAS status feed sits behind Akamai, which refuses some egress IPs.
// On 2026-11-25 every direct fetch from Railway failed from 19:33Z to 02:33Z
// ("fetch failed", 15 of 16 ticks), the busiest pre-Thanksgiving evening, and
// the dashboard kept serving the 19:01Z FAA snapshot as current. A blocked IP
// can also get Akamai's "Access Denied" page as an HTTP 403, or an HTML page
// with a 200. The fetch now falls back to the seeders' residential proxy, and
// only a real FAA XML document counts as an observation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchFaaStatusXml, isFaaStatusXml } from '../scripts/seed-aviation.mjs';

const FAA_XML = '<AIRPORT_STATUS_INFORMATION><Update_Time>Fri Nov 27 04:37:49 2026 GMT</Update_Time></AIRPORT_STATUS_INFORMATION>';
const AKAMAI_DENIED = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n</BODY></HTML>';

const xmlResponse = (body, status = 200, type = 'application/xml') => new Response(body, { status, headers: { 'content-type': type } });
const networkError = () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
};

function proxyRecorder(result) {
  const calls = [];
  const proxyFetchRaw = async (url, proxyAuth, options) => {
    calls.push({ url, proxyAuth, accept: options?.accept });
    if (result instanceof Error) throw result;
    return { buffer: Buffer.from(result), contentType: 'application/xml' };
  };
  return { calls, proxyFetchRaw };
}

test('a direct success never touches the proxy', async () => {
  const proxy = proxyRecorder(FAA_XML);
  const out = await fetchFaaStatusXml({ fetchImpl: async () => xmlResponse(FAA_XML), proxyAuth: 'user:pass@gate.example:7000', proxyFetchRaw: proxy.proxyFetchRaw });
  assert.equal(out.via, 'direct');
  assert.equal(out.xml, FAA_XML);
  assert.equal(proxy.calls.length, 0);
});

for (const [name, fetchImpl, reason] of [
  ['a network error', networkError, /fetch failed \(ECONNRESET\)/],
  ['an Akamai 403', async () => xmlResponse(AKAMAI_DENIED, 403, 'text/html'), /HTTP 403/],
  ['an HTML page served with 200', async () => xmlResponse(AKAMAI_DENIED, 200, 'text/html'), /not FAA status XML/],
]) {
  test(`${name} falls back to the proxy`, async () => {
    const proxy = proxyRecorder(FAA_XML);
    const out = await fetchFaaStatusXml({ fetchImpl, proxyAuth: 'user:pass@gate.example:7000', proxyFetchRaw: proxy.proxyFetchRaw });
    assert.equal(out.via, 'proxy');
    assert.equal(out.xml, FAA_XML);
    assert.match(out.directError, reason);
    assert.equal(proxy.calls.length, 1);
    assert.equal(proxy.calls[0].url, 'https://nasstatus.faa.gov/api/airport-status-information');
    assert.equal(proxy.calls[0].accept, 'application/xml');
  });
}

test('without a proxy the direct failure is thrown with its cause', async () => {
  await assert.rejects(
    fetchFaaStatusXml({ fetchImpl: networkError, proxyAuth: '', proxyFetchRaw: proxyRecorder(FAA_XML).proxyFetchRaw }),
    /FAA direct: fetch failed \(ECONNRESET\); no proxy configured/,
  );
});

test('when both legs fail, both reasons are reported and proxy credentials are redacted', async () => {
  const proxy = proxyRecorder(new Error('proxy CONNECT to http://user:secret@gate.example:7000 failed: ECONNREFUSED'));
  const err = await fetchFaaStatusXml({ fetchImpl: networkError, proxyAuth: 'user:secret@gate.example:7000', proxyFetchRaw: proxy.proxyFetchRaw })
    .then(() => null, e => e);
  assert.ok(err, 'expected a rejection');
  assert.match(err.message, /FAA direct: fetch failed \(ECONNRESET\); proxy: /);
  assert.doesNotMatch(err.message, /secret/);
});

test('a proxy answer that is not FAA XML is a failure, not an empty observation', async () => {
  const proxy = proxyRecorder(AKAMAI_DENIED);
  await assert.rejects(
    fetchFaaStatusXml({ fetchImpl: networkError, proxyAuth: 'user:pass@gate.example:7000', proxyFetchRaw: proxy.proxyFetchRaw }),
    /proxy: not FAA status XML/,
  );
});

test('isFaaStatusXml accepts the quiet feed and rejects HTML', () => {
  assert.equal(isFaaStatusXml(FAA_XML), true);
  assert.equal(isFaaStatusXml(`<?xml version="1.0" encoding="UTF-8"?>\n${FAA_XML}\n`), true);
  assert.equal(isFaaStatusXml(AKAMAI_DENIED), false);
  assert.equal(isFaaStatusXml(''), false);
});

// A body cut off mid-stream still contains the opening tag but parses as "no
// delays", which would replace the real snapshot with an empty one.
test('isFaaStatusXml rejects a truncated document and a tag inside other markup', () => {
  assert.equal(isFaaStatusXml(FAA_XML.slice(0, 60)), false);
  assert.equal(isFaaStatusXml(`<html><body>${FAA_XML}</body></html>`), false);
  assert.equal(isFaaStatusXml('<AIRPORT_STATUS_INFORMATION_X></AIRPORT_STATUS_INFORMATION_X>'), false);
});

// The right root at both ends does not make a document: an unclosed element
// inside it hides a delay record from parseFaaXml.
test('isFaaStatusXml rejects a malformed document with the right root', () => {
  assert.equal(isFaaStatusXml('<AIRPORT_STATUS_INFORMATION><Ground_Delay><ARPT>JFK</ARPT></AIRPORT_STATUS_INFORMATION>'), false);
});
