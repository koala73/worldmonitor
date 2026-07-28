import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { fetchAllHumanitarianSummaries } from '../scripts/seed-conflict-intel.mjs';
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
  'HAPI_PROXY_URL',
  'SZSE_PROXY_URL',
  'JAPAN_MOD_PROXY_URL',
];

// The HAPI path reaches extendExistingTtl() through a module-level import, which
// is not injectable through the function's options. On a machine that carries
// Redis credentials it therefore issues real EXPIRE commands against production
// keys just by running this test. extendExistingTtlDetailed() guards on these
// two variables and returns without any network call when either is absent, so
// clearing them for the whole file makes the test hermetic regardless of who
// runs it. Restored in afterEach alongside the proxy variables.
const REDIS_VARS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const MANAGED_VARS = [...PROXY_VARS, ...REDIS_VARS];

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
// proxyRequestFn(url, {host, port, auth, tls}, opts). Recording that host is the
// most direct observation of which environment variable won.
function recordingProxyFetch() {
  const hosts = [];
  return {
    hosts,
    proxyRequestFn: (_url, proxyConfig) => {
      hosts.push(proxyConfig?.host ?? null);
      throw new Error('proxy transport short-circuited for test');
    },
  };
}

const botBlockedResponse = async () => ({
  ok: false,
  status: 429,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify({ message: 'Blocked due to bot activity' }),
  json: async () => ({ message: 'Blocked due to bot activity' }),
});

describe('source-specific proxy resolution', () => {
  describe('SZSE / china corporate disclosures', () => {
    it('prefers SZSE_PROXY_URL when both are set', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1', SZSE_PROXY_URL: 'http://szse:2' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchChinaCorporateDisclosureSnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        onDecision: () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'szse');
    });

    it('falls back to PROXY_URL when the source-specific var is unset', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchChinaCorporateDisclosureSnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        onDecision: () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'shared');
    });
  });

  describe('Japan MOD / cross-strait activity', () => {
    it('prefers JAPAN_MOD_PROXY_URL when both are set', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1', JAPAN_MOD_PROXY_URL: 'http://japan:2' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchCrossStraitActivitySnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        sleepFn: async () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'japan');
    });

    it('falls back to PROXY_URL when the source-specific var is unset', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchCrossStraitActivitySnapshot({
        fetchFn: async () => { throw new Error('direct blocked'); },
        proxyRequestFn,
        sleepFn: async () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'shared');
    });
  });

  describe('HAPI / humanitarian summaries', () => {
    it('prefers HAPI_PROXY_URL when both are set', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1', HAPI_PROXY_URL: 'http://hapi:2' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchAllHumanitarianSummaries({
        // HAPI only switches to the proxy on the specific bot-block signature
        // (429 + "blocked due to bot activity"); a generic transport error takes
        // the failure-backoff path instead and never touches the proxy.
        fetchFn: botBlockedResponse,
        proxyRequestFn,
        pace: async () => {},
        countryCodes: ['SY'],
        requiredCountryCodes: ['SY'],
        loadPreviousMarker: async () => null,
        loadFailureBackoff: async () => null,
        writeFailureBackoff: async () => {},
        writeFailureMeta: async () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'hapi');
    });

    it('falls back to PROXY_URL when the source-specific var is unset', async () => {
      setProxyEnv({ PROXY_URL: 'http://shared:1' });
      const { hosts, proxyRequestFn } = recordingProxyFetch();
      await fetchAllHumanitarianSummaries({
        // HAPI only switches to the proxy on the specific bot-block signature
        // (429 + "blocked due to bot activity"); a generic transport error takes
        // the failure-backoff path instead and never touches the proxy.
        fetchFn: botBlockedResponse,
        proxyRequestFn,
        pace: async () => {},
        countryCodes: ['SY'],
        requiredCountryCodes: ['SY'],
        loadPreviousMarker: async () => null,
        loadFailureBackoff: async () => null,
        writeFailureBackoff: async () => {},
        writeFailureMeta: async () => {},
      }).catch(() => {});
      assert.ok(hosts.length > 0, 'proxy transport must be reached');
      assert.equal(hosts[0], 'shared');
    });
  });
});
