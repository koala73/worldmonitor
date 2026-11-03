import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { deliverShippingV2Webhook } from '../server/worldmonitor/shipping/v2/deliver-webhook.ts';

const record = {
  subscriberId: 'synthetic', callbackUrl: 'https://callback.example/hook?test=1',
  secret: 'synthetic-secret', active: true, ownerTag: 'test',
  chokepointIds: ['suez'], alertThreshold: 50, createdAt: '2026-09-11T00:00:00Z',
};
const payload = {
  subscriberId: 'synthetic', chokepointId: 'suez', score: 60, alertThreshold: 50,
  triggeredAt: '2026-09-11T00:00:00Z', reason: 'synthetic',
};

function fixture(t: TestContext, statusCode = 200, address = '93.184.216.34', respond = true) {
  const response = Object.assign(new PassThrough(), { statusCode, statusMessage: 'test', headers: {} });
  const request = Object.assign(new EventEmitter(), {
    destroyed: false,
    setTimeout: () => request,
    write: () => true,
    end: () => {},
    destroy(error?: Error) {
      request.destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    },
  });
  let options!: https.RequestOptions;
  t.mock.method(https, 'request', (opts: https.RequestOptions, callback: (res: unknown) => void) => {
    options = opts;
    if (respond) queueMicrotask(() => callback(response));
    return request;
  });
  const promise = deliverShippingV2Webhook(record, payload, {
    deliveryId: 'synthetic-delivery', resolveHostname: async () => [address],
  });
  return { response, request, promise, get options() { return options; } };
}

test('rejects and stops a response larger than 1 MiB', async (t) => {
  const f = fixture(t);
  const outcome = f.promise.then(() => null, error => error);
  await setImmediate();
  f.response.write(Buffer.alloc(1024 * 1024));
  f.response.end(Buffer.from('x'));
  const error = await outcome;
  assert.match(String(error), /response too large/);
  assert.equal(f.request.destroyed, true);
  assert.equal(f.response.destroyed, true);
});

test('hard deadline rejects an active trickle without a socket timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let outcome: unknown = 'pending';
  const done = f.promise.then(value => { outcome = value; }, error => { outcome = error; });
  await setImmediate();
  for (let i = 0; i < 10; i++) {
    f.response.write(Buffer.from('x'));
    t.mock.timers.tick(1000);
    await setImmediate();
  }
  const atDeadline = outcome;
  // Finish the pre-fix request too, so a failed reproduction leaves no promise open.
  f.response.end();
  await done;
  assert.match(String(atDeadline), /timed out/);
  assert.equal(f.request.destroyed, true);
  assert.equal(f.response.destroyed, true);
});

for (const status of [200, 204, 302, 304, 500]) {
  test(`returns status ${status} without retaining a response body`, async (t) => {
    const f = fixture(t, status);
    await setImmediate();
    f.response.end();
    assert.deepEqual(await f.promise, { status, ok: status >= 200 && status < 300, resolvedAddresses: ['93.184.216.34'] });
  });
}

for (const address of ['93.184.216.34', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
  test(`keeps the validated pin and TLS hostname for ${address}`, async (t) => {
    const f = fixture(t, 200, address);
    await setImmediate();
    assert.equal(f.options.hostname, 'callback.example');
    assert.equal(f.options.path, '/hook?test=1');
    assert.equal(f.options.rejectUnauthorized, undefined);
    assert.equal(f.options.checkServerIdentity, undefined);
    const lookup = f.options.lookup as (hostname: string, options: object, callback: (error: unknown, address: string, family: number) => void) => void;
    lookup('callback.example', {}, (error: unknown, pinned: string, family: number) => {
      assert.equal(error, null);
      assert.equal(pinned, address);
      assert.equal(family, address.includes(':') ? 6 : 4);
    });
    f.response.end();
    await f.promise;
  });
}

test('bounds time before response headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, 200, '93.184.216.34', false);
  let outcome: unknown = 'pending';
  const done = f.promise.then(value => { outcome = value; }, error => { outcome = error; });
  await setImmediate();
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.match(String(outcome), /timed out/);
  assert.equal(f.request.destroyed, true);
  await done;
});

test('allows exactly 1 MiB and clears the deadline after success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await setImmediate();
  f.response.end(Buffer.alloc(1024 * 1024));
  assert.equal((await f.promise).ok, true);
  t.mock.timers.tick(10_000);
  assert.equal(f.request.destroyed, false);
});

test('rejects an aborted response and stops the request', async (t) => {
  const f = fixture(t);
  const outcome = f.promise.then(() => null, error => error);
  await setImmediate();
  f.response.emit('aborted');
  assert.match(String(await outcome), /aborted/);
  assert.equal(f.request.destroyed, true);
  assert.equal(f.response.destroyed, true);
});
