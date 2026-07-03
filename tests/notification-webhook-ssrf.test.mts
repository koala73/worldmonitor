import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  blockedNotificationWebhookUrlReason,
  isBlockedNotificationResolvedAddress,
} from '../api/_notification-webhook-ssrf';

const require = createRequire(import.meta.url);
const scriptSsrf = require('../scripts/lib/notification-webhook-ssrf.cjs') as {
  assertNotificationWebhookDeliveryUrlSafe: (
    rawUrl: string,
    resolveHostname?: (hostname: string) => Promise<string[]>,
  ) => Promise<{ url: URL; resolvedAddresses: string[] }>;
  blockedNotificationWebhookUrlReason: (rawUrl: string) => string | null;
  isBlockedResolvedAddress: (address: string) => boolean;
};

const blockedUrls = [
  'https://localhost/hook',
  'https://2130706433/hook',
  'https://0x7f000001/hook',
  'https://0177.0.0.1/hook',
  'https://169.254.169.254/latest/meta-data',
  'https://100.64.0.1/hook',
  'https://192.0.2.10/hook',
  'https://198.51.100.10/hook',
  'https://203.0.113.10/hook',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://[::ffff:169.254.169.254]/hook',
  'https://[::ffff:7f00:1]/hook',
  'https://[::ffff:a9fe:a9fe]/hook',
  'https://[fe80::1]/hook',
  'https://[2001:db8::1]/hook',
];

describe('notification webhook SSRF guard', () => {
  test('registration rejects literal private, link-local, reserved, metadata, and IPv4-mapped addresses', () => {
    for (const url of blockedUrls) {
      assert.ok(blockedNotificationWebhookUrlReason(url), `api helper must block ${url}`);
      assert.ok(scriptSsrf.blockedNotificationWebhookUrlReason(url), `script helper must block ${url}`);
    }
    assert.equal(blockedNotificationWebhookUrlReason('https://example.com/hook'), null);
    assert.equal(scriptSsrf.blockedNotificationWebhookUrlReason('https://example.com/hook'), null);
  });

  test('address classifier blocks DNS-resolved private and reserved ranges with parity', () => {
    const blockedAddresses = [
      '169.254.169.254',
      '100.64.12.34',
      '0.1.2.3',
      '192.0.0.5',
      '198.18.0.1',
      '224.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1234',
    ];
    for (const address of blockedAddresses) {
      assert.equal(isBlockedNotificationResolvedAddress(address), true, `api helper must block ${address}`);
      assert.equal(scriptSsrf.isBlockedResolvedAddress(address), true, `script helper must block ${address}`);
    }
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      assert.equal(isBlockedNotificationResolvedAddress(address), false, `api helper must allow ${address}`);
      assert.equal(scriptSsrf.isBlockedResolvedAddress(address), false, `script helper must allow ${address}`);
    }
  });

  test('delivery rejects DNS rebinding to link-local and reserved addresses', async () => {
    await assert.rejects(
      () => scriptSsrf.assertNotificationWebhookDeliveryUrlSafe(
        'https://webhook.example.test/hook',
        async () => ['169.254.169.254'],
      ),
      /private\/reserved address/,
    );
    await assert.rejects(
      () => scriptSsrf.assertNotificationWebhookDeliveryUrlSafe(
        'https://webhook.example.test/hook',
        async () => ['::ffff:a9fe:a9fe'],
      ),
      /private\/reserved address/,
    );

    await assert.doesNotReject(async () => {
      const result = await scriptSsrf.assertNotificationWebhookDeliveryUrlSafe(
        'https://webhook.example.test/hook',
        async () => ['93.184.216.34'],
      );
      assert.deepEqual(result.resolvedAddresses, ['93.184.216.34']);
    });
  });

  test('realtime and digest arbitrary webhook senders use pinned delivery helper', () => {
    for (const relPath of ['scripts/notification-relay.cjs', 'scripts/seed-digest-notifications.mjs']) {
      const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      assert.match(source, /assertNotificationWebhookDeliveryUrlSafe/);
      assert.match(source, /postJsonWithPinnedAddress/);
    }
  });

  test('pinned delivery helper keeps hard timeout and response body caps', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/lib/notification-webhook-ssrf.cjs'), 'utf8');
    assert.match(source, /MAX_WEBHOOK_RESPONSE_BYTES/);
    assert.match(source, /totalBytes > MAX_WEBHOOK_RESPONSE_BYTES/);
    assert.match(source, /hardDeadline = setTimeout/);
    assert.match(source, /clearTimeout\(hardDeadline\)/);
  });
});
