import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeObservedFirstSeen } from '../scripts/seed-cyber-threats.mjs';

// Issue #4008: WorldMonitor-observed first-seen merge. The cyber feed's bulk
// sources (AbuseIPDB blacklist, C2Intel plaintext) carry no upstream first-seen,
// so firstSeenAt was 0 for ~80% of records. mergeObservedFirstSeen stamps a
// stable per-indicator discovery timestamp across runs.

const NOW = 1_780_000_000_000;
const DAY = 86_400_000;

describe('mergeObservedFirstSeen (#4008)', () => {
  it('stamps nowMs for a brand-new indicator with no upstream date', () => {
    const threats = [{ indicatorType: 'ip', indicator: '1.2.3.4', firstSeen: 0 }];
    const { threats: out, nextMap } = mergeObservedFirstSeen(threats, {}, NOW);
    assert.equal(out[0].firstSeen, NOW, 'new upstream-less indicator is stamped now');
    assert.equal(nextMap['ip:1.2.3.4'], NOW, 'persisted for next run');
  });

  it('carries forward a stored observation instead of re-stamping now', () => {
    const earlier = NOW - 5 * DAY;
    const threats = [{ indicatorType: 'ip', indicator: '1.2.3.4', firstSeen: 0 }];
    const { threats: out, nextMap } = mergeObservedFirstSeen(threats, { 'ip:1.2.3.4': earlier }, NOW);
    assert.equal(out[0].firstSeen, earlier, 'prior sighting is preserved, not reset');
    assert.equal(nextMap['ip:1.2.3.4'], earlier);
  });

  it('prefers a real upstream discovery date over a later stored sighting', () => {
    const upstream = NOW - 10 * DAY;
    const stored = NOW - 3 * DAY;
    const threats = [{ indicatorType: 'ip', indicator: '1.2.3.4', firstSeen: upstream }];
    const { threats: out } = mergeObservedFirstSeen(threats, { 'ip:1.2.3.4': stored }, NOW);
    assert.equal(out[0].firstSeen, upstream, 'earliest known (upstream) wins');
  });

  it('keeps the earlier value when both upstream and stored exist', () => {
    const upstream = NOW - 2 * DAY;   // upstream is LATER than stored here
    const stored = NOW - 9 * DAY;
    const threats = [{ indicatorType: 'ip', indicator: '1.2.3.4', firstSeen: upstream }];
    const { threats: out } = mergeObservedFirstSeen(threats, { 'ip:1.2.3.4': stored }, NOW);
    assert.equal(out[0].firstSeen, stored, 'min(upstream, stored) — never moves first-seen later');
  });

  it('self-prunes: nextMap contains only indicators present this run', () => {
    const threats = [{ indicatorType: 'ip', indicator: 'a', firstSeen: 0 }];
    const prior = { 'ip:a': NOW - DAY, 'ip:gone': NOW - 30 * DAY };
    const { nextMap } = mergeObservedFirstSeen(threats, prior, NOW);
    assert.deepEqual(Object.keys(nextMap), ['ip:a'], 'absent indicators are dropped, bounding map size');
  });

  it('unifies first-seen across sources for the same indicator (dated row first)', () => {
    const threats = [
      { indicatorType: 'ip', indicator: '9.9.9.9', firstSeen: NOW - 2 * DAY }, // urlhaus
      { indicatorType: 'ip', indicator: '9.9.9.9', firstSeen: 0 },             // abuseipdb (no date)
    ];
    const { threats: out, nextMap } = mergeObservedFirstSeen(threats, {}, NOW);
    assert.equal(nextMap['ip:9.9.9.9'], NOW - 2 * DAY, 'shared indicator keeps the earliest observation');
    assert.equal(out[0].firstSeen, NOW - 2 * DAY);
    assert.equal(out[1].firstSeen, NOW - 2 * DAY, 'both occurrences share one first-seen, even on first run');
  });

  it('unifies first-seen across sources regardless of row order (dated row second)', () => {
    // Regression for the single-pass order bug: the dated row appears AFTER the
    // undated one, so a one-pass merge would finalize out[0] to nowMs first.
    const threats = [
      { indicatorType: 'ip', indicator: '9.9.9.9', firstSeen: 0 },             // abuseipdb (no date)
      { indicatorType: 'ip', indicator: '9.9.9.9', firstSeen: NOW - 2 * DAY }, // urlhaus
    ];
    const { threats: out, nextMap } = mergeObservedFirstSeen(threats, {}, NOW);
    assert.equal(nextMap['ip:9.9.9.9'], NOW - 2 * DAY);
    assert.equal(out[0].firstSeen, NOW - 2 * DAY, 'undated row adopts the dated sibling, not nowMs');
    assert.equal(out[1].firstSeen, NOW - 2 * DAY);
  });

  it('treats invalid/zero prior entries as missing', () => {
    const threats = [{ indicatorType: 'ip', indicator: '1.2.3.4', firstSeen: 0 }];
    const { threats: out } = mergeObservedFirstSeen(threats, { 'ip:1.2.3.4': 0 }, NOW);
    assert.equal(out[0].firstSeen, NOW, 'a stored 0 is not a valid prior sighting');
  });
});
