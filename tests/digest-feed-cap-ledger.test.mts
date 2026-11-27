import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

describe('coverage ledger per-feed cap drops (#10976)', () => {
  it('keeps the 20 feeds that lost the most items, largest first', () => {
    const drops = new Map(Array.from({ length: 25 }, (_, i) => [`Feed ${i}`, i + 1] as [string, number]));
    const top = __testing__.topFeedCapDrops(drops);
    assert.equal(Object.keys(top).length, 20);
    assert.deepEqual(Object.entries(top).slice(0, 2), [['Feed 24', 25], ['Feed 23', 24]]);
    assert.equal(top['Feed 4'], undefined);
  });
});
