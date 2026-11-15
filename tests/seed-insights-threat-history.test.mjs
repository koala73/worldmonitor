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

  it('writes the history after publish and protects it on every preservation path', () => {
    const source = readFileSync(new URL('../scripts/seed-insights.mjs', import.meta.url), 'utf8');
    assert.match(source, /preserveKeyTtls: \[\{ key: THREAT_HISTORY_KEY, ttlSeconds: THREAT_HISTORY_TTL \}\]/);
    assert.match(source, /writeInsightsThreatHistory\(data\),/);
  });
});
