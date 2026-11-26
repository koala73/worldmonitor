import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditMisses, groupStories } from '../scripts/lib/alert-miss-audit.mjs';

const at = (hhmm) => Date.parse(`2026-11-18T${hhmm}:00Z`);
// outcome is what the relay recorded on the score-log row (#10976); null is a
// row logged before it recorded one.
const queued = (hhmm, source, title, importanceScore, { severity = 'critical', variant = 'full', outcome = { matched: 3, sent: 3 } } = {}) => ({
  ts: at(hhmm), publishedAt: at(hhmm) - 60_000, eventType: 'rss_alert', source, title, importanceScore, severity, variant,
  ...(outcome ? { outcome } : {}),
});
const belowBar = { matched: 0, noRule: { score_bar: 40 } };

// 2026-11-18 replay: the ADNOC attack was queued critical from five outlets,
// every copy under the realtime bar, and reached nobody.
const ADNOC = [
  queued('09:12', 'Gulf News', 'ADNOC vessel attacked in Strait of Hormuz, 11 crew injured and one missing', 74, { outcome: belowBar }),
  queued('09:20', 'Al Arabiya', 'ADNOC says one of its vessels was attacked in the Strait of Hormuz', 71, { outcome: belowBar }),
  queued('09:31', 'The National', 'Adnoc vessel attacked near Strait of Hormuz with 11 crew injured', 76, { outcome: belowBar }),
  queued('09:40', 'Reuters', 'ADNOC says one crew member missing after attack on its vessel in Hormuz', 79, { severity: 'high', outcome: belowBar }),
  queued('10:05', 'Arab Times', 'ADNOC vessel attacked in Hormuz; one crew member missing, 11 injured', 70, { outcome: belowBar }),
];
const MINES = [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88)];
const DELIVERED_QUAKE = [queued('12:00', 'AP News', 'Magnitude 7.4 earthquake strikes off northern Japan', 90)];

// 2026-11-22: the relay's judge matched the second wording to the first and
// skipped all 22 users who had it. The two headlines share too few words for
// the audit's story grouping, so the receipt for the first never joined it.
const DIRTY_BOMB = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say - CNN';
const REWORDED = 'Iran plots dirty bomb or chemical attack on US capital —report - SunOnline International';

