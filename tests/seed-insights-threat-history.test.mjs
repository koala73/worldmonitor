import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { clusterItems } from '../scripts/_clustering.mjs';
import * as seedInsights from '../scripts/seed-insights.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T15:00:00Z');

function cluster(titles, { level, pubDate = NOW } = {}) {
  return {
    primaryTitle: titles[0],
    memberTitles: titles,
    pubDate,
    ...(level ? { threat: { level } } : {}),
  };
}

function dayTotals(state, nowMs = NOW) {
  return seedInsights.projectThreatTimeline(state, { nowMs }).days
    .map(day => Object.values(day.counts).reduce((sum, n) => sum + n, 0));
}

function roundTrip(state) {
  return JSON.parse(JSON.stringify(state));
}

describe('seed-insights threat history', () => {
  it('places a new story on the UTC day of its earliest member headline', () => {
    const pubMsByTitle = new Map([
      ['Strike hits depot', NOW - 3 * DAY_MS],
      ['Depot strike: officials respond', NOW - DAY_MS],
    ]);
    const state = seedInsights.mergeThreatHistory(null, [
      cluster(['Depot strike: officials respond', 'Strike hits depot'], { level: 'high' }),
    ], { nowMs: NOW, pubMsByTitle });

    assert.deepEqual(Object.keys(state.days), ['2026-11-12']);
    assert.equal(state.days['2026-11-12'][0].l, 'high');
    assert.equal(state.recordingSince, '2026-11-15');
  });

  it('counts a story once across runs, even as it gains headlines and escalates', () => {
    const first = seedInsights.mergeThreatHistory(null, [
      cluster(['Ceasefire talks resume'], { level: 'medium' }),
    ], { nowMs: NOW });
    const second = seedInsights.mergeThreatHistory(roundTrip(first), [
      // Punctuation and case do not split the story; the new headline joins it.
      cluster(['CEASEFIRE TALKS RESUME!', 'Ceasefire talks collapse overnight'], { level: 'critical' }),
    ], { nowMs: NOW + 30 * 60_000 });
    const third = seedInsights.mergeThreatHistory(roundTrip(second), [
      cluster(['Ceasefire talks collapse overnight'], { level: 'low' }),
    ], { nowMs: NOW + DAY_MS });

    const stories = Object.values(third.days).flat();
    assert.equal(stories.length, 1);
    assert.equal(stories[0].l, 'critical', 'the highest level seen sticks');
    assert.equal(stories[0].k.length, 2);
    assert.equal(third.recordingSince, '2026-11-15', 'recording start survives later runs');
  });

  it('merges stored stories that a later cluster joins, keeping the earliest day and highest level', () => {
    const pubMsByTitle = new Map([
      ['Dam breach floods valley', NOW - 3 * DAY_MS],
      ['Valley evacuated after dam failure', NOW - DAY_MS],
    ]);
    const first = seedInsights.mergeThreatHistory(null, [
      cluster(['Dam breach floods valley'], { level: 'high' }),
      cluster(['Valley evacuated after dam failure'], { level: 'critical' }),
    ], { nowMs: NOW, pubMsByTitle });
    assert.equal(Object.values(first.days).flat().length, 2, 'precondition: stored as two stories');

    const joined = seedInsights.mergeThreatHistory(roundTrip(first), [
      cluster(['Valley evacuated after dam failure', 'Dam breach floods valley'], { level: 'medium' }),
    ], { nowMs: NOW + 30 * 60_000, pubMsByTitle });

    const stories = Object.values(joined.days).flat();
    assert.equal(stories.length, 1, 'the joined story counts once');
    assert.deepEqual(Object.keys(joined.days).filter(date => joined.days[date].length > 0), ['2026-11-12']);
    assert.equal(stories[0].l, 'critical');
    assert.equal(stories[0].k.length, 2);

    // Both headlines now resolve to the merged story.
    const again = seedInsights.mergeThreatHistory(roundTrip(joined), [
      cluster(['Dam breach floods valley'], { level: 'low' }),
      cluster(['Valley evacuated after dam failure'], { level: 'low' }),
    ], { nowMs: NOW + DAY_MS, pubMsByTitle });
    assert.equal(Object.values(again.days).flat().length, 1);
  });

  it('marks days an outage left unrecoverable as partial', () => {
    const before = seedInsights.mergeThreatHistory(null, [cluster(['Opening story'], { level: 'high' })], { nowMs: NOW - 5 * DAY_MS });
    // The seeder was down five days; the digest only reaches back two.
    const after = seedInsights.mergeThreatHistory(roundTrip(before), [cluster(['Return story'], { level: 'high' })], {
      nowMs: NOW,
      coverageStartMs: NOW - 2 * DAY_MS,
    });
    assert.deepEqual(after.partialDays, ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    assert.deepEqual(seedInsights.projectThreatTimeline(after, { nowMs: NOW }).partialDays, after.partialDays);

    // A short gap the digest covers adds nothing.
    const next = seedInsights.mergeThreatHistory(roundTrip(after), [], { nowMs: NOW + 60 * 60_000, coverageStartMs: NOW - 2 * DAY_MS });
    assert.deepEqual(next.partialDays, after.partialDays);

    // Partial days leave with the window.
    const later = seedInsights.mergeThreatHistory(roundTrip(next), [], { nowMs: NOW + 5 * DAY_MS, coverageStartMs: NOW });
    assert.deepEqual(later.partialDays, []);
  });

  it('takes the coverage bound from the capped categories only', () => {
    const cap = seedInsights.DIGEST_CATEGORY_CAP;
    const full = (oldestMs) => Array.from({ length: cap }, (_, i) => ({ publishedAt: i === 0 ? oldestMs : NOW }));
    const digest = {
      categories: {
        // Uncapped: complete back to the freshness floor, whatever its oldest item.
        sparse: { items: [{ publishedAt: NOW - 2 * 60 * 60_000 }] },
        quietCapped: { items: full(NOW - 4 * DAY_MS) },
        busyCapped: { items: full(NOW - DAY_MS) },
        empty: { items: [] },
      },
    };
    assert.equal(seedInsights.digestCoverageStartMs(digest), NOW - DAY_MS);
    assert.equal(seedInsights.digestCoverageStartMs({ categories: { sparse: digest.categories.sparse } }), NOW - 2 * 60 * 60_000,
      'with no capped category, the oldest item bounds the digest');
    assert.equal(seedInsights.digestCoverageStartMs([{ pubDate: NOW - 3 * DAY_MS }, { pubDate: NOW }]), NOW - 3 * DAY_MS);
    assert.equal(seedInsights.digestCoverageStartMs({}), null);
  });

  it('pins the category cap to the digest producer', () => {
    const producer = readFileSync(new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url), 'utf8');
    const match = producer.match(/const MAX_ITEMS_PER_CATEGORY = (\d+);/);
    assert.ok(match, 'producer constant not found');
    assert.equal(seedInsights.DIGEST_CATEGORY_CAP, Number(match[1]));
  });

  it('marks the first recording day partial when the digest does not reach its midnight', () => {
    const late = seedInsights.mergeThreatHistory(null, [cluster(['First story'], { level: 'high' })], {
      nowMs: NOW,
      coverageStartMs: Date.parse('2026-11-15T12:00:00Z'),
    });
    assert.deepEqual(late.partialDays, ['2026-11-15']);

    const covered = seedInsights.mergeThreatHistory(null, [cluster(['First story'], { level: 'high' })], {
      nowMs: NOW,
      coverageStartMs: NOW - DAY_MS,
    });
    assert.deepEqual(covered.partialDays, []);
  });

  it('keeps earlier days across runs and drops days that leave the window', () => {
    let state = null;
    for (let day = 0; day < 9; day++) {
      const nowMs = NOW + day * DAY_MS;
      state = seedInsights.mergeThreatHistory(state && roundTrip(state), [
        cluster([`Distinct event number ${day}`], { level: 'high', pubDate: nowMs }),
      ], { nowMs });
    }
    const lastNow = NOW + 8 * DAY_MS;
    assert.equal(Object.keys(state.days).length, 7);
    assert.deepEqual(dayTotals(state, lastNow), [1, 1, 1, 1, 1, 1, 1]);
    assert.equal(Object.keys(state.days).sort()[0], seedInsights.threatTimelineWindow(lastNow)[0]);
  });

  it('skips stories first seen before the window and clamps future timestamps to today', () => {
    const state = seedInsights.mergeThreatHistory(null, [
      cluster(['Very old story'], { level: 'high', pubDate: NOW - 10 * DAY_MS }),
      cluster(['Misdated future story'], { level: 'high', pubDate: NOW + 3 * DAY_MS }),
    ], { nowMs: NOW });

    assert.deepEqual(Object.keys(state.days), ['2026-11-15']);
    assert.equal(state.days['2026-11-15'].length, 1);
  });

  it('counts unclassified clusters as info', () => {
    const state = seedInsights.mergeThreatHistory(null, [cluster(['Quiet trade update'])], { nowMs: NOW });
    const timeline = seedInsights.projectThreatTimeline(state, { nowMs: NOW });
    assert.equal(timeline.days.at(-1).counts.info, 1);
  });

  it('discards malformed stored entries instead of failing the run', () => {
    const state = seedInsights.mergeThreatHistory({
      recordingSince: 'yesterday',
      days: {
        'not-a-day': [{ l: 'high', k: ['aaaaaaaaaaaa'] }],
        '2026-11-14': [{ l: 'bogus', k: ['bbbbbbbbbbbb'] }, { l: 'high', k: ['short'] }, null],
      },
    }, [], { nowMs: NOW });

    assert.deepEqual(state.days, { '2026-11-14': [{ l: 'info', k: ['bbbbbbbbbbbb'] }] });
    assert.equal(state.recordingSince, '2026-11-15');
  });

  it('projects exactly the seven window days, oldest first', () => {
    const timeline = seedInsights.projectThreatTimeline({ recordingSince: '2026-11-15', updatedAt: 'x', days: {} }, { nowMs: NOW });
    assert.deepEqual(timeline.days.map(day => day.date), [
      '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
    ]);
    assert.equal(timeline.recordingSince, '2026-11-15');
  });

  it('spreads a real clustered digest over the days its stories were published', () => {
    const items = seedInsights.normalizeDigestItemsForInsights([
      { title: 'Harbor quarry violin report', source: 'A', link: 'https://example.com/1', publishedAt: NOW - 4 * DAY_MS, threat: { level: 'THREAT_LEVEL_HIGH' } },
      { title: 'Glacier turnip lantern report', source: 'B', link: 'https://example.com/2', publishedAt: NOW - 2 * DAY_MS, threat: { level: 'THREAT_LEVEL_MEDIUM' } },
      { title: 'Meadow saddle pebble report', source: 'C', link: 'https://example.com/3', publishedAt: NOW, threat: { level: 'THREAT_LEVEL_UNSPECIFIED' } },
    ]);
    const clusters = clusterItems(items);
    const state = seedInsights.mergeThreatHistory(null, clusters, {
      nowMs: NOW,
      pubMsByTitle: seedInsights.buildPubMsByTitle(items),
    });
    const days = seedInsights.projectThreatTimeline(state, { nowMs: NOW }).days;

    assert.equal(days[2].counts.high, 1);
    assert.equal(days[4].counts.medium, 1);
    assert.equal(days[6].counts.info, 1);
  });

  it('publishes the day counts but keeps the fingerprint state out of the public payload', () => {
    const published = seedInsights.publishInsightsPayload({
      topStories: [{}],
      threatTimeline: { version: 1, days: [] },
      threatHistory: { days: {} },
    });
    assert.ok(published.threatTimeline);
    assert.equal(Object.hasOwn(published, 'threatHistory'), false);
  });

  it('carries the last published timeline forward when the history read fails', () => {
    const previous = { version: 1, recordingSince: '2026-11-10', updatedAt: 'x', partialDays: [], days: [] };
    assert.deepEqual(seedInsights.threatTimelineFields(null, { threatTimeline: previous }), { threatTimeline: previous });
    assert.deepEqual(seedInsights.threatTimelineFields(null, { topStories: [] }), {});
    assert.deepEqual(seedInsights.threatTimelineFields(null, null), {});
    const run = { threatTimeline: { days: ['fresh'] }, threatHistory: { days: {} } };
    assert.deepEqual(seedInsights.threatTimelineFields(run, { threatTimeline: previous }), run);
  });

  it('writes the history after publish, fenced by the run lock, and protects it on every preservation path', () => {
    const source = readFileSync(new URL('../scripts/seed-insights.mjs', import.meta.url), 'utf8');
    assert.match(source, /preserveKeyTtls: \[\{ key: THREAT_HISTORY_KEY, ttlSeconds: THREAT_HISTORY_TTL \}\]/);
    assert.match(source, /writeInsightsThreatHistory\(data, \{ lockFence \}\),/);
    assert.match(source, /writeExtraKey\(THREAT_HISTORY_KEY, data\.threatHistory, THREAT_HISTORY_TTL, undefined, \{ lockFence \}\)/);
    const utils = readFileSync(new URL('../scripts/_seed-utils.mjs', import.meta.url), 'utf8');
    assert.match(utils, /afterPublish\(data, \{ canonicalKey, ttlSeconds, recordCount, runId, lockFence \}\)/);
    assert.match(utils, /const validationSkipContext = \{[^}]*lockFence,/);
  });
});
