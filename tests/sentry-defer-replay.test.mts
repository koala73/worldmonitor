import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _buildQueuedErrorEventForTests,
  _buildQueuedUnhandledRejectionEventForTests,
} from '../src/bootstrap/sentry-defer';

describe('deferred Sentry replay event shaping', () => {
  it('matches Sentry globalHandlers for primitive promise rejections', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests('timeout');
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'UnhandledRejection');
    assert.equal(value?.value, 'Non-Error promise rejection captured with value: timeout');
  });

  it('matches Sentry globalHandlers for object promise rejections', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests({ beta: 2, alpha: 1 });
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'UnhandledRejection');
    assert.equal(value?.value, 'Object captured as promise rejection with keys: alpha, beta');
    assert.deepEqual(event?.extra?.__serialized__, { beta: 2, alpha: 1 });
  });

  it('matches Sentry globalHandlers for Event promise rejections', () => {
    const reason = new Event('CustomEvent');
    const event = _buildQueuedUnhandledRejectionEventForTests(reason);
    const value = event?.exception?.values?.[0];

    assert.equal(event?.level, 'error');
    assert.equal(value?.type, 'Event');
    assert.equal(value?.value, 'Event `Event` (type=CustomEvent) captured as promise rejection');
    assert.deepEqual(event?.extra?.__serialized__, { type: 'CustomEvent' });
  });

  it('leaves Error promise rejections on the captureException path', () => {
    const event = _buildQueuedUnhandledRejectionEventForTests(new Error('boom'));
    assert.equal(event, null);
  });

  it('preserves original ErrorEvent location for missing-error fallbacks', () => {
    const event = _buildQueuedErrorEventForTests({
      message: 'Script error.',
      filename: 'https://cdn.example.com/widget.js',
      lineno: 12,
      colno: 34,
      error: null,
    });
    const value = event.exception?.values?.[0];
    const frame = value?.stacktrace?.frames?.[0];

    assert.equal(event.level, 'error');
    assert.equal(event.message, 'Script error.');
    assert.equal(value?.type, 'Error');
    assert.equal(value?.value, 'Script error.');
    assert.equal(frame?.filename, 'https://cdn.example.com/widget.js');
    assert.equal(frame?.lineno, 12);
    assert.equal(frame?.colno, 34);
    assert.equal(frame?.function, '?');
    assert.equal(frame?.in_app, true);
  });
});
