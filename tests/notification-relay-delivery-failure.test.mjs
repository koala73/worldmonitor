import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
Object.assign(process.env, {
  UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test',
  CONVEX_URL: 'https://convex.test', CONVEX_SITE_URL: 'https://convex.test',
  CONVEX_NOTIFICATION_RELAY_SECRET: 'test', RESEND_API_KEY: 'test',
  NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
  VAPID_PUBLIC_KEY: 'test', VAPID_PRIVATE_KEY: 'test',
});
let status = 503;
let networkError;
let sends = 0;
const ssrf = require('../scripts/lib/notification-webhook-ssrf.cjs');
const originalSafe = ssrf.assertNotificationWebhookDeliveryUrlSafe;
const originalPost = ssrf.postJsonWithPinnedAddress;
ssrf.assertNotificationWebhookDeliveryUrlSafe = async url => {
  if (networkError) throw networkError;
  return { url, resolvedAddresses: ['93.184.216.34'] };
};
ssrf.postJsonWithPinnedAddress = async () => {
  sends++;
  return { status, ok: status === 200 };
};
const originalLoad = Module._load;
Module._load = function(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'web-push') return {
    setVapidDetails() {},
    async sendNotification() {
      sends++;
      if (networkError) throw networkError;
      if (status !== 200) throw Object.assign(new Error('Provider failure'), { statusCode: status });
    },
  };
  return originalLoad.call(this, request, parent, ...rest);
};
const relay = require('../scripts/notification-relay.cjs');
const { encrypt } = require('../scripts/lib/crypto.cjs');
const targets = {
  slack: 'https://hooks.slack.com/services/T123/B456/secret',
  discord: 'https://discord.com/api/webhooks/123/secret',
  teams: 'https://example.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/example/triggers/manual/paths/invoke?api-version=1&sig=secret',
  web_push: 'https://push.example.com/subscription',
};

after(() => {
  Module._load = originalLoad;
  ssrf.assertNotificationWebhookDeliveryUrlSafe = originalSafe;
  ssrf.postJsonWithPinnedAddress = originalPost;
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

for (const channelType of Object.keys(targets)) {
  for (const outcome of ['HTTP 503', 'HTTP 401', 'DNS lookup failed', 'Request timed out', null]) {
    test(`${channelType} reports ${outcome ?? 'success'} through the welcome delivery path`, async () => {
      status = outcome === null ? 200 : outcome === 'HTTP 401' ? 401 : 503;
      networkError = outcome === 'DNS lookup failed' ? Object.assign(new Error('getaddrinfo ENOTFOUND private host'), { code: 'ENOTFOUND' })
        : outcome === 'Request timed out' ? new Error('request timed out') : undefined;
      const channel = { _id: 'channel-1', linkedAt: 1, verified: true, channelType,
        webhookEnvelope: encrypt(targets[channelType]), endpoint: targets[channelType], p256dh: 'test', auth: 'test' };
      const results = [];
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/relay/channels')) return Response.json([channel]);
        assert.ok(String(url).endsWith('/relay/delivery-result'));
        results.push(...JSON.parse(init.body).results);
        return Response.json({ ok: true });
      };
      await relay.processWelcome({ userId: 'user-test', channelType, welcomeId: 'channel-1' });
      assert.deepEqual(results, [{ userId: 'user-test', channelType,
        delivery: { channelId: 'channel-1', linkedAt: 1, error: outcome } }]);
      channel.verified = false;
      const before = sends;
      await relay.processWelcome({ userId: 'user-test', channelType, welcomeId: 'channel-1' });
      assert.equal(sends, before);
      assert.equal(results.length, 1);
    });
  }
}


test('a slow result report cannot hold up later recipients of the same event', async () => {
  status = 200;
  networkError = undefined;
  sends = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let reporting;
  const started = new Promise(resolve => { reporting = resolve; });
  const reports = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/relay/enabled-rules')) return Response.json(['first', 'second'].map(userId => ({
      userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['slack'], variant: 'full',
    })));
    if (path.endsWith('/relay/entitlement')) return Response.json({ tier: 1 });
    if (path.endsWith('/relay/channels')) {
      const { userId } = JSON.parse(init.body);
      return Response.json([{ _id: userId, linkedAt: 1, channelType: 'slack', verified: true,
        webhookEnvelope: encrypt(targets.slack) }]);
    }
    if (path.endsWith('/relay/delivery-result')) {
      reports.push(...JSON.parse(init.body).results);
      reporting();
      await waiting;
      return Response.json({ ok: true });
    }
    if (String(url).startsWith('https://redis.test')) {
      const command = init?.body ? JSON.parse(init.body)[0] : path.split('/')[1];
      return Response.json({ result: command === 'SET' ? 'OK' : null });
    }
    return Response.json({ result: null });
  };
  const pending = relay.processEvent({ eventType: 'rss_alert', severity: 'critical',
    payload: { title: 'Batch delivery regression', source: 'Reuters' } });
  try {
    await started;
    assert.equal(sends, 2, 'both providers must be attempted before reporting waits');
    assert.deepEqual(reports.map(result => result.userId), ['first', 'second']);
  } finally {
    release();
    await pending;
  }
});
