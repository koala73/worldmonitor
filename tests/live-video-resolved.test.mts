import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LIVE_VIDEO_TIMING,
  type LiveVideoSource,
  parseResolvedLiveVideos,
  type ResolvedLiveVideos,
  sourceListsChannel,
  withResolvedEntries,
} from '../src/services/live-video/model.ts';

const NOW = Date.UTC(2026, 8, 24, 12);
const HOUR = 60 * 60_000;
const X = 'UCIALMKvObZNtJ6AmdCLP7Lg';
const Y = 'UCknLrEdhRCp1aegoMqRaCZg';
const channel = (id: string) => `https://www.youtube.com/channel/${id}`;
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const HLS = 'https://streams.example/bloomberg/live.m3u8';
const A = 'QB5BNdBFujE';
const B = 'NEW1234567x';
const C = 'CCC1234567c';

function payload(channels: Record<string, unknown>): unknown {
  return { resolvedAt: new Date(NOW).toISOString(), channels, stats: { attempted: 2, live: 2 } };
}

function map(entries: Record<string, string>, ageMs = HOUR): ResolvedLiveVideos {
  const resolvedAt = new Date(NOW - ageMs).toISOString();
  return parseResolvedLiveVideos(
    payload(Object.fromEntries(Object.entries(entries).map(([id, videoId]) => [id, { videoId, resolvedAt }]))),
    NOW,
  );
}

function builtin(entries: string[]): LiveVideoSource {
  return { slot: 'live-news/fixture', entries, origin: 'builtin' };
}

describe('parseResolvedLiveVideos', () => {
  it('reads channel id to video id and resolution time', () => {
    const parsed = map({ [X]: B }, 2 * HOUR);
    assert.equal(parsed.size, 1);
    assert.deepEqual(parsed.get(X as never), { videoId: B, resolvedAtMs: NOW - 2 * HOUR });
  });

  it('never throws, and reads anything that is not a payload as an empty map', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}, { channels: null }, { channels: 'x' }, { channels: [] }]) {
      assert.equal(parseResolvedLiveVideos(raw, NOW).size, 0, JSON.stringify(raw));
    }
  });

  it('drops keys that are not channel ids', () => {
    const resolvedAt = new Date(NOW).toISOString();
    const parsed = parseResolvedLiveVideos(payload({
      '@CNN': { videoId: B, resolvedAt },
      [`https://www.youtube.com/channel/${X}`]: { videoId: B, resolvedAt },
      [` ${X}`]: { videoId: B, resolvedAt },
      ['__proto__']: { videoId: B, resolvedAt },
      [Y]: { videoId: C, resolvedAt },
    }), NOW);
    assert.deepEqual([...parsed.keys()], [Y]);
  });

  it('keeps only a bare 11-char video id (AE7)', () => {
    const resolvedAt = new Date(NOW).toISOString();
    for (const videoId of [
      'https://evil/x.m3u8', 'javascript:1', 'NEW1234567', 'NEW1234567xy', watch(B), `https://youtu.be/${B}`,
      ` ${B}`, 42, null, undefined, { id: B },
    ]) {
      assert.equal(parseResolvedLiveVideos(payload({ [X]: { videoId, resolvedAt } }), NOW).size, 0, String(videoId));
    }
  });

  it('drops entries without a readable resolvedAt', () => {
    for (const resolvedAt of [undefined, null, 'yesterday', '', 12345, {}]) {
      assert.equal(parseResolvedLiveVideos(payload({ [X]: { videoId: B, resolvedAt } }), NOW).size, 0, String(resolvedAt));
    }
  });

  it('keeps an entry exactly resolvedMaxAgeMs old and drops one a millisecond older', () => {
    assert.equal(map({ [X]: B }, LIVE_VIDEO_TIMING.resolvedMaxAgeMs).size, 1);
    assert.equal(map({ [X]: B }, LIVE_VIDEO_TIMING.resolvedMaxAgeMs + 1).size, 0);
  });

  it('ignores unknown fields on an entry', () => {
    const resolvedAt = new Date(NOW).toISOString();
    const parsed = parseResolvedLiveVideos(payload({ [X]: { videoId: B, resolvedAt, title: 'Live', slots: ['x'] } }), NOW);
    assert.deepEqual(parsed.get(X as never), { videoId: B, resolvedAtMs: NOW });
  });

  it('drops a non-object entry', () => {
    assert.equal(parseResolvedLiveVideos(payload({ [X]: B }), NOW).size, 0);
  });
});

