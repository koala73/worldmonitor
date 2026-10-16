// Customer webhook deliveries are signed with a per-channel secret
// (bughunter sweep 2026-10-11, finding 7). The docs promised X-WM-Signature
// but neither producer sent it, so a leaked receiver URL let anyone forge
// alerts into a customer's automation.

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TEST_SECRET = 'test-signing-secret-not-a-real-key';

// The receiver recipe from docs/api-notifications.mdx, verbatim in spirit.
function verify(rawBody, headers, signingSecret, nowMs = Date.now()) {
  const ts = headers['X-WM-Timestamp'];
  const id = headers['X-WM-Delivery-Id'];
  const sig = headers['X-WM-Signature'] ?? '';
  if (!ts || !id || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const match = /^sha256=([0-9a-f]{64})$/.exec(sig);
  if (!match) return false;
  const expected = createHmac('sha256', signingSecret).update(`${ts}.${id}.${rawBody}`).digest();
  return timingSafeEqual(Buffer.from(match[1], 'hex'), expected);
}

describe('buildWebhookDeliveryHeaders', () => {
  const { buildWebhookDeliveryHeaders, resolveWebhookSigningSecret } = require('../scripts/lib/notification-webhook-signing.cjs');

  it('signs timestamp.deliveryId.body so the documented recipe verifies it', () => {
    const body = JSON.stringify({ version: '1', eventType: 'rss_alert', payload: { title: 'x' } });
    const headers = buildWebhookDeliveryHeaders({ body, eventType: 'rss_alert', secret: TEST_SECRET, deliveryId: 'd-1' });
    assert.equal(headers['X-WM-Event'], 'rss_alert');
    assert.equal(headers['X-WM-Delivery-Id'], 'd-1');
    assert.match(headers['X-WM-Signature'], /^sha256=[0-9a-f]{64}$/);
    assert.ok(verify(body, headers, TEST_SECRET));
  });

  it('a changed body, timestamp or secret fails verification', () => {
    const body = '{"a":1}';
    const headers = buildWebhookDeliveryHeaders({ body, eventType: 'e', secret: TEST_SECRET });
    assert.equal(verify('{"a":2}', headers, TEST_SECRET), false);
    assert.equal(verify(body, { ...headers, 'X-WM-Timestamp': String(Number(headers['X-WM-Timestamp']) - 1) }, TEST_SECRET), false);
    assert.equal(verify(body, headers, 'other-secret'), false);
  });

  it('a replay with a changed delivery id fails verification', () => {
    const body = '{"a":1}';
    const headers = buildWebhookDeliveryHeaders({ body, eventType: 'e', secret: TEST_SECRET, deliveryId: 'd-1' });
    assert.ok(verify(body, headers, TEST_SECRET));
    assert.equal(verify(body, { ...headers, 'X-WM-Delivery-Id': 'd-2' }, TEST_SECRET), false);
  });

  it('the recipe rejects a malformed signature instead of throwing', () => {
    const body = '{}';
    const headers = buildWebhookDeliveryHeaders({ body, eventType: 'e', secret: TEST_SECRET });
    for (const bad of [`sha256=${'é'.repeat(64)}`, `sha256=${'z'.repeat(64)}`, 'sha256=abc', '']) {
      assert.equal(verify(body, { ...headers, 'X-WM-Signature': bad }, TEST_SECRET), false);
    }
  });

  it('a replayed delivery outside the tolerance window is rejected by the recipe', () => {
    const body = '{}';
    const headers = buildWebhookDeliveryHeaders({ body, eventType: 'e', secret: TEST_SECRET, nowMs: Date.now() - 10 * 60_000 });
    assert.equal(verify(body, headers, TEST_SECRET), false);
  });

  it('legacy channels without a secret get no signature but keep the id and event headers', () => {
    const headers = buildWebhookDeliveryHeaders({ body: '{}', eventType: 'digest', secret: null });
    assert.equal(headers['X-WM-Signature'], undefined);
    assert.equal(headers['X-WM-Event'], 'digest');
    assert.match(headers['X-WM-Delivery-Id'], /^[0-9a-f-]{36}$/);
  });

  it('every delivery gets a fresh id', () => {
    const a = buildWebhookDeliveryHeaders({ body: '{}', eventType: 'e', secret: TEST_SECRET });
    const b = buildWebhookDeliveryHeaders({ body: '{}', eventType: 'e', secret: TEST_SECRET });
    assert.notEqual(a['X-WM-Delivery-Id'], b['X-WM-Delivery-Id']);
  });

  it('resolveWebhookSigningSecret returns null only when no secret is stored', () => {
    assert.equal(resolveWebhookSigningSecret(() => 'never', undefined), null);
    assert.equal(resolveWebhookSigningSecret(() => 'never', ''), null);
    assert.equal(resolveWebhookSigningSecret((v) => `plain:${v}`, 'env'), 'plain:env');
    assert.throws(() => resolveWebhookSigningSecret(() => { throw new Error('bad tag'); }, 'env'), /bad tag/);
  });
});

describe('notification-relay sendWebhook', () => {
  const originalKey = process.env.NOTIFICATION_ENCRYPTION_KEY;
  let relay;
  let crypto;
  let posts;

  before(() => {
    process.env.NOTIFICATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    crypto = require('../scripts/lib/crypto.cjs');
    // The relay destructures these at load time, so stub before requiring it.
    const ssrf = require('../scripts/lib/notification-webhook-ssrf.cjs');
    ssrf.assertNotificationWebhookDeliveryUrlSafe = async (url) => ({ url, resolvedAddresses: ['93.184.216.34'] });
    ssrf.postJsonWithPinnedAddress = async (url, body, headers) => {
      posts.push({ url, body, headers });
      return { ok: true, status: 200 };
    };
    process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
    process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
    process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, ...rest) {
      if (request === 'resend') return { Resend: class {} };
      if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
      return originalLoad.call(this, request, parent, ...rest);
    };
    try {
      relay = require('../scripts/notification-relay.cjs');
    } finally {
      Module._load = originalLoad;
    }
  });

  afterEach(() => { posts = []; });
  posts = [];

  it('signs a delivery when the channel has a secret', async () => {
    const ok = await relay.sendWebhook(
      'user-1',
      crypto.encrypt('https://hooks.example.com/in'),
      { eventType: 'rss_alert', payload: { title: 'Signed' } },
      crypto.encrypt(TEST_SECRET),
    );
    assert.equal(ok, true);
    assert.equal(posts.length, 1);
    const { body, headers } = posts[0];
    assert.equal(headers['X-WM-Event'], 'rss_alert');
    assert.equal(JSON.parse(body).eventType, 'rss_alert');
    assert.ok(verify(body, headers, TEST_SECRET), 'the posted bytes must verify with the channel secret');
  });

  it('still delivers unsigned to a legacy channel with no secret', async () => {
    const ok = await relay.sendWebhook('user-1', crypto.encrypt('https://hooks.example.com/in'), { eventType: 'rss_alert' }, undefined);
    assert.equal(ok, true);
    assert.equal(posts[0].headers['X-WM-Signature'], undefined);
  });

  it('skips the delivery rather than sending it unsigned when the stored secret cannot be decrypted', async () => {
    const ok = await relay.sendWebhook('user-1', crypto.encrypt('https://hooks.example.com/in'), { eventType: 'rss_alert' }, 'v1:corrupt');
    assert.equal(ok, false);
    assert.equal(posts.length, 0);
  });

  it('restores the encryption key env', () => {
    if (originalKey === undefined) delete process.env.NOTIFICATION_ENCRYPTION_KEY;
    else process.env.NOTIFICATION_ENCRYPTION_KEY = originalKey;
  });
});

describe('both producers pass the channel secret', () => {
  // seed-digest-notifications.mjs runs on import, so its wiring is checked in
  // source; the shared helper above carries the behaviour.
  const relaySrc = readFileSync(new URL('../scripts/notification-relay.cjs', import.meta.url), 'utf8');
  const digestSrc = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');

  it('every relay webhook call site passes ch.webhookSecret', () => {
    const calls = relaySrc.match(/await sendWebhook\([\s\S]*?\);/g) ?? [];
    assert.ok(calls.length >= 2);
    for (const call of calls) assert.match(call, /ch\.webhookSecret\)/);
  });

  it('the digest producer signs with the shared helper', () => {
    assert.match(digestSrc, /buildWebhookDeliveryHeaders\(\{ body: payload, eventType: 'digest', secret: signingSecret \}\)/);
    assert.match(digestSrc, /sendWebhook\(rule\.userId, ch\.webhookEnvelope, formatterStories, briefLead, ch\.webhookSecret\)/);
  });
});