describe('daily miss audit', () => {
  it('lists the ADNOC story as one critical miss stopped by the score bar', () => {
    const { missed } = auditMisses({ queued: [...ADNOC, ...MINES, ...DELIVERED_QUAKE], sent: [] });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].title, ADNOC[0].title);
    assert.equal(missed[0].edition, 'full');
    assert.deepEqual(missed[0].sources, ['Gulf News', 'Al Arabiya', 'The National', 'Reuters', 'Arab Times']);
    assert.equal(missed[0].gate, 'score_bar (best 76 < 82)');
  });

  it('keeps a different Hormuz development out of the ADNOC story', () => {
    assert.equal(groupStories([...ADNOC, ...MINES]).length, 2);
  });

  it('reports a reworded repeat as suppressed, naming the alert it repeats, not as a miss', () => {
    const result = auditMisses({
      queued: [
        queued('08:00', 'CNN', DIRTY_BOMB, 86, { outcome: { matched: 22, sent: 22 } }),
        queued('09:30', 'SunOnline International', REWORDED, 84, { outcome: { matched: 22, repeat: 22, repeatOf: { id: 'full:abc', title: DIRTY_BOMB } } }),
      ],
      sent: [{ title: DIRTY_BOMB, sentAt: at('08:01') }],
    });
    assert.deepEqual(result.missed, []);
    assert.equal(result.repeat.length, 1);
    assert.equal(result.repeat[0].title, REWORDED);
    assert.equal(result.repeat[0].edition, 'full');
    assert.equal(result.repeat[0].repeatOf.title, DIRTY_BOMB);
    assert.equal(result.repeat[0].skippedUsers, 22);
  });

  it('reports an edition whose rules have no usable channel as a config gap with its edition', () => {
    const result = auditMisses({
      queued: [queued('13:00', 'OilPrice.com', 'Drone strike halts Abqaiq crude processing', 88, { variant: 'energy', outcome: { matched: 4, noChannelListed: 3, noChannelVerified: 1 } })],
      sent: [],
    });
    assert.deepEqual(result.missed, []);
    assert.equal(result.noChannel.length, 1);
    assert.equal(result.noChannel[0].edition, 'energy');
    assert.equal(result.noChannel[0].rules, 4);
  });

  it('keeps an edition config gap when another edition delivered the story', () => {
    const title = 'Drone strike halts Abqaiq crude processing';
    const result = auditMisses({
      queued: [
        queued('13:00', 'Reuters', title, 88),
        queued('13:00', 'Reuters', title, 88, { variant: 'energy', outcome: { matched: 2, noChannelListed: 2 } }),
      ],
      sent: [],
    });
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.noChannel.map((s) => s.edition), ['energy']);
  });

  it('reports a story held back by quiet hours apart from misses', () => {
    const result = auditMisses({ queued: [queued('02:00', 'AFP', 'Earthquake topples buildings in central Chile', 89, { outcome: { matched: 2, quietHours: 2 } })], sent: [] });
    assert.deepEqual(result.missed, []);
    assert.equal(result.quietHours[0].users, 2);
  });

  it('still reports a real miss, naming the gates the relay recorded and the edition', () => {
    const { missed } = auditMisses({
      queued: [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { variant: 'finance', outcome: { matched: 0, noRule: { edition: 30, score_bar: 2 } } })],
      sent: [],
    });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].edition, 'finance');
    assert.equal(missed[0].gate, 'no rule matched (edition=30, score_bar=2)');
  });

  it('names failed sends and duplicates on a miss whose rules matched', () => {
    const { missed } = auditMisses({
      queued: [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { outcome: { matched: 3, sendFailed: 2, dedup: 1 } })],
      sent: [],
    });
    assert.equal(missed[0].gate, 'dedup=1, sendFailed=2');
  });

  // One rule in a benign bucket must not hide rules that should have delivered.
  it('reports failed sends as a miss even when other rules had no channel, and keeps the config gap', () => {
    const result = auditMisses({ queued: [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { outcome: { matched: 25, noChannelListed: 3, sendFailed: 22 } })], sent: [] });
    assert.equal(result.missed.length, 1);
    assert.equal(result.missed[0].gate, 'sendFailed=22');
    assert.equal(result.noChannel.length, 1);
    assert.equal(result.noChannel[0].rules, 3);
  });

  it('reports failed sends as a miss even when one user had the story already', () => {
    const result = auditMisses({ queued: [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { outcome: { matched: 22, repeat: 1, sendFailed: 21 } })], sent: [] });
    assert.equal(result.missed.length, 1);
    assert.equal(result.missed[0].gate, 'sendFailed=21');
    assert.deepEqual(result.repeat, []);
  });

  it('reports a miss when one copy had no channel and the others failed to send', () => {
    const result = auditMisses({
      queued: [
        queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { outcome: { matched: 5, sendFailed: 5 } }),
        queued('11:04', 'Reuters', 'Two tankers hit mines in Strait of Hormuz', 86, { outcome: { matched: 1, noChannelListed: 1 } }),
      ],
      sent: [],
    });
    assert.equal(result.missed.length, 1);
    assert.equal(result.missed[0].gate, 'sendFailed=5');
    assert.deepEqual(result.noChannel.map((s) => s.rules), [1]);
  });

  it('shows every rule count on a non-miss line, so nothing is absorbed silently', () => {
    const { repeat } = auditMisses({
      queued: [queued('09:30', 'SunOnline International', REWORDED, 84, { outcome: { matched: 30, repeat: 22, dedup: 2, freeSeverity: 6, repeatOf: { id: 'full:abc', title: DIRTY_BOMB } } })],
      sent: [],
    });
    assert.equal(repeat[0].counts, 'matched=30, freeSeverity=6, repeat=22, dedup=2');
  });

  it('counts rows logged before the relay recorded outcomes instead of calling them misses', () => {
    const result = auditMisses({ queued: [queued('11:00', 'Lloyd\'s List', 'Two tankers hit mines in the Strait of Hormuz', 88, { outcome: null })], sent: [] });
    assert.deepEqual(result.missed, []);
    assert.equal(result.notRecorded.length, 1);
  });

  it('counts stories delivered before the first wire copy', () => {
    const result = auditMisses({
      queued: [...ADNOC, ...DELIVERED_QUAKE],
      sent: [{ title: 'Magnitude 7.4 earthquake strikes off northern Japan', sentAt: at('11:58') }],
    });
    assert.equal(result.wireStories, 2);
    assert.equal(result.deliveredBeforeWire, 1);
  });

  it('counts a wire copy that arrives through a topic feed', () => {
    const viaTopicFeed = [
      queued('08:55', 'Tanker & Shipping', 'UAE\'s ADNOC L&S says one crew member missing after attack on its vessel in Hormuz - Reuters', 59, { severity: 'high' }),
      queued('09:00', 'Shipping & Freight', 'Gas tanker in Strait of Hormuz set ablaze - BBC News', 72),
    ];
    const result = auditMisses({
      queued: viaTopicFeed,
      sent: [
        { title: 'ADNOC L&S says one crew member missing after attack on its vessel in Hormuz', sentAt: at('09:30') },
        { title: 'Gas tanker in Strait of Hormuz set ablaze', sentAt: at('09:30') },
      ],
    });
    assert.equal(result.wireStories, 2);
    assert.equal(result.deliveredBeforeWire, 0);
  });

  it('joins two groups that a later headline links into one story', () => {
    const rows = [
      { title: 'Crimean Bridge span collapses after strike' },
      { title: 'Kerch Strait traffic halted after strike' },
      { title: 'Crimean Bridge span collapses, Kerch Strait traffic halted after strike' },
    ];
    assert.equal(groupStories(rows).length, 1);
  });
});
