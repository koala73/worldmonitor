import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Guards the capacity relation between the two analytics queues.
 *
 * `src/services/analytics.ts` buffers tracker calls made before the Umami
 * script loads (`UMAMI_QUEUE_LIMIT`) and `flushPendingUmamiCalls` hands the
 * whole buffer to the collector transport in ONE synchronous loop. The
 * transport's queue (`COLLECTOR_QUEUE_LIMIT`) drains one write at a time, so
 * anything the burst does not fit is dropped as `queue-overflow` before it
 * reaches the network. A downstream queue shallower than the upstream buffer
 * therefore loses events by construction — the WORLDMONITOR-Y3 defect, where
 * 25 sat behind 50.
 *
 * Both modules import TS path aliases, so they cannot be imported from a
 * `node:test` file (see tests/sentry-beforesend.test.mjs for the same
 * constraint). The constants are read out of the source instead, and an
 * explicit match assertion keeps a rename from silently passing this test.
 */
function readNumericConstant(relativePath, name) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const match = source.match(new RegExp(`^(?:export )?const ${name} = (\\d[\\d_]*);$`, 'm'));
  assert.ok(
    match,
    `${name} must be declared as a plain numeric const in ${relativePath} — ` +
      'if it was renamed or made computed, update this guard rather than deleting it.',
  );
  return Number(match[1].replace(/_/g, ''));
}

describe('analytics queue capacity', () => {
  it('gives the collector queue at least the deferred buffer\'s capacity', () => {
    const deferredBuffer = readNumericConstant(
      '../src/services/analytics.ts',
      'UMAMI_QUEUE_LIMIT',
    );
    const collectorQueue = readNumericConstant(
      '../src/services/analytics-collector-transport.ts',
      'COLLECTOR_QUEUE_LIMIT',
    );

    assert.ok(
      collectorQueue >= deferredBuffer,
      `COLLECTOR_QUEUE_LIMIT (${collectorQueue}) must be >= UMAMI_QUEUE_LIMIT ` +
        `(${deferredBuffer}): flushPendingUmamiCalls dispatches the entire deferred ` +
        `buffer synchronously, so a shallower collector queue drops ` +
        `${deferredBuffer - collectorQueue} events per full flush as queue-overflow.`,
    );
  });

  it('reads real values, so the relation cannot pass on two zeroes', () => {
    const deferredBuffer = readNumericConstant(
      '../src/services/analytics.ts',
      'UMAMI_QUEUE_LIMIT',
    );
    assert.ok(deferredBuffer > 0, 'UMAMI_QUEUE_LIMIT must be a positive bound');
  });
});
