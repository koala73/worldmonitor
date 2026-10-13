/**
 * The MCP OAuth consent nonce is bound to the browser that started the flow.
 *
 * Without the binding, an attacker could start an authorization on their own
 * MCP client, copy the nonce out of the consent page, and send the victim the
 * worldmonitor.app/mcp-grant?nonce=… link (or a consent form). The victim's
 * approval would mint a code for the VICTIM's account and deliver it to the
 * attacker's redirect_uri and state. Each redemption path (API-key consent
 * POST, grant context, grant mint) must refuse a request that lacks the
 * cookie the GET set.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';

import { grantContextHandler } from '../api/internal/mcp-grant-context.ts';
import { mintGrantHandler } from '../api/internal/mcp-grant-mint.ts';
import { signGrant } from '../api/_mcp-grant-hmac.ts';

const REDIS_URL = 'https://redis.test';
const ENTERPRISE_KEY = 'enterprise-test-key';
const CLIENT_ID = 'client_claude';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CODE_CHALLENGE = 'a'.repeat(43);

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WORLDMONITOR_VALID_KEYS'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let store;

function installRedisStub() {
  store = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== REDIS_URL) throw new Error(`unexpected fetch ${url}`);
    const [, op, rawKey] = url.pathname.split('/');
    const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
    if (op === 'get') return reply(store.get(decodeURIComponent(rawKey)) ?? null);
    if (op === 'getdel') {
      const key = decodeURIComponent(rawKey);
      const value = store.get(key) ?? null;
      store.delete(key);
      return reply(value);
    }
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = (pipeline ? body : [body]).map(([cmd, key, value]) => {
      if (['eval', 'evalsha'].includes(cmd.toLowerCase())) return { result: [9, 10] };
      store.set(key, value);
      return { result: 'OK' };
    });
    return Response.json(pipeline ? results : results[0]);
  };
}

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { default: authorizeHandler } = await import('../api/oauth/authorize.js');

async function startFlow({ host = 'api.worldmonitor.app', cookie } = {}) {
  store.set(`oauth:client:${CLIENT_ID}`, JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }));
  const url = new URL(`https://${host}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'attacker_state',
  }).toString();
  const before = new Set(store.keys());
  const res = await authorizeHandler(new Request(url, { headers: { host, ...(cookie ? { cookie } : {}) } }));
  assert.equal(res.status, 200);
  const nonceKey = [...store.keys()].find((k) => k.startsWith('oauth:nonce:') && !before.has(k));
  assert.ok(nonceKey);
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  return {
    nonce: nonceKey.slice('oauth:nonce:'.length),
    nonceData: JSON.parse(store.get(nonceKey)),
    setCookie,
    cookie: setCookie.split(';')[0],
  };
}

function submitConsent(nonce, cookie) {
  const host = 'api.worldmonitor.app';
  return authorizeHandler(new Request(`https://${host}/oauth/authorize`, {
    method: 'POST',
    headers: {
      host,
      origin: `https://${host}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ api_key: ENTERPRISE_KEY, _nonce: nonce }).toString(),
  }));
}

describe('GET /oauth/authorize sets the browser binding', () => {
  it('sets a Secure HttpOnly Lax cookie scoped to worldmonitor.app and stores only its hash', async () => {
    installRedisStub();
    const { setCookie, cookie, nonceData } = await startFlow({ host: 'www.worldmonitor.app' });
    assert.match(setCookie, /^__Secure-wm_oauth_bind_[a-f0-9-]{36}=[A-Za-z0-9_-]{43};/);
    for (const attr of ['Max-Age=600', 'Path=/', 'Domain=worldmonitor.app', 'Secure', 'HttpOnly', 'SameSite=Lax']) {
      assert.ok(setCookie.split('; ').includes(attr), `missing ${attr}`);
    }
    assert.match(nonceData.bind_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(nonceData).includes(cookie.split('=')[1]), 'raw cookie value never stored');
  });

  it('keeps simultaneous first starts independent before either cookie is stored', async () => {
    installRedisStub();
    const first = await startFlow();
    const second = await startFlow();
    assert.notEqual(second.cookie.split('=')[0], first.cookie.split('=')[0]);
    const cookies = `${first.cookie}; ${second.cookie}`;
    assert.equal((await submitConsent(first.nonce, cookies)).status, 302);
    assert.equal((await submitConsent(second.nonce, cookies)).status, 302);
  });

  it('omits Domain off worldmonitor.app hosts (preview deployments)', async () => {
    installRedisStub();
    const { setCookie } = await startFlow({ host: 'wm-preview.vercel.app' });
    assert.ok(!setCookie.includes('Domain='));
  });
});

describe('API-key consent POST requires the binding', () => {
  it('redirects with a code for the browser that started the flow', async () => {
    installRedisStub();
    const { nonce, cookie } = await startFlow();
    const res = await submitConsent(nonce, cookie);
    assert.equal(res.status, 302);
    assert.ok(new URL(res.headers.get('Location')).searchParams.get('code'));
  });

  it('renews the binding cookie with a retry nonce so the retry outlives the original cookie', async () => {
    installRedisStub();
    const { nonce, cookie } = await startFlow();
    const host = 'api.worldmonitor.app';
    const res = await authorizeHandler(new Request(`https://${host}/oauth/authorize`, {
      method: 'POST',
      headers: { host, origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ api_key: 'wrong-key', _nonce: nonce }).toString(),
    }));
    assert.equal(res.status, 200);
    const renewed = res.headers.get('Set-Cookie') ?? '';
    assert.equal(renewed.split(';')[0], cookie, 'same binding value is re-sent');
    assert.ok(renewed.split('; ').includes('Max-Age=600'));
    const retryNonce = [...store.keys()].find((k) => k.startsWith('oauth:nonce:'))?.slice('oauth:nonce:'.length);
    assert.ok(retryNonce && retryNonce !== nonce);
    assert.equal((await submitConsent(retryNonce, cookie)).status, 302);
  });

  it('refuses a forwarded nonce submitted without the cookie, and burns it', async () => {
    installRedisStub();
    const { nonce } = await startFlow();
    const res = await submitConsent(nonce, '');
    assert.equal(res.status, 400);
    assert.match(await res.text(), /different browser/);
    assert.equal([...store.keys()].some((k) => k.startsWith('oauth:code:')), false);
    assert.equal(store.has(`oauth:nonce:${nonce}`), false);
  });

  it('refuses a forwarded nonce submitted with a different browser cookie', async () => {
    installRedisStub();
    const attacker = await startFlow();
    const victim = await startFlow();
    assert.notEqual(attacker.cookie, victim.cookie);
    const res = await submitConsent(attacker.nonce, victim.cookie);
    assert.equal(res.status, 400);
    assert.equal([...store.keys()].some((k) => k.startsWith('oauth:code:')), false);
  });
});

describe('Pro grant bridge requires the binding', () => {
  const NOW = 1_800_000_000_000;
  const PRO = { features: { tier: 1, mcpAccess: true }, validUntil: NOW + 86_400_000 };

  async function bridgeDeps() {
    return {
      resolveUserId: async () => 'user_victim',
      redisGet: async (key) => {
        const raw = store.get(key);
        return raw == null ? null : JSON.parse(raw);
      },
      redisSetEx: async () => true,
      redisSetNxEx: async () => true,
      getEntitlements: async () => PRO,
      isAllowedRedirectUri: () => true,
      signGrant: (payload) => signGrant(payload, 'test-secret-32bytes-1234567890ab'),
      now: () => NOW,
    };
  }

  function mintReq(nonce, cookie) {
    return new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ nonce }),
    });
  }

  function contextReq(nonce, cookie) {
    return new Request(`https://worldmonitor.app/api/internal/mcp-grant-context?nonce=${nonce}`, {
      headers: { Authorization: 'Bearer jwt', ...(cookie ? { cookie } : {}) },
    });
  }

  it('mints for the browser that started the flow', async () => {
    installRedisStub();
    const { nonce, cookie } = await startFlow();
    const deps = await bridgeDeps();
    globalThis.fetch = originalFetch;
    assert.equal((await grantContextHandler(contextReq(nonce, cookie), deps)).status, 200);
    assert.equal((await mintGrantHandler(mintReq(nonce, cookie), deps)).status, 200);
  });

  for (const [label, cookieFor] of [
    ['no cookie', () => ''],
    ['another browser', () => '__Secure-wm_oauth_bind=' + 'B'.repeat(43)],
  ]) {
    it(`refuses a forwarded /mcp-grant link (${label}) in context and mint`, async () => {
      installRedisStub();
      const { nonce } = await startFlow();
      const deps = await bridgeDeps();
      globalThis.fetch = originalFetch;
      const ctx = await grantContextHandler(contextReq(nonce, cookieFor()), deps);
      assert.equal(ctx.status, 403);
      assert.equal((await ctx.json()).error, 'BROWSER_MISMATCH');
      const mint = await mintGrantHandler(mintReq(nonce, cookieFor()), deps);
      assert.equal(mint.status, 403);
      assert.equal((await mint.json()).error, 'BROWSER_MISMATCH');
    });
  }
});
