import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import bootstrapHandler, {
  isAnonymousWeatherBootstrapRequest,
  isPublicWeatherBootstrapRequest,
} from '../api/bootstrap.js';
import { issueSessionToken } from '../api/_session.js';
import { createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS } from '../server/gateway.ts';

// The four map RPCs entered PUBLIC_NO_AUTH_RPC_PATHS in #4290 for one reason:
// the cross-site embed had no credential to present. It now polls the single
// composed `/api/embed/map-frame`, which calls these handlers in-process, so
// the anonymous RPC surface no longer has a caller and is gone.
//
// This spec is deliberately two-sided. Removing the exception is only correct
// while a `wms_` session still reaches them, because that is what the public
// dashboard presents (src/services/wm-session.ts attaches the token as both the
// `wm-session` cookie and an `X-WorldMonitor-Key` header). A change that gated
// these behind a real key would 401 every anonymous visitor.
//
// Honest scope: this closes an embed-shaped scraping surface, it does not make
// the data private. `earthquakes`, `naturalEvents` and `unrestEvents` still ride
// the anonymous `?tier=fast|slow&public=1` bootstrap, and `weatherAlerts` has
// its own public URL below.
const EMBED_PUBLIC_RPC_PATHS = [
  '/api/conflict/v1/list-acled-events',
  '/api/natural/v1/list-natural-events',
  '/api/seismology/v1/list-earthquakes',
  '/api/unrest/v1/list-unrest-events',
] as const;

const originalSecret = process.env.WM_SESSION_SECRET;
let sessionToken: string;

before(async () => {
  process.env.WM_SESSION_SECRET = 'embed-public-data-auth-secret-at-least-32-chars';
  sessionToken = (await issueSessionToken()).token;
});

after(() => {
  if (originalSecret == null) delete process.env.WM_SESSION_SECRET;
  else process.env.WM_SESSION_SECRET = originalSecret;
});

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
  it('keeps the map embed RPCs out of the public no-auth exceptions', () => {
    for (const path of EMBED_PUBLIC_RPC_PATHS) {
      assert.equal(
        PUBLIC_NO_AUTH_RPC_PATHS.has(path),
        false,
        `${path} must require a credential — the embed reads it through /api/embed/map-frame`,
      );
    }
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/bootstrap'), false, 'bootstrap must not be public wholesale');
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/conflict/v1/list-ucdp-events'), false, 'nearby conflict RPCs remain gated');
  });

  it('rejects anonymous callers on the map embed RPCs', async () => {
    const gateway = makeGateway();

    for (const path of EMBED_PUBLIC_RPC_PATHS) {
      const res = await gateway(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app' },
      }));
      assert.equal(res.status, 401, `${path} must not answer a credential-less request`);
    }

    const gated = await gateway(new Request('https://worldmonitor.app/api/conflict/v1/list-ucdp-events', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(gated.status, 401);
  });

  it('still serves them to the anonymous public site, by cookie or by header', async () => {
    const gateway = makeGateway();

    for (const path of EMBED_PUBLIC_RPC_PATHS) {
      const viaCookie = await gateway(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app', Cookie: `wm-session=${sessionToken}` },
      }));
      assert.equal(viaCookie.status, 200, `${path} must answer a wms_ session cookie`);

      const viaHeader = await gateway(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': sessionToken },
      }));
      assert.equal(viaHeader.status, 200, `${path} must answer a wms_ session header`);
    }
  });

  it('scopes anonymous bootstrap access to the weather key only', async () => {
    // Two anonymous shapes, one key. `&public=1` is the CDN-shielded read the
    // dashboard and the embed's weather layer both use. The bare URL stays
    // anonymous because it is a documented public API contract
    // (docs/api-platform.mdx, docs/usage-auth.mdx): omit the key header and you
    // get weather, attach one and it is validated — which is also why it is
    // never shared-cacheable, so a warm edge entry cannot answer a credentialed
    // request (#5386). No in-repo caller reads it; closing it would break
    // documented third-party server-to-server access, not the embed.
    for (const url of [
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts',
    ]) {
      const publicReq = new Request(url, { headers: { Origin: 'https://worldmonitor.app' } });

      const publicRes = await bootstrapHandler(publicReq);
      // This test intentionally has no Redis credentials. The public route still
      // bypasses auth, then reports the unavailable cache as a retryable outage
      // instead of turning it into a cacheable empty success.
      assert.equal(publicRes.status, 503, url);
      assert.equal(publicRes.headers.get('cache-control'), 'no-store', url);
    }

    assert.equal(isPublicWeatherBootstrapRequest(new Request(
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1',
      { headers: { Origin: 'https://worldmonitor.app' } },
    )), true);
    assert.equal(isAnonymousWeatherBootstrapRequest(new Request(
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts',
      { headers: { Origin: 'https://worldmonitor.app' } },
    )), true);

    const rejected = [
      'https://worldmonitor.app/api/bootstrap',
      'https://worldmonitor.app/api/bootstrap?tier=fast',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts,marketQuotes',
      'https://worldmonitor.app/api/bootstrap?keys=marketQuotes',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&debug=1',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&keys=marketQuotes',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1&debug=1',
      'https://worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=0',
      'https://worldmonitor.app/api/bootstrap?keys=marketQuotes&public=1',
    ];

    for (const url of rejected) {
      const req = new Request(url, { headers: { Origin: 'https://worldmonitor.app' } });
      assert.equal(isPublicWeatherBootstrapRequest(req), false, url);
      assert.equal(isAnonymousWeatherBootstrapRequest(req), false, url);
      const res = await bootstrapHandler(req);
      assert.equal(res.status, 401, `${url} must still require auth`);
    }
  });
});
