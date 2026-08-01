import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNotificationWebhookRegistrationUrlSafe,
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
  responseFromNode: (
    statusCode: number,
    statusMessage: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ) => Response;
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
  // NAT64 64:ff9b::/96 embedding an internal IPv4
  'https://[64:ff9b::a9fe:a9fe]/hook',
  'https://[64:ff9b::7f00:1]/hook',
  // 6to4 2002::/16 embedding an internal IPv4
  'https://[2002:7f00:1::]/hook',
  'https://[2002:a9fe:a9fe::]/hook',
  // IPv4-compatible ::/96 embedding an internal IPv4
  'https://[::7f00:1]/hook',
  'https://[::a9fe:a9fe]/hook',
  // fec0::/10 deprecated site-local
  'https://[fec0::1]/hook',
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
      // IPv4-mapped hex form (::ffff:hhhh:hhhh) embedding loopback
      '::ffff:7f00:1',
      '::FFFF:7F00:1',
      // NAT64 64:ff9b::/96 → trailing 32 bits are the embedded IPv4
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::7f00:1',
      '0064:ff9b:0000:0000:0000:0000:a9fe:a9fe',
      // 6to4 2002::/16 → the 32 bits after 2002: are the embedded IPv4
      '2002:7f00:1::',
      '2002:a9fe:a9fe::',
      '2002:0a00:0001::',
      // IPv4-compatible ::/96 (::a.b.c.d and ::hhhh:hhhh)
      '::7f00:1',
      '::127.0.0.1',
      '::a9fe:a9fe',
      '::169.254.169.254',
      // fec0::/10 deprecated site-local (not caught by the fe80::/10 regex)
      'fec0::1',
      'feff::1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1234',
    ];
    for (const address of blockedAddresses) {
      assert.equal(isBlockedNotificationResolvedAddress(address), true, `api helper must block ${address}`);
      assert.equal(scriptSsrf.isBlockedResolvedAddress(address), true, `script helper must block ${address}`);
    }
    for (const address of [
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
      // 6to4 wrapping a public IPv4 (93.184.216.34) must still be allowed
      '2002:5db8:d822::',
      // NAT64 wrapping a public IPv4 (93.184.216.34) must still be allowed
      '64:ff9b::5db8:d822',
    ]) {
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

  test('registration rejects DNS-resolved private or mixed answers before persisting the webhook', async () => {
    await assert.rejects(
      () => assertNotificationWebhookRegistrationUrlSafe(
        'https://webhook.example.test/hook',
        async () => ['169.254.169.254'],
      ),
      /private\/local address/,
    );
    await assert.rejects(
      () => assertNotificationWebhookRegistrationUrlSafe(
        'https://webhook.example.test/hook',
        async () => ['93.184.216.34', '10.0.0.1'],
      ),
      /private\/local address/,
    );
    await assert.doesNotReject(() => assertNotificationWebhookRegistrationUrlSafe(
      'https://webhook.example.test/hook',
      async () => ['93.184.216.34'],
    ));
    await assert.doesNotReject(() => assertNotificationWebhookRegistrationUrlSafe(
      'https://93.184.216.34/hook',
      async () => { throw new Error('public IP literals must not require DNS'); },
    ));
  });

  test('notification channel registration validates every persisted webhook envelope', () => {
    const source = readFileSync(resolve(process.cwd(), 'api/notification-channels.ts'), 'utf8');
    assert.doesNotMatch(source, /channelType === 'webhook' && webhookEnvelope/);
    assert.match(
      source,
      /if \(webhookEnvelope\) \{\s*try \{\s*await assertNotificationWebhookRegistrationUrlSafe\(webhookEnvelope\)/,
    );
  });

  test('realtime and digest arbitrary webhook senders use pinned delivery helper', () => {
    for (const relPath of ['scripts/notification-relay.cjs', 'scripts/seed-digest-notifications.mjs']) {
      const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      assert.match(source, /assertNotificationWebhookDeliveryUrlSafe/);
      assert.match(source, /postJsonWithPinnedAddress/);
    }
  });

  test('Slack and Discord senders validate DNS and pin delivery to the vetted address', () => {
    for (const relPath of ['scripts/notification-relay.cjs', 'scripts/seed-digest-notifications.mjs']) {
      const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      const slackStart = source.indexOf('async function sendSlack');
      const discordStart = source.indexOf('async function sendDiscord', slackStart);
      const emailStart = source.indexOf('async function sendEmail', discordStart);

      assert.ok(slackStart >= 0 && discordStart > slackStart && emailStart > discordStart, `${relPath} delivery functions must stay discoverable`);

      const slackSource = source.slice(slackStart, discordStart);
      const discordSource = source.slice(discordStart, emailStart);
      for (const [channel, functionSource] of [['Slack', slackSource], ['Discord', discordSource]] as const) {
        assert.match(
          functionSource,
          /assertNotificationWebhookDeliveryUrlSafe\(webhookUrl\)/,
          `${relPath} ${channel} delivery must validate the final DNS answer`,
        );
        assert.match(
          functionSource,
          /postJsonWithPinnedAddress\(/,
          `${relPath} ${channel} delivery must pin the connection to a vetted address`,
        );
        assert.doesNotMatch(
          functionSource,
          /fetch\(webhookUrl/,
          `${relPath} ${channel} delivery must not re-resolve through ordinary fetch`,
        );
      }
    }
  });

  test('pinned delivery helper keeps hard timeout and response body caps', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/lib/notification-webhook-ssrf.cjs'), 'utf8');
    assert.match(source, /MAX_WEBHOOK_RESPONSE_BYTES/);
    assert.match(source, /totalBytes > MAX_WEBHOOK_RESPONSE_BYTES/);
    assert.match(source, /hardDeadline = setTimeout/);
    assert.match(source, /clearTimeout\(hardDeadline\)/);
  });

  test('pinned delivery helper preserves every null-body HTTP status', async () => {
    for (const status of [204, 205, 304]) {
      const response = scriptSsrf.responseFromNode(status, 'No Content', {}, new Uint8Array());
      assert.equal(response.status, status);
      assert.equal(await response.text(), '');
    }
  });
});
