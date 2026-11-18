import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditMisses, groupStories } from '../scripts/lib/alert-miss-audit.mjs';

const at = (hhmm) => Date.parse(`2026-11-18T${hhmm}:00Z`);
const queued = (hhmm, source, title, importanceScore, severity = 'critical') => ({
  ts: at(hhmm), publishedAt: at(hhmm) - 60_000, eventType: 'rss_alert', source, title, importanceScore, severity, variant: 'full',
});

// 2026-11-18 replay: the ADNOC attack was queued critical from five outlets,
// every copy under the realtime bar, and reached nobody.
const ADNOC = [
  queued('09:12', 'Gulf News', 'ADNOC vessel attacked in Strait of Hormuz, 11 crew injured and one missing', 74),
  queued('09:20', 'Al Arabiya', 'ADNOC says one of its vessels was attacked in the Strait of Hormuz', 71),
  queued('09:31', 'The National', 'Adnoc vessel attacked near Strait of Hormuz with 11 crew injured', 76),
  queued('09:40', 'Reuters', 'ADNOC says one crew member missing after attack on its vessel in Hormuz', 79, 'high'),
  queued('10:05', 'Arab Times', 'ADNOC vessel attacked in Hormuz; one crew member missing, 11 injured', 70),
];
const MINES = [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88)];
const DELIVERED_QUAKE = [queued('12:00', 'AP News', 'Magnitude 7.4 earthquake strikes off northern Japan', 90)];

describe('daily miss audit', () => {
  it('lists the ADNOC story as one critical miss stopped by the score bar', () => {
    const { missed } = auditMisses({
      queued: [...ADNOC, ...MINES, ...DELIVERED_QUAKE],
      sent: [
        { title: 'Two tankers hit mines in Strait of Hormuz', sentAt: at('11:01') },
        { title: 'Magnitude 7.4 earthquake strikes off northern Japan', sentAt: at('11:58') },
      ],
    });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].title, ADNOC[0].title);
    assert.deepEqual(missed[0].sources, ['Gulf News', 'Al Arabiya', 'The National', 'Reuters', 'Arab Times']);
    assert.equal(missed[0].gate, 'score_bar (best 76 < 82)');
  });

  it('keeps a different Hormuz development out of the ADNOC story', () => {
    assert.equal(groupStories([...ADNOC, ...MINES]).length, 2);
  });

  it('names rule matching when a critical copy cleared the bar', () => {
    const { missed } = auditMisses({ queued: MINES, sent: [] });
    assert.match(missed[0].gate, /^rule_match/);
  });

  it('counts stories delivered before the first wire copy', () => {
    const result = auditMisses({
      queued: [...ADNOC, ...DELIVERED_QUAKE],
      sent: [{ title: 'Magnitude 7.4 earthquake strikes off northern Japan', sentAt: at('11:58') }],
    });
    assert.equal(result.wireStories, 2);
    assert.equal(result.deliveredBeforeWire, 1);
  });
});
