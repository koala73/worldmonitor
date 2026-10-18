import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAttempt,
  type DurationSample,
  LIVE_VIDEO_TIMING,
  parseSourceEntry,
  type PlayerObservation,
  type YouTubeVideoSnapshot,
} from '../src/services/live-video/model.ts';

describe('parseSourceEntry', () => {
  const accepted: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
    ['bare video id', 'z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['bare video id with whitespace', '  z_fY1pj1VBw\n', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['watch URL', 'https://www.youtube.com/watch?v=z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['watch URL with extra params', 'https://m.youtube.com/watch?t=5&v=-xzg3wujOVM&ab_channel=X', { kind: 'video', videoId: '-xzg3wujOVM' }],
    ['watch URL without a scheme', 'youtube.com/watch?v=z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['short link', 'https://youtu.be/z_fY1pj1VBw?si=abc', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['www short link', 'https://www.youtu.be/z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['live URL', 'https://www.youtube.com/live/z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['embed URL', 'https://www.youtube.com/embed/z_fY1pj1VBw?autoplay=1', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['nocookie embed URL', 'https://www.youtube-nocookie.com/embed/z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['channel URL', 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg', { kind: 'channel', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' }],
    ['channel live URL', 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live', { kind: 'channel', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' }],
    ['channel live embed', 'https://www.youtube.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg', { kind: 'channel', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }],
    ['bare channel id', 'UCknLrEdhRCp1aegoMqRaCZg', { kind: 'channel', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }],
    ['https manifest', 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8', { kind: 'hls', url: 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8' }],
    ['https manifest with a query', 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116', { kind: 'hls', url: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116' }],
  ];

  for (const [label, entry, candidate] of accepted) {
    it(`accepts a ${label}`, () => {
      assert.deepEqual(parseSourceEntry(entry), { ok: true, entry, candidate });
    });
  }

  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ['an http manifest', 'http://example.com/live/index.m3u8', 'not-https'],
    ['a googlevideo manifest', 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/index.m3u8', 'youtube-manifest'],
    ['a youtube.com manifest', 'https://www.youtube.com/api/manifest/hls_playlist/id/playlist.m3u8', 'youtube-manifest'],
    ['an @handle', '@CNN', 'needs-channel-url'],
    ['a handle live URL', 'https://www.youtube.com/@CNN/live', 'needs-channel-url'],
    ['a /c/ URL', 'https://www.youtube.com/c/CNN', 'needs-channel-url'],
    ['a /user/ URL', 'https://www.youtube.com/user/CNN', 'needs-channel-url'],
    ['an empty string', '   ', 'unrecognized'],
    ['free text', 'CNN live', 'unrecognized'],
    ['a watch URL with a short id', 'https://www.youtube.com/watch?v=short', 'unrecognized'],
    ['a live embed without a channel id', 'https://www.youtube.com/embed/live_stream?channel=CNN', 'unrecognized'],
    ['a non-YouTube page', 'https://example.com/watch?v=z_fY1pj1VBw', 'unrecognized'],
    ['a javascript URL', 'javascript:alert(1)', 'unrecognized'],
  ];

  for (const [label, entry, problem] of rejected) {
    it(`rejects ${label} as ${problem}`, () => {
      assert.deepEqual(parseSourceEntry(entry), { ok: false, entry, problem });
    });
  }
});

function video(overrides: Partial<YouTubeVideoSnapshot> = {}): YouTubeVideoSnapshot {
  return { videoId: 'gCNeDWCI0vo', isLive: true, title: 'Al Jazeera English | Live', author: 'Al Jazeera English', ...overrides };
}

function youtube(overrides: Partial<Extract<PlayerObservation, { api: 'loaded' }>> = {}): PlayerObservation {
  return {
    transport: 'youtube',
    api: 'loaded',
    candidate: 'video',
    elapsedMs: 3_000,
    frameLoaded: true,
    readyAtMs: 900,
    errorCode: null,
    video: null,
    durations: [],
    ...overrides,
  };
}

/** Two PLAYING samples one confirm window apart with the same positive duration. */
function flat(seconds: number, fromMs = 2_000): DurationSample[] {
  return [{ atMs: fromMs, seconds }, { atMs: fromMs + LIVE_VIDEO_TIMING.recordingConfirmMs, seconds }];
}

function hls(overrides: Partial<Extract<PlayerObservation, { transport: 'hls' }>> = {}): PlayerObservation {
  return { transport: 'hls', elapsedMs: 800, manifest: 'unknown', progress: 'stalled', failure: null, ...overrides };
}

