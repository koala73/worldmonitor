// The relay's news-alert story key (scripts/lib/news-story-key.cjs).
//
// 2026-11-17: an alerted CNN exclusive alerted a second time nine hours later
// when Egypt Independent republished it under the same headline. The headlines
// below are the four the relay queued for that story.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest.ts';

const require = createRequire(import.meta.url);
const {
  NEWS_STORY_DEDUP_TTL_SECONDS,
  REALTIME_CRITICAL_IMPORTANCE_SCORE,
  newsStoryKey,
  newsStoryKeyLoadError,
  normalizeNewsStoryTitle,
} = require('../scripts/lib/news-story-key.cjs');
const { NEWS_GLOBAL_IMPORTANCE_SCORE } = require('../scripts/lib/notification-delivery-tiers.cjs');

// A sighting a realtime rule delivers, and two it does not.
const DELIVERABLE = { severity: 'critical', importanceScore: 83 };
const LOW_SCORE_CRITICAL = { severity: 'critical', importanceScore: 73 };
const HIGH = { severity: 'high', importanceScore: 69 };

const CNN = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say - CNN';
const EGYPT_INDEPENDENT = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say';
const SUN_ONLINE = 'Iran plots dirty bomb or chemical attack on US capital —report - SunOnline International';
const NDTV = "Iran Plans To Detonate 'Dirty Bomb' In Washington, Warns US Intel: Report";

test('the shared normalizer loads', () => {
  assert.equal(newsStoryKeyLoadError(), null);
});

test('a headline repeated by a second publisher has the story key of the first', () => {
  assert.ok(newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(EGYPT_INDEPENDENT, DELIVERABLE), newsStoryKey(CNN, DELIVERABLE));
});

test('case and punctuation do not change the key', () => {
  assert.equal(
    newsStoryKey('EXCLUSIVE - US intel indicates Iran developing plans to potentially detonate a "dirty bomb" in Washington; sources say', DELIVERABLE),
    newsStoryKey(EGYPT_INDEPENDENT, DELIVERABLE),
  );
});

test('differently worded reports of one event keep separate keys', () => {
  const keys = new Set([CNN, SUN_ONLINE, NDTV].map((title) => newsStoryKey(title, HIGH)));
  assert.equal(keys.size, 3);
});

test('a sighting no realtime rule delivers does not share a key with one that is delivered', () => {
  // Realtime rules deliver critical events at or above the score bar. A
  // sighting below either reaches nobody, so it must not claim the story
  // before a later one that would be delivered.
  assert.notEqual(newsStoryKey(CNN, HIGH), newsStoryKey(CNN, DELIVERABLE));
  assert.notEqual(newsStoryKey(CNN, LOW_SCORE_CRITICAL), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(CNN, LOW_SCORE_CRITICAL), newsStoryKey(CNN, HIGH));
  assert.equal(newsStoryKey(CNN, { severity: 'critical', importanceScore: 82 }), newsStoryKey(CNN, DELIVERABLE));
});

test('a critical sighting without a score counts as delivered, as the relay treats it', () => {
  assert.equal(newsStoryKey(CNN, { severity: 'critical' }), newsStoryKey(CNN, DELIVERABLE));
  assert.equal(newsStoryKey(CNN), newsStoryKey(CNN, HIGH));
});

test('the score bar is the one realtime delivery uses', () => {
  assert.equal(REALTIME_CRITICAL_IMPORTANCE_SCORE, NEWS_GLOBAL_IMPORTANCE_SCORE);
});

test('a headline too short to stand for one story keeps the exact-title identity', () => {
  assert.equal(newsStoryKey('Israel strikes Lebanon', DELIVERABLE), '');
  assert.equal(newsStoryKey('Wind', DELIVERABLE), '');
  assert.equal(newsStoryKey('', DELIVERABLE), '');
  assert.equal(newsStoryKey(undefined, DELIVERABLE), '');
  assert.ok(newsStoryKey('Iran closes Strait of Hormuz', DELIVERABLE));
});

test('the key normalizes a headline as digest story tracking does, without its 120-character cut', () => {
  for (const title of [
    CNN,
    EGYPT_INDEPENDENT,
    SUN_ONLINE,
    NDTV,
    'Tankers hit in Strait of Hormuz as drone raises alarm at Iraq gas field - Al Jazeera',
    'Ukraine’s Ust-Luga strike destroyed five fuel tanks | Reuters',
    'Séisme de magnitude 7,1 au large du Chili – Le Monde',
    `Long headline ${'word '.repeat(60)}`,
  ]) {
    const tracked = digest.normalizeTitle(title);
    const keyed = normalizeNewsStoryTitle(title);
    if (keyed.length <= 120) assert.equal(keyed, tracked, title);
    else assert.equal(keyed.slice(0, 120).trim(), tracked.trim(), title);
  }
});

test('long headlines that part only at the end keep separate keys', () => {
  const lead = 'Russia launches a major overnight missile and drone attack on energy infrastructure across Ukraine as authorities report';
  const kyiv = `${lead} three people killed in Kyiv`;
  const odesa = `${lead} twenty people killed in Odesa`;
  // Story tracking cuts both to the same 120 characters.
  assert.equal(digest.normalizeTitle(kyiv), digest.normalizeTitle(odesa));
  assert.notEqual(newsStoryKey(kyiv, DELIVERABLE), newsStoryKey(odesa, DELIVERABLE));
  assert.equal(newsStoryKey(`${kyiv} - Reuters`, DELIVERABLE), newsStoryKey(kyiv, DELIVERABLE));
});

test('a story is claimed for the day an exact repeat is already held for', () => {
  assert.equal(NEWS_STORY_DEDUP_TTL_SECONDS, 24 * 60 * 60);
});
