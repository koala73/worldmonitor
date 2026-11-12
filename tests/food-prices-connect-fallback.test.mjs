import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { Agent, fetch } from 'undici';

import { foodSourceConnectOptions } from '../scripts/lib/food-prices-fetch.mjs';

// A publisher with two A records, one dead (www.da.gov.ph in 2026-11). The
// resolver rotates them, so a connection that tries only the first address
// fails about half the time. This fake DNS answers a single-address query
// with the dead address, and an all-addresses query with both, dead first.
const DEAD = '127.0.0.2';
const LIVE = '127.0.0.1';

/** Fake DNS that records each query and puts the dead address first. */
function rotatingDns(queries) {
  return (hostname, options, callback) => {
    queries.push({ family: options.family, all: options.all === true });
    if (options.all) callback(null, [{ address: DEAD, family: 4 }, { address: LIVE, family: 4 }]);
    else callback(null, DEAD, 4);
  };
}

describe('food source connect options', () => {
  it('moves on to the next IPv4 address when the first does not connect', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise(resolve => server.listen(0, LIVE, resolve));
    const { port } = server.address();
    const queries = [];
    // The shipped options, unchanged: a refused address fails at once, so the
    // production timeouts cost nothing here.
    const agent = new Agent({ connect: foodSourceConnectOptions(undefined, { dnsLookup: rotatingDns(queries) }) });
    try {
      const response = await fetch(`http://publisher.test:${port}/`, { dispatcher: agent, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      await agent.close();
      server.close();
    }
    // Only IPv4 addresses are ever asked for.
    assert.ok(queries.length > 0);
    assert.ok(queries.every(query => query.family === 4), JSON.stringify(queries));
  });

  it('leaves a stalled address time to fall through before the connect deadline', () => {
    // www.da.gov.ph's dead address never answers, so only the per-address
    // attempt window moves past it. Node ignores autoSelectFamily when
    // `family` is set, which is the bug this replaced.
    const connect = foodSourceConnectOptions(undefined);
    assert.equal('family' in connect, false);
    assert.equal(connect.autoSelectFamily, true);
    const attempt = connect.autoSelectFamilyAttemptTimeout;
    assert.ok(Number.isFinite(attempt) && attempt >= 250, `attempt window ${attempt}`);
    // A stalled first address plus a slow second handshake still fits.
    assert.ok(attempt * 2 <= connect.timeout, `attempt ${attempt} x2 > connect ${connect.timeout}`);
  });
});
