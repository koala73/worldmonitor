import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePushRegistrationFailure } from '../src/services/push-notifications.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pushSrc = readFileSync(join(root, 'src', 'services', 'push-notifications.ts'), 'utf-8');

// WORLDMONITOR-XR: "Error: Failed to register push subscription (400)."
// 3 events / 2 users, Chrome on macOS, thrown from the Pro-activation push
// step. `/api/notification-channels` rejects with a DIFFERENT `error` code for
// every failure mode — an unrecognised push host, a non-https endpoint, a
// missing key triple, an entitlement denial, a malformed body — but the client
// threw only the status, so the one field naming the actual cause never
// reached Sentry and the issue could not be diagnosed at all.

/** Stand-in for the fetch Response the route actually returns. */
function jsonResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

describe('push registration failure detail (WORLDMONITOR-XR)', () => {
  it('names which 400 the route returned', async () => {
    const msg = await describePushRegistrationFailure(
      jsonResponse(400, { error: 'endpoint host is not a recognised push service' }),
    );
    assert.match(msg, /\(400\)/, 'status must still be present');
    assert.match(
      msg,
      /endpoint host is not a recognised push service/,
      'the server error code is the whole point — it must survive into the thrown message',
    );
  });

  it('distinguishes the route 400s that used to collapse into one issue', async () => {
    const codes = [
      'endpoint, p256dh, auth required',
      'endpoint must be https',
      'endpoint host is not a recognised push service',
      'invalid endpoint',
      'Invalid JSON body',
      'MISSING_USER_ID',
    ];
    const messages = await Promise.all(
      codes.map((error) => describePushRegistrationFailure(jsonResponse(400, { error }))),
    );
    assert.equal(
      new Set(messages).size,
      codes.length,
      'each distinct server rejection must produce a distinct message (= a distinct Sentry group)',
    );
  });

  it('carries non-400 rejections through with their code too', async () => {
    assert.match(
      await describePushRegistrationFailure(jsonResponse(403, { error: 'pro_required' })),
      /^Failed to register push subscription \(403\): pro_required\.$/,
    );
  });

  it('falls back to the bare status when the body is not JSON', async () => {
    const html = { status: 502, text: async () => '<!DOCTYPE html><title>Bad gateway</title>' };
    assert.equal(
      await describePushRegistrationFailure(html),
      'Failed to register push subscription (502).',
      'a proxy/CDN HTML interstitial must not leak into the message',
    );
  });

  it('falls back to the bare status when the body cannot be read', async () => {
    const broken = { status: 500, text: async () => { throw new Error('stream already consumed'); } };
    assert.equal(
      await describePushRegistrationFailure(broken),
      'Failed to register push subscription (500).',
      'a failed body read must not replace the registration error with its own',
    );
  });

  it('bounds the appended code so one hostile body cannot shard Sentry groups', async () => {
    const msg = await describePushRegistrationFailure(
      jsonResponse(400, { error: 'x'.repeat(5000) }),
    );
    assert.ok(msg.length < 200, `message must stay bounded; got ${msg.length} chars`);
  });

  it('ignores a non-string error field rather than stringifying it', async () => {
    for (const error of [{ nested: true }, ['a'], 42, null]) {
      assert.equal(
        await describePushRegistrationFailure(jsonResponse(400, { error })),
        'Failed to register push subscription (400).',
      );
    }
  });

  it('keeps postSubscription on the shared describer', async () => {
    const post = pushSrc.match(/async function postSubscription\([\s\S]*?\n\}/);
    assert.ok(post, 'could not locate postSubscription()');
    assert.match(
      post[0],
      /throw new Error\(await describePushRegistrationFailure\(res\)\)/,
      'postSubscription() must throw the described failure, not a bare status',
    );
  });
});
