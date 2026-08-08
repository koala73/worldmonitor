import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalConvexUrl = process.env.CONVEX_URL;
const originalConvexSiteUrl = process.env.CONVEX_SITE_URL;
const originalRelaySecret = process.env.RELAY_SHARED_SECRET;
const originalResendApiKey = process.env.RESEND_API_KEY;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
  if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalConvexUrl;
  if (originalConvexSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = originalConvexSiteUrl;
  if (originalRelaySecret === undefined) delete process.env.RELAY_SHARED_SECRET;
  else process.env.RELAY_SHARED_SECRET = originalRelaySecret;
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendApiKey;
});

describe('notification relay welcome identity', () => {
  it('does not deliver a delayed welcome to a replacement channel', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    process.env.CONVEX_URL = 'https://convex.test';
    process.env.CONVEX_SITE_URL = 'https://convex.test';
    process.env.RELAY_SHARED_SECRET = 'relay-secret';
    process.env.RESEND_API_KEY = 'resend-key';
    const resendSends = [];
    const relayPath = require.resolve('../scripts/notification-relay.cjs');
    delete require.cache[relayPath];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, ...rest) {
      if (request === 'resend') {
        return {
          Resend: class {
            emails = {
              send: async (message) => {
                resendSends.push(message);
                return { data: { id: 'sent' }, error: null };
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, ...rest);
    };
    let processWelcome;
    let popNextEvent;
    try {
      ({ processWelcome, popNextEvent } = require(relayPath));
    } finally {
      Module._load = originalLoad;
    }

    const fetchMock = mock.fn(async (input) => {
      assert.equal(String(input), 'https://convex.test/relay/channels');
      return Response.json([{
        _id: 'replacement-channel-id',
        userId: 'user-welcome',
        channelType: 'email',
        email: 'replacement@example.com',
        verified: true,
      }]);
    });
    globalThis.fetch = fetchMock;

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
      welcomeId: 'original-channel-id',
    });

    assert.equal(fetchMock.mock.calls.length, 1, 'replacement channel must not receive the stale welcome');
    assert.equal(resendSends.length, 0, 'replacement email channel must not receive the stale welcome');

    const queueCalls = [];
    globalThis.fetch = mock.fn(async (input) => {
      const url = String(input);
      queueCalls.push(url);
      if (url.includes('/RPOP/wm%3Aevents%3Aqueue%3Awelcome-v2')) {
        return Response.json({ result: JSON.stringify({
          eventType: 'channel_welcome',
          welcomeId: 'original-channel-id',
        }) });
      }
      throw new Error(`Unexpected queue poll: ${url}`);
    });
    const queued = await popNextEvent(0);
    assert.match(queued, /original-channel-id/);
    assert.equal(queueCalls.length, 1, 'v2 welcome must not be exposed to the legacy queue consumer');
  });

  it('delivers legacy events without welcomeId and v2 events whose welcomeId matches', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    process.env.CONVEX_URL = 'https://convex.test';
    process.env.CONVEX_SITE_URL = 'https://convex.test';
    process.env.RELAY_SHARED_SECRET = 'relay-secret';
    process.env.RESEND_API_KEY = 'resend-key';
    const resendSends = [];
    const relayPath = require.resolve('../scripts/notification-relay.cjs');
    delete require.cache[relayPath];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, ...rest) {
      if (request === 'resend') {
        return {
          Resend: class {
            emails = {
              send: async (message) => {
                resendSends.push(message);
                return { data: { id: 'sent' }, error: null };
              },
            };
          },
        };
      }
      return originalLoad.call(this, request, parent, ...rest);
    };
    let processWelcome;
    try {
      ({ processWelcome } = require(relayPath));
    } finally {
      Module._load = originalLoad;
    }

    globalThis.fetch = mock.fn(async (input) => {
      assert.equal(String(input), 'https://convex.test/relay/channels');
      return Response.json([{
        _id: 'current-channel-id',
        userId: 'user-welcome',
        channelType: 'email',
        email: 'current@example.com',
        verified: true,
      }]);
    });

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
    });
    assert.equal(resendSends.length, 1, 'legacy event without welcomeId must still deliver');
    assert.equal(resendSends[0].to, 'current@example.com');

    await processWelcome({
      eventType: 'channel_welcome',
      userId: 'user-welcome',
      channelType: 'email',
      welcomeId: 'current-channel-id',
    });
    assert.equal(resendSends.length, 2, 'matching welcomeId must deliver to its own connection');
  });
});
