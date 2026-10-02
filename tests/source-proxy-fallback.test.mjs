import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { fetchChinaCorporateDisclosureSnapshot } from '../scripts/china-corporate-disclosures/adapters.mjs';
import { fetchCrossStraitActivitySnapshot } from '../scripts/cross-strait-activity/adapters.mjs';

// The per-source proxy split (#5756) promises source-specific variables take
// precedence while PROXY_URL is "retained as a compatibility fallback". Every
// other test of that promise is a source-text regex over the default-parameter
// expression -- and because every behavioral test passes `proxyUrl` explicitly
// as an argument, that expression never actually executes anywhere in the
// suite. These tests exercise the resolution itself, so a refactor that drops
// the `|| process.env.PROXY_URL` term fails here rather than only tripping a
// formatting-sensitive regex.

const PROXY_VARS = [
  'PROXY_URL',
  'SZSE_PROXY_URL',
  'JAPAN_MOD_PROXY_URL',
];

const MANAGED_VARS = PROXY_VARS;

const saved = new Map();
for (const name of MANAGED_VARS) saved.set(name, process.env[name]);

function setProxyEnv(values) {
  for (const name of MANAGED_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// Each adapter resolves its proxy URL in a default parameter, parses it with
// parseProxyConfig, and hands the result to the transport as
// proxyRequestFn(url, {host, port, auth, tls}, opts). Record the destination too:
// cross-strait collection can proxy MND and Japan requests in either order.
function recordingProxyFetch() {
  const routes = [];
  return {
    routes,
    proxyRequestFn: (url, proxyConfig) => {
      routes.push({ target: new URL(url).hostname, proxy: proxyConfig?.host ?? null });
      throw new Error('proxy transport short-circuited for test');
    },
  };
}

describe('source-specific proxy resolution', () => {
  describe('SZSE / china corporate disclosures', () => {
    it('prefers SZSE_PROXY_URL when both are set', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1', SZSE_PROXY_URL: 'http://szse:2' });
      const { routes, proxyRequestFn } = recordingProxyFetch();
      await fetchChinaCorporateDisclosureSnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        onDecision: () => {},
      }).catch(() => {});
      assert.ok(routes.length > 0, 'proxy transport must be reached');
      assert.equal(routes[0].proxy, 'szse');
    });

    it('falls back to PROXY_URL when the source-specific var is unset', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1' });
      const { routes, proxyRequestFn } = recordingProxyFetch();
      await fetchChinaCorporateDisclosureSnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        onDecision: () => {},
      }).catch(() => {});
      assert.ok(routes.length > 0, 'proxy transport must be reached');
      assert.equal(routes[0].proxy, 'shared');
    });
  });

  describe('Japan MOD / cross-strait activity', () => {
    it('prefers JAPAN_MOD_PROXY_URL when both are set', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1', JAPAN_MOD_PROXY_URL: 'http://japan:2' });
      const { routes, proxyRequestFn } = recordingProxyFetch();
      await fetchCrossStraitActivitySnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        sleepFn: async () => {},
      }).catch(() => {});
      assert.deepEqual(routes.filter(route => route.target === 'www.mod.go.jp'), [
        { target: 'www.mod.go.jp', proxy: 'japan' },
      ]);
      assert.deepEqual(routes.filter(route => route.target === 'www.mnd.gov.tw'), [
        { target: 'www.mnd.gov.tw', proxy: 'shared' },
      ]);
    });

    it('falls back to PROXY_URL when the source-specific var is unset', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1' });
      const { routes, proxyRequestFn } = recordingProxyFetch();
      await fetchCrossStraitActivitySnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        sleepFn: async () => {},
      }).catch(() => {});
      assert.deepEqual(routes.filter(route => route.target === 'www.mod.go.jp'), [
        { target: 'www.mod.go.jp', proxy: 'shared' },
      ]);
      assert.deepEqual(routes.filter(route => route.target === 'www.mnd.gov.tw'), [
        { target: 'www.mnd.gov.tw', proxy: 'shared' },
      ]);
    });
  });
});
