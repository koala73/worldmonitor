// #7084: the relay's digest-driven alert pass must skip stale replays — their
// titles already had their alert opportunity when served fresh, and the
// relay's 15-minute recency gate does not close the re-alert window for
// replays younger than that. The predicate lives in scripts/lib so it can be
// EXECUTED here; ais-relay.cjs boots the relay on import and can only ever
// get regex-on-source "coverage".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isStaleDigestReplay } = require('../scripts/lib/digest-stale-gate.cjs');

describe('relay digest stale gate (#7084)', () => {
  it('skips a server-marked stale replay', () => {
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: true, staleReason: 'build-error' } }), true);
  });

  it('runs the pass for fresh, partial, and coverage-less digests', () => {
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: false, state: 'complete' } }), false);
    assert.equal(isStaleDigestReplay({ coverage: { state: 'partial' } }), false);
    // Pre-coverage responses and malformed bodies must not block alerting —
    // the gate is strictly about an explicit stale declaration.
    assert.equal(isStaleDigestReplay({}), false);
    assert.equal(isStaleDigestReplay(null), false);
    assert.equal(isStaleDigestReplay(undefined), false);
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: 'true' } }), false);
  });

  it('is actually required by the relay at the digest alert pass', () => {
    // Wiring pin only — the behavioral coverage is above. The relay cannot be
    // imported (it boots on require), so the one thing asserted against its
    // source is that it consumes this module rather than a private copy.
    const { readFileSync } = require('node:fs');
    const src = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/lib\/digest-stale-gate\.cjs'\)/);
    assert.match(src, /isStaleDigestReplay\(digest\)/);
  });
});
