import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const REDIS_URL = 'https://redis.test';
const CALLBACK_ORIGIN = 'https://worldmonitor.test';
const TEST_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
const ENV_KEYS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_REDIRECT_URI',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'CONVEX_SITE_URL',
  'RELAY_SHARED_SECRET',
  'NOTIFICATION_ENCRYPTION_KEY',
];
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const providers = {
  slack: {
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    tokenResponse: {
      ok: true,
      incoming_webhook: {
        url: 'https://hooks.slack.test/services/T000/B000/secret',
        channel: '#alerts',
        channel_id: 'C000',
        configuration_url: 'https://slack.test/configure',
      },
      team: { id: 'T000', name: 'Test Team' },
    },
    successType: 'wm:slack_connected',
  },
  discord: {
    tokenUrl: 'https://discord.com/api/oauth2/token',
    tokenResponse: {
      webhook: {
        url: 'https://discord.test/api/webhooks/000/secret',
        guild_id: 'guild-000',
        channel_id: 'channel-000',
      },
    },
    successType: 'wm:discord_connected',
  },
};

function setTestEnv() {
  Object.assign(process.env, {
    SLACK_CLIENT_ID: 'slack-client',
    SLACK_CLIENT_SECRET: 'slack-secret',
    SLACK_REDIRECT_URI: `${CALLBACK_ORIGIN}/api/slack/oauth/callback`,
    DISCORD_CLIENT_ID: 'discord-client',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    DISCORD_REDIRECT_URI: `${CALLBACK_ORIGIN}/api/discord/oauth/callback`,
    UPSTASH_REDIS_REST_URL: REDIS_URL,
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    CONVEX_SITE_URL: 'https://convex.test',
    RELAY_SHARED_SECRET: 'relay-secret',
    NOTIFICATION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function callbackRequest(provider, state = 'state-replay-test') {
  return new Request(
    `${CALLBACK_ORIGIN}/api/${provider}/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
  );
}

function makeFetchStub(provider, { failAtomicConsume = false } = {}) {
  const config = providers[provider];
  const calls = {
    atomicConsumes: 0,
    gets: 0,
    deletes: 0,
    tokenExchanges: 0,
    relayWrites: 0,
  };
  let consumed = false;

  const fetchStub = async (input) => {
    const url = String(input);

    if (url.startsWith(`${REDIS_URL}/getdel/`)) {
      calls.atomicConsumes += 1;
      if (failAtomicConsume) throw new Error('Redis unavailable');
      if (consumed) return jsonResponse({ result: null });
      consumed = true;
      return jsonResponse({ result: 'user-123' });
    }

    if (url.startsWith(`${REDIS_URL}/get/`)) {
      calls.gets += 1;
      return jsonResponse({ result: 'user-123' });
    }

    if (url.startsWith(`${REDIS_URL}/del/`)) {
      calls.deletes += 1;
      throw new Error('Redis unavailable');
    }

    if (url === config.tokenUrl) {
      calls.tokenExchanges += 1;
      return jsonResponse(config.tokenResponse);
    }

    if (url === 'https://convex.test/relay/notification-channels') {
      calls.relayWrites += 1;
      return jsonResponse({ ok: true, isNew: false });
    }

    throw new Error(`Unexpected fetch in OAuth callback test: ${url}`);
  };

  return { calls, fetchStub };
}

async function loadHandler(provider) {
  const module = await import(`../api/${provider}/oauth/callback.ts?oauth-state-test=${provider}`);
  return module.default;
}

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('OAuth callback state consumption', () => {
  it('atomically consumes one Slack and Discord state across concurrent callbacks', async () => {
    setTestEnv();

    for (const provider of Object.keys(providers)) {
      const { calls, fetchStub } = makeFetchStub(provider);
      globalThis.fetch = fetchStub;
      const handler = await loadHandler(provider);

      const responses = await Promise.all([
        handler(callbackRequest(provider), { waitUntil() {} }),
        handler(callbackRequest(provider), { waitUntil() {} }),
      ]);
      const bodies = await Promise.all(responses.map((response) => response.text()));

      assert.equal(calls.atomicConsumes, 2, `${provider}: each callback must use Redis GETDEL`);
      assert.equal(calls.gets, 0, `${provider}: callback must not split validation into GET`);
      assert.equal(calls.deletes, 0, `${provider}: callback must not split consumption into DEL`);
      assert.equal(calls.tokenExchanges, 1, `${provider}: a replay must not reach the provider token endpoint`);
      assert.equal(calls.relayWrites, 1, `${provider}: a replay must not mutate Convex twice`);
      assert.equal(bodies.filter((body) => body.includes(providers[provider].successType)).length, 1);
      assert.equal(bodies.filter((body) => body.includes('invalid_state')).length, 1);
    }
  });

  it('fails closed when atomic state consumption is unavailable', async () => {
    setTestEnv();

    for (const provider of Object.keys(providers)) {
      const { calls, fetchStub } = makeFetchStub(provider, { failAtomicConsume: true });
      globalThis.fetch = fetchStub;
      const handler = await loadHandler(provider);

      const response = await handler(callbackRequest(provider), { waitUntil() {} });
      const body = await response.text();

      assert.equal(response.status, 503, `${provider}: Redis failure must be retryable, not a success page`);
      assert.match(body, /service_unavailable/);
      assert.equal(calls.atomicConsumes, 1);
      assert.equal(calls.tokenExchanges, 0, `${provider}: Redis failure must not exchange a provider token`);
      assert.equal(calls.relayWrites, 0, `${provider}: Redis failure must not mutate Convex`);
    }
  });
});
