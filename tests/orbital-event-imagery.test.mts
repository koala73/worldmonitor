import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MatchedAcquisition } from '../src/services/orbital/match.ts';
import type { SceneHistory } from '../src/services/orbital/scene-history.ts';
import { EVENT_AFTER_DAYS, eventWindowEndMs, findEventPair, pickEventPair } from '../src/services/orbital/event-imagery.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 12);
const point = { lat: 31.52, lon: 34.45 };
const crop = (id: string) => `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/34.42,31.49,34.48,31.55.png?collection=sentinel-2-l2a&item=${id}`;

function scene(daysAgo: number, cloudCoverPct: number | null, over: Partial<MatchedAcquisition> = {}): MatchedAcquisition {
  const startMs = NOW - daysAgo * DAY;
  return {
    key: `sentinel-2c:1:${startMs}`, profileId: 'sentinel-2', platform: 'sentinel-2c', orbit: 1, startMs, endMs: startMs + 5_000, items: [],
    pass: null, condition: 'clear', cloudCoverPct, sunElevationDeg: 40, resolutionM: 10, imageUrl: crop(`S2C_${daysAgo}`), ...over,
  };
}
const radar = (daysAgo: number) => scene(daysAgo, null, { profileId: 'sentinel-1', platform: 'sentinel-1c', key: `sentinel-1c:1:${daysAgo}` });

describe('event window', () => {
  it('ends 30 days after an old event, and now for a recent one', () => {
    const old = NOW - 90 * DAY;
    assert.equal(eventWindowEndMs(old, NOW), old + EVENT_AFTER_DAYS * DAY);
    assert.equal(eventWindowEndMs(NOW - 2 * DAY, NOW), NOW);
  });

  it('never reaches past now for an event stamped in the future', () => {
    assert.equal(eventWindowEndMs(NOW + 5 * DAY, NOW), NOW);
  });
});

describe('pickEventPair', () => {
  it('takes the last clear scene before the event and the first clear one at or after it', () => {
    const eventMs = NOW - 10 * DAY;
    const { before, after } = pickEventPair(eventMs, [scene(2, 5), scene(8, 60), scene(9, 10), scene(12, 0), scene(20, 1)]);
    assert.equal(before?.startMs, NOW - 12 * DAY);
    assert.equal(after?.startMs, NOW - 9 * DAY);
  });

  it('leaves out cloudy optical scenes, scenes with unknown cloud and whole-scene previews', () => {
    const eventMs = NOW - 10 * DAY;
    const preview = scene(11, 0, { imageUrl: 'https://planetarycomputer.microsoft.com/api/data/v1/item/preview.png?collection=sentinel-2-l2a&item=x' });
    const { before, after } = pickEventPair(eventMs, [scene(5, 80), scene(6, null), preview]);
    assert.equal(before, null);
    assert.equal(after, null);
  });
});

describe('findEventPair', () => {
  const searches = (answers: Record<string, SceneHistory>) => {
    const calls: Array<{ profile: string; endMs: number }> = [];
    const searchHistory = async (_p: unknown, profile: string, endMs: number): Promise<SceneHistory> => {
      calls.push({ profile, endMs });
      return answers[profile] ?? { status: 'ok', scenes: [] };
    };
    return { calls, deps: { searchHistory: searchHistory as never } };
  };

  it('returns the optical pair and searches the window that holds the event', async () => {
    const eventMs = NOW - 40 * DAY;
    const { calls, deps } = searches({ 'sentinel-2': { status: 'ok', scenes: [scene(35, 3), scene(45, 4)] } });
    const pair = await findEventPair(point, eventMs, NOW, {}, deps);
    assert.equal(pair.status, 'ok');
    assert.deepEqual(calls, [{ profile: 'sentinel-2', endMs: eventMs + EVENT_AFTER_DAYS * DAY }]);
    if (pair.status === 'ok') {
      assert.equal(pair.before.startMs, NOW - 45 * DAY);
      assert.equal(pair.after.startMs, NOW - 35 * DAY);
      assert.equal(pair.windowEndMs, eventMs + EVENT_AFTER_DAYS * DAY);
    }
  });

  it('falls back to radar when cloud leaves the optical pair incomplete', async () => {
    const { calls, deps } = searches({
      'sentinel-2': { status: 'ok', scenes: [scene(1, 90), scene(9, 2)] },
      'sentinel-1': { status: 'ok', scenes: [radar(2), radar(8)] },
    });
    const pair = await findEventPair(point, NOW - 5 * DAY, NOW, {}, deps);
    assert.deepEqual(calls.map((c) => c.profile), ['sentinel-2', 'sentinel-1']);
    assert.equal(pair.status === 'ok' && pair.profileId, 'sentinel-1');
  });

  it('says no scene has come after the event yet when neither mission has one', async () => {
    const { deps } = searches({ 'sentinel-2': { status: 'ok', scenes: [scene(3, 1)] }, 'sentinel-1': { status: 'ok', scenes: [radar(4)] } });
    assert.deepEqual(await findEventPair(point, NOW - DAY, NOW, {}, deps), { status: 'none', missing: 'after' });
  });

  it('says the before side is missing when only scenes after the event exist', async () => {
    const { deps } = searches({ 'sentinel-2': { status: 'ok', scenes: [scene(1, 1)] } });
    assert.deepEqual(await findEventPair(point, NOW - 3 * DAY, NOW, {}, deps), { status: 'none', missing: 'before' });
  });

  it('fails rather than naming a missing side when one archive could not answer', async () => {
    const failed: SceneHistory = { status: 'failed', failure: { archive: 'planetary-computer', reason: 'timeout' } };
    const { deps } = searches({ 'sentinel-2': { status: 'ok', scenes: [] }, 'sentinel-1': failed });
    assert.deepEqual(await findEventPair(point, NOW - 3 * DAY, NOW, {}, deps), { status: 'failed' });
  });

  it('fails when every archive failed', async () => {
    const failed: SceneHistory = { status: 'failed', failure: { archive: 'planetary-computer', reason: 'timeout' } };
    const { deps } = searches({ 'sentinel-2': failed, 'sentinel-1': failed });
    assert.deepEqual(await findEventPair(point, NOW - 3 * DAY, NOW, {}, deps), { status: 'failed' });
  });
});
