/**
 * Regression test: scripts/notification-relay.cjs must write to the shadow
 * log exactly ONCE per rss_alert event. Before the fix, processEvent() called
 * shadowLogScore() twice, producing ~50% near-duplicate pairs in
 * shadow:score-log:v1 (docs/internal/scoringDiagnostic.md §4).
 *
 * The relay runs with live Convex + Upstash connections, so we test the
 * contract by static analysis of the source rather than integration.
 *
 * Run: node --test tests/notification-relay-shadow-log.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

function extractProcessEvent(src) {
  const idx = src.indexOf('async function processEvent(');
  assert.ok(idx !== -1, 'processEvent not found in notification-relay.cjs');
  const openIdx = src.indexOf('{', idx);
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(idx, i);
}

describe('notification-relay shadowLogScore discipline', () => {
  const processEvent = extractProcessEvent(relaySrc);

  it('calls shadowLogScore exactly once inside processEvent', () => {
    const calls = processEvent.match(/shadowLogScore\s*\(/g) || [];
    assert.equal(
      calls.length, 1,
      `processEvent must call shadowLogScore exactly once; found ${calls.length}`,
    );
  });

  it('calls shadowLogScore before the score gate, not after', () => {
    const shadowIdx = processEvent.indexOf('shadowLogScore');
    const gateIdx = processEvent.indexOf('IMPORTANCE_SCORE_LIVE');
    assert.ok(shadowIdx !== -1, 'shadowLogScore call not found');
    assert.ok(gateIdx !== -1, 'IMPORTANCE_SCORE_LIVE gate not found');
    assert.ok(
      shadowIdx < gateIdx,
      'shadowLogScore must fire before the live score gate so we measure what would have been dropped',
    );
  });
});

describe('shadow-log key version', () => {
  it('uses the v3 JSON-member key (weight rebalance clean dataset)', () => {
    assert.match(
      relaySrc,
      /SHADOW_SCORE_LOG_KEY\s*=\s*['"]shadow:score-log:v3['"]/,
      'notification-relay must write to shadow:score-log:v3 after the weight rebalance',
    );
    assert.ok(
      !/SHADOW_SCORE_LOG_KEY\s*=\s*['"]shadow:score-log:v[12]['"]/.test(relaySrc),
      'legacy v1/v2 keys must not be active',
    );
  });

  it('shadowLogScore encodes a JSON record with severity + corroboration', () => {
    const fnStart = relaySrc.indexOf('async function shadowLogScore');
    assert.ok(fnStart !== -1, 'shadowLogScore not found');
    const fnEnd = relaySrc.indexOf('\nasync function ', fnStart + 1);
    const fn = relaySrc.slice(fnStart, fnEnd === -1 ? fnStart + 2000 : fnEnd);
    assert.match(fn, /JSON\.stringify/, 'member must be JSON-encoded');
    assert.match(fn, /severity:/, 'record must include severity');
    assert.match(fn, /corroborationCount:/, 'record must include corroborationCount');
    assert.match(fn, /variant:/, 'record must include variant');
    assert.match(fn, /source:/, 'record must include source');
  });
});
