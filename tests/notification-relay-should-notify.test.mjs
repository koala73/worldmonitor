/**
 * Runtime tests for shouldNotify in scripts/notification-relay.cjs.
 *
 * shouldNotify coerces (effective realtime + sensitivity 'all' or 'high') to
 * 'critical' before BOTH the legacy severity match and the importance-score
 * threshold lookup. Realtime is reserved for critical-tier events; the Convex
 * validators forbid the other combinations for new writes, so this is defence
 * in depth for in-flight rows and tooling that bypasses the validators.
 * See docs/archive/plans/forbid-realtime-all-events.md §3.
 *
 * The relay only starts its poll loop when require.main === module, so
 * requiring it here is side-effect free once the env guard is satisfied.
 *
 * Run: node --import tsx --test tests/notification-relay-should-notify.test.mjs
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WATCHLIST_STORY_SCORE_MIN } from '../scripts/lib/watchlist-story-events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
// The 'all' floor is read once at module load; pin it to the default.
delete process.env.IMPORTANCE_SCORE_MIN;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { shouldNotify } = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));

const scored = (severity, importanceScore) => ({ severity, payload: { importanceScore } });

function withScoreLive(fn) {
  const prev = process.env.IMPORTANCE_SCORE_LIVE;
  process.env.IMPORTANCE_SCORE_LIVE = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.IMPORTANCE_SCORE_LIVE;
    else process.env.IMPORTANCE_SCORE_LIVE = prev;
  }
}

describe('shouldNotify — legacy severity match uses the coerced sensitivity', () => {
  afterEach(() => { delete process.env.IMPORTANCE_SCORE_LIVE; });

  it('realtime + all is treated as critical', () => {
    const rule = { digestMode: 'realtime', sensitivity: 'all' };
    assert.equal(shouldNotify(rule, { severity: 'high' }), false);
    assert.equal(shouldNotify(rule, { severity: 'critical' }), true);
  });

  it('realtime + high is treated as critical', () => {
    const rule = { digestMode: 'realtime', sensitivity: 'high' };
    assert.equal(shouldNotify(rule, { severity: 'high' }), false);
    assert.equal(shouldNotify(rule, { severity: 'critical' }), true);
  });

  it('a missing digestMode defaults to realtime and is coerced too', () => {
    assert.equal(shouldNotify({ sensitivity: 'all' }, { severity: 'high' }), false);
    assert.equal(shouldNotify({ sensitivity: 'high' }, { severity: 'high' }), false);
  });

  it('digest modes keep the rule sensitivity', () => {
    assert.equal(shouldNotify({ digestMode: 'daily', sensitivity: 'all' }, { severity: 'low' }), true);
    assert.equal(shouldNotify({ digestMode: 'daily', sensitivity: 'high' }, { severity: 'high' }), true);
    assert.equal(shouldNotify({ digestMode: 'daily', sensitivity: 'high' }, { severity: 'medium' }), false);
  });
});

describe('shouldNotify — importance threshold uses the coerced sensitivity', () => {
  it('realtime + all needs the critical threshold (82), not the all floor', () => {
    withScoreLive(() => {
      const rule = { digestMode: 'realtime', sensitivity: 'all' };
      assert.equal(shouldNotify(rule, scored('critical', 81)), false);
      assert.equal(shouldNotify(rule, scored('critical', 82)), true);
    });
  });

  it('realtime + high needs the critical threshold (82), not the high threshold', () => {
    withScoreLive(() => {
      const rule = { digestMode: 'realtime', sensitivity: 'high' };
      assert.equal(shouldNotify(rule, scored('critical', 75)), false);
      assert.equal(shouldNotify(rule, scored('critical', 82)), true);
    });
  });

  it('digest-mode thresholds: high = 69, all = IMPORTANCE_SCORE_MIN default 40', () => {
    withScoreLive(() => {
      const high = { digestMode: 'daily', sensitivity: 'high' };
      assert.equal(shouldNotify(high, scored('high', 68)), false);
      assert.equal(shouldNotify(high, scored('high', 69)), true);
      const all = { digestMode: 'daily', sensitivity: 'all' };
      assert.equal(shouldNotify(all, scored('low', 39)), false);
      assert.equal(shouldNotify(all, scored('low', 40)), true);
    });
  });

  it("the watchlist story default score floor matches the relay's 'high' threshold", () => {
    withScoreLive(() => {
      const high = { digestMode: 'daily', sensitivity: 'high' };
      const floor = DEFAULT_WATCHLIST_STORY_SCORE_MIN;
      assert.equal(shouldNotify(high, scored('high', floor)), true);
      assert.equal(shouldNotify(high, scored('high', floor - 1)), false);
    });
  });

  it('the threshold is skipped when IMPORTANCE_SCORE_LIVE is off', () => {
    delete process.env.IMPORTANCE_SCORE_LIVE;
    const rule = { digestMode: 'realtime', sensitivity: 'all' };
    assert.equal(shouldNotify(rule, scored('critical', 10)), true);
  });
});
