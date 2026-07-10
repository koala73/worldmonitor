import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import bootstrapHandler, { isPublicWeatherBootstrapRequest } from '../api/bootstrap.js';
import { createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS } from '../server/gateway.ts';

const EMBED_PUBLIC_RPC_PATHS = [
  '/api/conflict/v1/list-acled-events',
  '/api/natural/v1/list-natural-events',
  '/api/seismology/v1/list-earthquakes',
  '/api/unrest/v1/list-unrest-events',
] as const;

function makeGateway() {
  return createDomainGateway([
    ...EMBED_PUBLIC_RPC_PATHS.map((path) => ({
      method: 'GET',
      path,
      handler: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })),
    {
      method: 'GET',
      path: '/api/conflict/v1/list-ucdp-events',
      handler: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    },
  ]);
}

describe('embed public data auth', () => {
  it('pins exactly the map embed RPCs as public no-auth exceptions', () => {
    for (const path of EMBED_PUBLIC_RPC_PATHS) {
      assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has(path), true, `${path} must stay anonymous for cross-site embeds`);
    }
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/bootstrap'), false, 'bootstrap must not be public wholesale');
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/conflict/v1/list-ucdp-events'), false, 'nearby conflict RPCs remain gated');
  });

  it('lets anonymous iframe requests reach embed RPC handlers while nearby RPCs stay gated', async () => {
    const gateway = makeGateway();

    for (const path of EMBED_PUBLIC_RPC_PATHS) {
      const res = await gateway(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app' },
      }));
      assert.equal(res.status, 200, `${path} should not require wm-session in an embed iframe`);
    }

    const gated = await gateway(new Request('https://worldmonitor.app/api/conflict/v1/list-ucdp-events', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(gated.status, 401);
  });

  it('scopes anonymous bootstrap access to the weather embed key only', async () => {
    const publicReq = new Request('https://worldmonitor.app/api/bootstrap?keys=weatherAlerts', {
      headers: { Origin: 'https://worldmonitor.app' },
    });
    assert.equal(isPublicWeatherBootstrapRequest(publicReq), true);

    const publicRes = await bootstrapHandler(publicReq);
    assert.equal(publicRes.status, 200);

    const rejected = [
      'https://worldmonitor.app/api/bootstrap',
      'https://worldmonitor.app/api/bootstrap?tier=fast',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts,marketQuotes',
      'https://worldmonitor.app/api/bootstrap?keys=marketQuotes',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&debug=1',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&keys=marketQuotes',
    ];

    for (const url of rejected) {
      const req = new Request(url, { headers: { Origin: 'https://worldmonitor.app' } });
      assert.equal(isPublicWeatherBootstrapRequest(req), false, url);
      const res = await bootstrapHandler(req);
      assert.equal(res.status, 401, `${url} must still require auth`);
    }
  });
});
