import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { createDeliveryReporter, deliveryErrorClass } = require('../scripts/lib/notification-delivery.cjs');
const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('digest.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

for (const [type, name] of [['slack', 'sendSlack'], ['discord', 'sendDiscord'], ['teams', 'sendTeams'], ['webhook', 'sendWebhook']]) {
  for (const error of [null, 'HTTP 401', 'HTTP 503', 'DNS lookup failed', 'Request timed out', 'Decrypt failed']) {
    test(`digest ${type} reports ${error ?? 'success'} with connection identity`, async () => {
      const batches = [];
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://convex.test/relay/delivery-result');
        batches.push(JSON.parse(init.body).results);
        return Response.json({ ok: true });
      };
      const reporter = createDeliveryReporter({ siteUrl: 'https://convex.test', secret: 'test', source: 'digest' });
      const status = error?.startsWith('HTTP ') ? Number(error.slice(5)) : 200;
      const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(fn);
      const send = runInNewContext(`${fn.getText(parsed)}\n${name}`, {
        ...reporter, deliveryErrorClass,
        decrypt: value => { if (error === 'Decrypt failed') throw new Error('secret envelope'); return value; },
        SLACK_RE: /./, DISCORD_RE: /./, truncateDiscordContent: value => value,
        resolveWebhookSigningSecret: () => undefined, buildWebhookDeliveryHeaders: () => ({}), digestWebhookStory: value => value,
        assertNotificationWebhookDeliveryUrlSafe: async url => {
          if (error === 'DNS lookup failed') throw Object.assign(new Error('getaddrinfo ENOTFOUND private host'), { code: 'ERR_SSRF_BLOCKED' });
          return { url, resolvedAddresses: ['93.184.216.34'] };
        },
        postJsonWithPinnedAddress: async () => {
          if (error === 'Request timed out') throw new Error('ETIMEDOUT private host');
          return { ok: status === 200, status };
        },
        sendTeamsPayload: async () => ({ ok: error === null, status: error?.startsWith('HTTP ') ? status : 0,
          error: error === 'DNS lookup failed' ? 'getaddrinfo ENOTFOUND private host' : 'Request timed out' }),
      });
      const channel = { _id: 'digest-channel', linkedAt: 123 };
      const ok = await reporter.withDeliveryReports(() => type === 'webhook'
        ? send('owner', 'https://hooks.example.com', [], null, undefined, channel)
        : send('owner', 'https://hooks.example.com', 'Digest', channel));
      assert.equal(ok, error === null);
      assert.deepEqual(batches, [[{ userId: 'owner', channelType: type,
        delivery: { channelId: channel._id, linkedAt: channel.linkedAt, error } }]]);
    });
  }
}

test('shared reporter preserves order, batches at 100, and flushes completed sends after an exception', async () => {
  const batches = [];
  globalThis.fetch = async (_url, init) => { batches.push(JSON.parse(init.body).results); return Response.json({ ok: true }); };
  const reporter = createDeliveryReporter({ siteUrl: 'https://convex.test', secret: 'test', source: 'digest' });
  await assert.rejects(reporter.withDeliveryReports(async () => {
    for (let i = 0; i < 205; i++) {
      await reporter.recordDelivery('owner', 'webhook', { _id: String(i), linkedAt: 1 });
    }
    assert.equal(batches.length, 0, 'reporting must wait until delivery completes');
    throw new Error('later bookkeeping failed');
  }), /later bookkeeping failed/);
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
  assert.deepEqual(batches.flat().map(result => result.delivery.channelId), Array.from({ length: 205 }, (_, i) => String(i)));
});
