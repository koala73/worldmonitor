import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isBlockedResolvedAddress } from '../server/_shared/ip-address-classification';
import { assertCallbackUrlRegistrationSafe } from '../server/worldmonitor/shipping/v2/webhook-shared';
import { assertWebhookDeliveryUrlSafe } from '../server/worldmonitor/shipping/v2/deliver-webhook';

const blocked = [
  '64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '0064:FF9B:0001:0000:0000:0000:0808:0808',
  '100::', '100::ffff:ffff:ffff:ffff', '0100:0000:0000:0000:0000:0000:0000:0001',
];
for (const address of blocked) {
  test(`non-public prefix rejected as literal and DNS answer: ${address}`, async () => {
    assert.equal(isBlockedResolvedAddress(address), true);
    assert.equal(isBlockedResolvedAddress(`[${address}]`), true);
    for (const check of [assertCallbackUrlRegistrationSafe, assertWebhookDeliveryUrlSafe]) {
      await assert.rejects(() => check(`https://[${address}]/hook`, async () => [address]), /private\/reserved/);
      await assert.rejects(() => check('https://callback.example/hook', async () => ['93.184.216.34', address]), /private\/reserved/);
    }
  });
}
test('prefix boundaries do not broaden the existing classifier', () => {
  // Neighbours are unchanged, not a claim that they are globally assigned.
  for (const address of ['64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::', 'ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '100:0:0:1::', '64:ff9b::808:808', '2606:4700:4700::1111']) {
    assert.equal(isBlockedResolvedAddress(address), false, address);
  }
  assert.equal(isBlockedResolvedAddress('64:ff9b::7f00:1'), true);
});
