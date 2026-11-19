import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { obtainSubscriptionPayload } from '../src/services/push-notifications.ts';

// A revoked Chromium subscription comes back with a placeholder endpoint on
// the reserved `.invalid` TLD, and a subscribe() issued right after
// unsubscribe() can return that placeholder again before Chromium settles
// (phpBB, Couchers and SullyOS all special-case it). Posting it fails the
// server allow-list on every retry, so the client must replace it.

const KEY = new Uint8Array([1, 2, 3]).buffer;

interface FakeSub {
  endpoint: string;
  getKey: (name: string) => ArrayBuffer | null;
  unsubscribe: () => Promise<boolean>;
}

function fakePushManager(existing: string | null, issued: Array<string | 'no-keys'>) {
  const log: string[] = [];
  const make = (endpoint: string, keys = true): FakeSub => ({
    endpoint,
    getKey: () => (keys ? KEY : null),
    unsubscribe: async () => {
      log.push(`unsubscribe ${endpoint}`);
      return true;
    },
  });
  const manager = {
    getSubscription: async () => (existing ? make(existing) : null),
    subscribe: async () => {
      const next = issued.shift();
      assert.ok(next, 'subscribe() called more often than the test allows');
      log.push('subscribe');
      return next === 'no-keys' ? make('https://fcm.googleapis.com/fcm/send/keyless', false) : make(next);
    },
  };
  const settle = async () => {
    log.push('settle');
  };
  return { manager: manager as unknown as PushManager, settle, log };
}

const OPTIONS = { userVisibleOnly: true };

describe('obtainSubscriptionPayload', () => {
  it('reuses a live existing subscription without resubscribing', async () => {
    const { manager, settle, log } = fakePushManager('https://fcm.googleapis.com/fcm/send/live', []);
    const payload = await obtainSubscriptionPayload(manager, OPTIONS, settle);
    assert.equal(payload.endpoint, 'https://fcm.googleapis.com/fcm/send/live');
    assert.deepEqual(log, []);
  });

  it('subscribes once when there is no existing subscription', async () => {
    const { manager, settle, log } = fakePushManager(null, ['https://jmt17.google.com/fcm/send/new']);
    const payload = await obtainSubscriptionPayload(manager, OPTIONS, settle);
    assert.equal(payload.endpoint, 'https://jmt17.google.com/fcm/send/new');
    assert.deepEqual(log, ['subscribe']);
  });

  it('replaces a revoked .invalid subscription, settling after unsubscribe', async () => {
    const { manager, settle, log } = fakePushManager(
      'https://permanently-removed.invalid/fcm/send/dead',
      ['https://fcm.googleapis.com/fcm/send/fresh'],
    );
    const payload = await obtainSubscriptionPayload(manager, OPTIONS, settle);
    assert.equal(payload.endpoint, 'https://fcm.googleapis.com/fcm/send/fresh');
    assert.deepEqual(log, ['unsubscribe https://permanently-removed.invalid/fcm/send/dead', 'settle', 'subscribe']);
  });

  it('retries when the resubscribe hands back the placeholder again', async () => {
    const { manager, settle, log } = fakePushManager(null, [
      'https://permanently-removed.invalid/fcm/send/1',
      'https://fcm.googleapis.com/fcm/send/fresh',
    ]);
    const payload = await obtainSubscriptionPayload(manager, OPTIONS, settle);
    assert.equal(payload.endpoint, 'https://fcm.googleapis.com/fcm/send/fresh');
    assert.deepEqual(log, ['subscribe', 'unsubscribe https://permanently-removed.invalid/fcm/send/1', 'settle', 'subscribe']);
  });

  it('settles before retrying a subscription that came back without keys', async () => {
    const { manager, settle, log } = fakePushManager(null, ['no-keys', 'https://fcm.googleapis.com/fcm/send/fresh']);
    const payload = await obtainSubscriptionPayload(manager, OPTIONS, settle);
    assert.equal(payload.endpoint, 'https://fcm.googleapis.com/fcm/send/fresh');
    assert.deepEqual(log, ['subscribe', 'unsubscribe https://fcm.googleapis.com/fcm/send/keyless', 'settle', 'subscribe']);
  });

  it('gives up after three subscribe attempts instead of posting a dead endpoint', async () => {
    const { manager, settle, log } = fakePushManager(null, [
      'https://permanently-removed.invalid/fcm/send/1',
      'https://permanently-removed.invalid/fcm/send/2',
      'https://permanently-removed.invalid/fcm/send/3',
    ]);
    await assert.rejects(obtainSubscriptionPayload(manager, OPTIONS, settle), /usable push subscription/);
    assert.equal(log.filter((entry) => entry === 'subscribe').length, 3);
  });
});
