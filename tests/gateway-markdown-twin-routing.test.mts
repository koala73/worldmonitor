import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createDomainGateway } from '../server/gateway.ts';

function makeGateway(onRpcDispatch: () => void) {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/forecast/v1/get-forecast-scorecard',
      handler: async () => {
        onRpcDispatch();
        return Response.json({ source: 'rpc' });
      },
    },
    {
      method: 'GET',
      path: '/api/seismology/v1/list-earthquakes',
      handler: async () => {
        onRpcDispatch();
        return Response.json({ source: 'rpc' });
      },
    },
  ]);
}

describe('dynamic API gateway markdown twins', () => {
  for (const markdownPath of [
    '/api/forecast/v1/get-forecast-scorecard.md',
    '/api/v2/shipping/get-port-congestion.md',
  ]) {
    it(`routes ${markdownPath} to its sibling twin before RPC dispatch`, async () => {
      let rpcDispatches = 0;
      const gateway = makeGateway(() => {
        rpcDispatches += 1;
      });
      const originalFetch = globalThis.fetch;
      let fetchedPathname = '';
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchedPathname = new URL(String(input)).pathname;
        return Response.json({ source: 'sibling' });
      }) as typeof fetch;

      try {
        const res = await gateway(new Request(`https://worldmonitor.app${markdownPath}`, {
          headers: { 'User-Agent': 'ExampleCrawler/1.0' },
        }));

        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
        assert.equal(fetchedPathname, markdownPath.slice(0, -3));
        assert.equal(rpcDispatches, 0, 'the .md segment must not be dispatched as an RPC name');
        assert.match(await res.text(), /^# /m);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('keeps the unsuffixed API path on the normal RPC route', async () => {
    let rpcDispatches = 0;
    const gateway = makeGateway(() => {
      rpcDispatches += 1;
    });

    const res = await gateway(new Request(
      'https://worldmonitor.app/api/seismology/v1/list-earthquakes',
    ));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { source: 'rpc' });
    assert.equal(rpcDispatches, 1);
  });
});