describe('classifyAttempt: YouTube', () => {
  it('calls an isLive stream live (Al Jazeera gCNeDWCI0vo, duration 4,056,940 s)', () => {
    const snapshot = video();
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 4_056_940 }] })),
      { verdict: 'live', video: snapshot },
    );
  });

  it('calls an ended stream a recording (Kyiv -Q7FuPINDjA, isLive=false, duration 24,181 s)', () => {
    const snapshot = video({ videoId: '-Q7FuPINDjA', isLive: false, author: 'DW News' });
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, elapsedMs: 9_000, durations: flat(24_181) })),
      { verdict: 'recording', video: snapshot },
    );
  });

  it('calls a short ended stream a recording (Shanghai 76EwqI5XZIc, duration 1,678 s)', () => {
    const snapshot = video({ videoId: '76EwqI5XZIc', isLive: false });
    assert.equal(classifyAttempt(youtube({ video: snapshot, elapsedMs: 9_000, durations: flat(1_678) })).verdict, 'recording');
  });

  it('needs isLive=false to hold while playing for the confirm window before calling a recording', () => {
    const snapshot = video({ videoId: '-Q7FuPINDjA', isLive: false });
    const windowMs = LIVE_VIDEO_TIMING.recordingConfirmMs;
    assert.deepEqual(classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 24_181 }] })), { verdict: 'pending' });
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 24_181 }, { atMs: 2_000 + windowMs - 1, seconds: 24_181 }] })),
      { verdict: 'pending' },
    );
  });

  it('calls a live stream live although its duration stays flat while playing (Jerusalem zp6LNSoq000, 15,652,510 s)', () => {
    const snapshot = video({ videoId: 'zp6LNSoq000' });
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, elapsedMs: 9_000, durations: flat(15_652_510) })),
      { verdict: 'live', video: snapshot },
    );
  });

  it('never calls a scheduled stream live: isLive=true that never starts playing (NASASpaceflight _7nBPHF-hAE)', () => {
    const upcoming = video({ videoId: '_7nBPHF-hAE', title: 'Vega C launches Sentinel-3C & FLEX', author: 'NASASpaceflight' });
    const deadline = LIVE_VIDEO_TIMING.verdictDeadlineMs;
    assert.deepEqual(classifyAttempt(youtube({ video: upcoming, elapsedMs: deadline - 1 })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(youtube({ video: upcoming, elapsedMs: deadline })), {
      verdict: 'failed',
      outcome: { kind: 'not-started' },
    });
  });

  it('ignores zero durations sampled before playback settles', () => {
    const windowMs = LIVE_VIDEO_TIMING.recordingConfirmMs;
    const samples = [{ atMs: 1_000, seconds: 0 }, { atMs: 2_000, seconds: 500 }, { atMs: 2_000 + windowMs, seconds: 500 }];
    assert.equal(classifyAttempt(youtube({ video: video({ isLive: false }), elapsedMs: 9_000, durations: samples })).verdict, 'recording');
  });

  it('keeps isLive=false pending while no positive duration has been sampled', () => {
    const snapshot = video({ isLive: false });
    assert.deepEqual(classifyAttempt(youtube({ video: snapshot })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 1_500, seconds: 0 }] })), { verdict: 'pending' });
  });

  for (const code of [2, 5, 100, 101, 150, 152, 153]) {
    it(`fails on player error ${code}`, () => {
      assert.deepEqual(classifyAttempt(youtube({ errorCode: code })), {
        verdict: 'failed',
        outcome: { kind: 'player-error', code },
      });
    });
  }

  it('lets a player error win over a live snapshot', () => {
    assert.equal(classifyAttempt(youtube({ errorCode: 150, video: video() })).verdict, 'failed');
  });

  it('reports a blocked IFrame API as unverifiable', () => {
    assert.deepEqual(classifyAttempt({ transport: 'youtube', api: 'blocked' }), {
      verdict: 'unverifiable',
      reason: 'player-api-blocked',
    });
  });

  it('fails a channel embed that stays ready with no video for the grace period', () => {
    const empty = video({ videoId: '', isLive: undefined, title: '', author: '' });
    const readyAtMs = 1_000;
    assert.deepEqual(
      classifyAttempt(youtube({ candidate: 'channel', video: empty, readyAtMs, elapsedMs: readyAtMs + LIVE_VIDEO_TIMING.channelEmptyGraceMs - 1 })),
      { verdict: 'pending' },
    );
    assert.deepEqual(
      classifyAttempt(youtube({ candidate: 'channel', video: empty, readyAtMs, elapsedMs: readyAtMs + LIVE_VIDEO_TIMING.channelEmptyGraceMs })),
      { verdict: 'failed', outcome: { kind: 'channel-not-live' } },
    );
  });

  it('never calls a video candidate channel-not-live', () => {
    const empty = video({ videoId: '', isLive: undefined });
    assert.deepEqual(classifyAttempt(youtube({ video: empty, readyAtMs: 1_000, elapsedMs: 9_000 })), { verdict: 'pending' });
  });

  describe('when YouTube stops exposing isLive', () => {
    const noFlag = video({ isLive: undefined });
    const windowMs = LIVE_VIDEO_TIMING.recordingConfirmMs;

    it('never calls a stream live or a recording from its duration alone', () => {
      // A live stream's duration stays flat while playing, so duration cannot tell live from ended.
      const flatSamples = [{ atMs: 1_000, seconds: 500 }, { atMs: 1_000 + 4 * windowMs, seconds: 500 }];
      const growingSamples = [{ atMs: 1_000, seconds: 100 }, { atMs: 1_000 + 4 * windowMs, seconds: 100 + (4 * windowMs) / 1000 }];
      assert.deepEqual(classifyAttempt(youtube({ video: noFlag, elapsedMs: 10_000, durations: flatSamples })), { verdict: 'pending' });
      assert.deepEqual(classifyAttempt(youtube({ video: noFlag, elapsedMs: 10_000, durations: growingSamples })), { verdict: 'pending' });
    });

    it('reports the missing live signal as unverifiable at the deadline', () => {
      assert.deepEqual(
        classifyAttempt(youtube({ video: noFlag, elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs, durations: flat(500) })),
        { verdict: 'unverifiable', reason: 'live-signal-missing' },
      );
    });
  });

  it('reports a loaded frame whose player never becomes ready as unverifiable at the deadline', () => {
    const deadline = LIVE_VIDEO_TIMING.verdictDeadlineMs;
    assert.deepEqual(classifyAttempt(youtube({ readyAtMs: null, elapsedMs: deadline - 1 })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(youtube({ readyAtMs: null, elapsedMs: deadline })), {
      verdict: 'unverifiable',
      reason: 'player-api-silent',
    });
  });

  it('times out when the frame never loads', () => {
    assert.deepEqual(
      classifyAttempt(youtube({ frameLoaded: false, readyAtMs: null, elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })),
      { verdict: 'failed', outcome: { kind: 'timeout' } },
    );
  });

  it('times out a ready player that never produced a verdict', () => {
    assert.deepEqual(
      classifyAttempt(youtube({ video: video({ isLive: false }), elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })),
      { verdict: 'failed', outcome: { kind: 'timeout' } },
    );
  });
});

