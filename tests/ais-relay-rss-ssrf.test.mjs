// The relay's public /rss route fetches allowlisted feed hosts whose DNS is
// controlled by hundreds of third parties. A dangling or rebound hostname
// answering with a private, link-local or metadata address would turn the
// route into a read primitive against the Railway network. The fetch must
// vet every DNS answer and connect only to a vetted address.
//
// ais-relay.cjs is a non-exported monolith that executes on import, so the
// durable coverage is a behavioural test of the shared lookup helper plus a
// source guard that the /rss fetch actually wires it in.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const {
  createGuardedLookup,
  NotificationWebhookSsrfError,
  SSRF_BLOCKED_ERROR_CODE,
} = require('../scripts/lib/notification-webhook-ssrf.cjs');

const RELAY_SRC = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function lookupResult(lookup, hostname, options) {
  return new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('createGuardedLookup', () => {
  test('rejects before connect when any DNS answer is private or reserved', async () => {
    const answers = [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: 'fd12::1', family: 6 }],
      [{ address: '::ffff:192.168.1.1', family: 6 }],
      [{ address: '93.184.216.34', family: 4 }, { address: '172.16.0.1', family: 4 }],
    ];
    for (const records of answers) {
      const lookup = createGuardedLookup(async () => records);
      const { err } = await lookupResult(lookup, 'feed.example', { family: 0 });
      assert.ok(err instanceof NotificationWebhookSsrfError, `expected block for ${JSON.stringify(records)}`);
      assert.equal(err.code, SSRF_BLOCKED_ERROR_CODE);
    }
  });

  test('rejects an empty answer set and propagates resolver failures', async () => {
    const empty = createGuardedLookup(async () => []);
    const { err: emptyErr } = await lookupResult(empty, 'feed.example', {});
    assert.equal(emptyErr?.code, SSRF_BLOCKED_ERROR_CODE);

    const failing = createGuardedLookup(async () => { throw new Error('ENOTFOUND'); });
    const { err: dnsErr } = await lookupResult(failing, 'feed.example', {});
    assert.equal(dnsErr?.message, 'ENOTFOUND');
  });

  test('pins a public answer, preferring IPv4, and honours options.all', async () => {
    const records = [
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ];
    const lookup = createGuardedLookup(async () => records);

    const single = await lookupResult(lookup, 'feed.example', { family: 0 });
    assert.equal(single.err, null);
    assert.equal(single.address, '93.184.216.34');
    assert.equal(single.family, 4);

    const all = await lookupResult(lookup, 'feed.example', { family: 0, all: true });
    assert.equal(all.err, null);
    assert.deepEqual(all.address, records);

    const noOptions = await new Promise((resolve) => {
      lookup('feed.example', (err, address, family) => resolve({ err, address, family }));
    });
    assert.equal(noOptions.address, '93.184.216.34');
  });

  test('an http.get with the guarded lookup never opens a socket to a blocked answer', async () => {
    const server = http.createServer((_req, res) => res.end('leaked'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    let connections = 0;
    server.on('connection', () => { connections += 1; });

    try {
      const lookup = createGuardedLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
      const outcome = await new Promise((resolve) => {
        const req = http.get(`http://internal.feed.example:${port}/`, { lookup }, (res) => {
          resolve({ kind: 'response', status: res.statusCode });
          res.resume();
        });
        req.on('error', (err) => resolve({ kind: 'error', code: err.code }));
      });
      assert.deepEqual(outcome, { kind: 'error', code: SSRF_BLOCKED_ERROR_CODE });
      assert.equal(connections, 0);
    } finally {
      server.close();
    }
  });
});

describe('ais-relay /rss wiring', () => {
  const start = RELAY_SRC.indexOf("} else if (pathname.startsWith('/rss')) {");
  assert.notEqual(start, -1, '/rss handler not found');
  const handler = RELAY_SRC.slice(start, RELAY_SRC.indexOf('fetchWithRedirects(feedUrl);', start));

  test('loads the guarded lookup from the shared SSRF lib', () => {
    assert.match(RELAY_SRC, /require\('\.\/lib\/notification-webhook-ssrf\.cjs'\)/);
    assert.match(RELAY_SRC, /const rssGuardedLookup = createGuardedLookup\(\)/);
  });

  test('every upstream feed fetch resolves through the guarded lookup', () => {
    const gets = handler.match(/protocol\.get\(url, \{[\s\S]*?\}, \(response\)/g) ?? [];
    assert.equal(gets.length, 1, 'expected exactly one upstream get in the /rss handler');
    assert.match(gets[0], /lookup: rssGuardedLookup/);
  });

  test('gates the protocol on the initial URL and on every redirect hop', () => {
    assert.match(handler, /RSS_ALLOWED_PROTOCOLS\.has\(parsed\.protocol\)/);
    assert.match(handler, /RSS_ALLOWED_PROTOCOLS\.has\(redirectTarget\.protocol\)/);
    assert.match(handler, /RSS_ALLOWED_DOMAINS\.has\(redirectTarget\.hostname\)/);
  });

  test('a blocked answer is a terminal 403, never served stale or retried', () => {
    assert.match(handler, /err\.code === SSRF_BLOCKED_ERROR_CODE[\s\S]{0,200}sendBlocked\(/);
    const start = handler.indexOf('const sendBlocked = ');
    assert.notEqual(start, -1, 'sendBlocked not found');
    const body = handler.slice(start, handler.indexOf('const fetchWithRedirects', start));
    assert.match(body, /rssResponseCache\.delete\(feedUrl\)/, 'the last good body must be evicted');
    assert.match(body, /rssResetFailure\(feedUrl\)/, 'a block must not enter backoff');
    assert.doesNotMatch(body, /recordFailure\(\)/, 'a block must not count as an upstream failure');
    assert.match(body, /statusCode: 403/, 'in-flight followers and the negative cache answer 403');
    assert.match(body, /resolveInFlight\(/, 'followers resolve to the negative entry, not a 502');
    assert.match(body, /'Cache-Control': 'no-store'/);
  });

  test('caps the buffered upstream body and answers before aborting the socket', () => {
    assert.match(RELAY_SRC, /const RSS_MAX_BODY_BYTES = 5 \* 1024 \* 1024/);
    assert.match(handler, /bodyBytes > RSS_MAX_BODY_BYTES[\s\S]{0,60}sendError\(502, 'Feed too large'\)[\s\S]{0,120}request\.destroy\(\)/);
    assert.match(handler, /if \(stream !== response\) stream\.destroy\(\)/);
    assert.match(handler, /response\.on\('error'/);
  });
});