describe('sourceListsChannel', () => {
  it('is true only for a builtin source listing a channel entry', () => {
    assert.equal(sourceListsChannel(builtin([HLS, watch(A)])), false);
    assert.equal(sourceListsChannel(builtin([watch(A), channel(X)])), true);
    assert.equal(sourceListsChannel(builtin([`https://www.youtube.com/embed/live_stream?channel=${X}`])), true);
    assert.equal(sourceListsChannel(builtin([])), false);
    assert.equal(sourceListsChannel({ slot: 'live-news/custom-1', entries: [channel(X)], origin: 'custom' }), false);
  });
});

describe('withResolvedEntries (candidate order, D3)', () => {
  const rows: ReadonlyArray<readonly [string, string[], Record<string, string>, string[]]> = [
    ['channel-only slot', [channel(X)], { [X]: B }, [watch(B), channel(X)]],
    ['pinned id ahead of the channel keeps priority', [watch(A), channel(X)], { [X]: B }, [watch(A), watch(B), channel(X)]],
    ['bloomberg: HLS and pinned id keep priority (AE5)', [HLS, watch(A), channel(X)], { [X]: B }, [HLS, watch(A), watch(B), channel(X)]],
    ['each id lands before its own channel', [channel(X), watch(A), channel(Y)], { [X]: B, [Y]: C },
      [watch(B), channel(X), watch(A), watch(C), channel(Y)]],
  ];
  for (const [name, entries, resolved, expected] of rows) {
    it(name, () => {
      assert.deepEqual(withResolvedEntries(builtin(entries), map(resolved), NOW).entries, expected);
    });
  }

  it('returns the same source when the resolved id is already listed (AE5)', () => {
    const source = builtin([HLS, watch(A), channel(X)]);
    assert.equal(withResolvedEntries(source, map({ [X]: A }), NOW), source);
  });

  it('skips an id listed after its channel too', () => {
    const source = builtin([channel(X), watch(B)]);
    assert.equal(withResolvedEntries(source, map({ [X]: B }), NOW), source);
  });

  it('returns the same source when no channel is listed, or the map is empty or has no entry for it', () => {
    const pinned = builtin([watch(A)]);
    assert.equal(withResolvedEntries(pinned, map({ [X]: B }), NOW), pinned);
    const slot = builtin([watch(A), channel(X)]);
    assert.equal(withResolvedEntries(slot, new Map(), NOW), slot);
    assert.equal(withResolvedEntries(slot, map({ [Y]: C }), NOW), slot);
  });

  it('ignores an entry that aged past resolvedMaxAgeMs since the map was parsed', () => {
    const slot = builtin([watch(A), channel(X)]);
    const resolved = map({ [X]: B });
    assert.equal(withResolvedEntries(slot, resolved, NOW + LIVE_VIDEO_TIMING.resolvedMaxAgeMs), slot);
  });

  it('inserts an id two channels share once, before the first of them', () => {
    const source = builtin([channel(X), channel(Y)]);
    assert.deepEqual(withResolvedEntries(source, map({ [X]: B, [Y]: B }), NOW).entries, [watch(B), channel(X), channel(Y)]);
  });

  it('leaves a custom source untouched', () => {
    const source: LiveVideoSource = { slot: 'live-news/custom-1', entries: [channel(X)], origin: 'custom' };
    assert.equal(withResolvedEntries(source, map({ [X]: B }), NOW), source);
  });

  it('keeps the slot and origin', () => {
    const merged = withResolvedEntries(builtin([channel(X)]), map({ [X]: B }), NOW);
    assert.equal(merged.slot, 'live-news/fixture');
    assert.equal(merged.origin, 'builtin');
  });
});
