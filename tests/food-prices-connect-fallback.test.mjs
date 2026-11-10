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
    const connect = foodSourceConnectOptions(undefined, { dnsLookup: rotatingDns(queries) });
    // Shorter than production so the dead address is abandoned quickly here.
    const agent = new Agent({ connect: { ...connect, timeout: 3_000, autoSelectFamilyAttemptTimeout: 250 } });
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
});