describe('classifyAttempt: HLS', () => {
  it('calls a live playlist live once playback advances', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live', progress: 'advancing' })), { verdict: 'live', video: null });
  });

  it('calls a live playlist live on the manifest alone when playback cannot be checked (the Node checker)', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live', progress: 'unchecked' })), { verdict: 'live', video: null });
  });

  it('never calls a live playlist live while playback is stalled, and fails it as not started at the deadline', () => {
    // A browser that cannot decode the stream (Playwright's Chromium has no H.264) sits on a black 0:00.
    const deadline = LIVE_VIDEO_TIMING.verdictDeadlineMs;
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live', progress: 'stalled', elapsedMs: deadline - 1 })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live', progress: 'stalled', elapsedMs: deadline })), {
      verdict: 'failed',
      outcome: { kind: 'not-started' },
    });
  });

  it('calls a VOD playlist a recording', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'vod' })), { verdict: 'recording', video: null });
  });

  it('times out an unknown manifest at the deadline even while playback advances', () => {
    assert.deepEqual(classifyAttempt(hls({ progress: 'advancing', elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })), {
      verdict: 'failed',
      outcome: { kind: 'timeout' },
    });
  });

  it('lets an HTTP failure win over a live playlist that is advancing', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live', progress: 'advancing', failure: { kind: 'http', status: 403 } })), {
      verdict: 'failed',
      outcome: { kind: 'hls-http', status: 403 },
    });
  });

  it('fails on an HTTP status', () => {
    assert.deepEqual(classifyAttempt(hls({ failure: { kind: 'http', status: 404 } })), {
      verdict: 'failed',
      outcome: { kind: 'hls-http', status: 404 },
    });
  });

  it('fails on a fatal error', () => {
    assert.deepEqual(classifyAttempt(hls({ failure: { kind: 'fatal', detail: 'manifestParsingError' } })), {
      verdict: 'failed',
      outcome: { kind: 'hls-fatal', detail: 'manifestParsingError' },
    });
  });

  it('waits for an unknown manifest until the deadline, then times out', () => {
    assert.deepEqual(classifyAttempt(hls()), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(hls({ elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })), {
      verdict: 'failed',
      outcome: { kind: 'timeout' },
    });
  });
});
