import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALONE_RECHECK_BUDGET_MS,
  catalogTargets,
  exitCodeFor,
  formatCheckLine,
  observationFromRecord,
  parseCheckArgs,
  probeHlsCandidate,
  probeHlsCandidates,
  probeYouTubeBatches,
  probeYouTubeCandidates,
  runCheck,
  slotStatus,
} from '../scripts/check-live-video-sources.mjs';
import { extractLiveVideoSurfaces, readLiveVideoSurfaces } from '../scripts/lib/live-video-surfaces.mjs';
import { LIVE_NEWS_SOURCES, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { LIVE_VIDEO_TIMING, parseSourceEntry } from '../src/services/live-video/model.ts';

const parsed = (entry) => parseSourceEntry(entry);

describe('parseCheckArgs', () => {
  it('reads bare entries in order', () => {
    assert.deepEqual(parseCheckArgs(['zp6LNSoq000', 'https://www.youtube.com/watch?v=vk5BHoDxXf0']), {
      mode: 'entries',
      entries: [
        { name: null, entry: 'zp6LNSoq000' },
        { name: null, entry: 'https://www.youtube.com/watch?v=vk5BHoDxXf0' },
      ],
    });
  });

  it('reads name=entry labels without splitting a URL query', () => {
    assert.deepEqual(parseCheckArgs(['seoul=https://www.youtube.com/watch?v=vk5BHoDxXf0']), {
      mode: 'entries',
      entries: [{ name: 'seoul', entry: 'https://www.youtube.com/watch?v=vk5BHoDxXf0' }],
    });
    assert.deepEqual(parseCheckArgs(['https://www.youtube.com/watch?v=vk5BHoDxXf0']).entries[0].name, null);
  });

  it('answers --help', () => {
    assert.deepEqual(parseCheckArgs(['--help']), { mode: 'help' });
  });

  it('rejects an empty invocation and unknown flags', () => {
    assert.throws(() => parseCheckArgs([]), /Usage/);
    assert.throws(() => parseCheckArgs(['--everything']), /Unknown option --everything/);
  });

  it('reads the catalog modes', () => {
    assert.deepEqual(parseCheckArgs(['--all']), { mode: 'all' });
    assert.deepEqual(parseCheckArgs(['--slot', 'webcams/kyiv']), { mode: 'slot', slot: 'webcams/kyiv' });
    assert.throws(() => parseCheckArgs(['--slot']), /--slot needs a slot/);
  });

  it('reads --report only alongside --all', () => {
    assert.deepEqual(parseCheckArgs(['--all', '--report', 'audit.json']), { mode: 'all', report: 'audit.json' });
    assert.deepEqual(parseCheckArgs(['--report', 'audit.json', '--all']), { mode: 'all', report: 'audit.json' });
    assert.throws(() => parseCheckArgs(['--all', '--report']), /--report needs a file/);
    assert.throws(() => parseCheckArgs(['--all', '--report', '--all']), /--report needs a file/);
    assert.throws(() => parseCheckArgs(['--report', 'audit.json']), /--report needs --all/);
    assert.throws(() => parseCheckArgs(['--slot', 'webcams/kyiv', '--report', 'audit.json']), /--report needs --all/);
  });
});

describe('catalog modes', () => {
  const catalog = {
    webcams: {
      kyiv: ['https://www.youtube.com/watch?v=e2gC37ILQmk'],
      'new-york': ['JQ_jwk_7OVE', 'VGnFLdQW39A'],
      'tel-aviv': [],
    },
    news: {
      cnn: ['https://www.youtube.com/watch?v=GotlA1KKWoo'],
      rtve: [],
    },
    canaries: ['https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg'],
  };

  it('checks every entry of one slot, in try order', () => {
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'webcams/new-york' }, catalog), {
      entries: [
        { name: 'webcams/new-york', entry: 'JQ_jwk_7OVE' },
        { name: 'webcams/new-york#2', entry: 'VGnFLdQW39A' },
      ],
      empty: [],
    });
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'webcams/tel-aviv' }, catalog), { entries: [], empty: ['webcams/tel-aviv'] });
    assert.throws(() => catalogTargets({ mode: 'slot', slot: 'webcams/atlantis' }, catalog), /Unknown slot webcams\/atlantis/);
  });

  it('checks every slot and the canaries with --all', () => {
    const { entries, empty } = catalogTargets({ mode: 'all' }, catalog);
    assert.deepEqual(entries.map((row) => row.name), ['webcams/kyiv', 'webcams/new-york', 'webcams/new-york#2', 'live-news/cnn', 'canary/1']);
    assert.deepEqual(empty, ['webcams/tel-aviv', 'live-news/rtve']);
  });

  it('checks one Live News channel by slot', () => {
    assert.deepEqual(catalogTargets({ mode: 'slot', slot: 'live-news/cnn' }, catalog), {
      entries: [{ name: 'live-news/cnn', entry: 'https://www.youtube.com/watch?v=GotlA1KKWoo' }],
      empty: [],
    });
  });

  it('reports a slot with no entries and exits 1 even when every stream is live', async () => {
    const lines = [];
    const live = { verdict: { verdict: 'live', video: { videoId: 'e2gC37ILQmk', isLive: true, title: 'Ukraine', author: 'TVL' } } };
    const code = await runCheck(['--all'], {
      write: (line) => lines.push(line),
      catalog,
      probeYouTube: async (candidates) => candidates.map(() => live),
      probeHls: async () => [],
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /^EMPTY\s+webcams\/tel-aviv\s+no entries/m);
    assert.match(lines.join('\n'), /^LIVE\s+webcams\/new-york#2/m);
  });
});

describe('formatCheckLine', () => {
  it('prints a live video with its title, author and the line to paste', () => {
    const text = formatCheckLine({
      name: 'jerusalem',
      parsed: parsed('https://www.youtube.com/watch?v=zp6LNSoq000'),
      verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives Prayer Bridge' } },
    });
    assert.match(text, /^LIVE\s+jerusalem\s+https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000\s+"Western Wall" by Mt\. of Olives Prayer Bridge$/m);
    assert.match(text, /why: YouTube reports a live stream \(isLive=true\)/);
    assert.match(text, /paste: 'https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000'/);
  });

  it('prints the video a live channel embed resolved to', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('UCknLrEdhRCp1aegoMqRaCZg'),
      verdict: { verdict: 'live', video: { videoId: 'LuKwFajn37U', isLive: true, title: 'DW News livestream', author: 'DW News' } },
    });
    assert.match(text, /https:\/\/www\.youtube\.com\/channel\/UCknLrEdhRCp1aegoMqRaCZg → LuKwFajn37U/);
    assert.match(text, /paste: 'https:\/\/www\.youtube\.com\/channel\/UCknLrEdhRCp1aegoMqRaCZg'/);
  });

  it('explains a stream that never started and a missing live signal', () => {
    const entry = parsed('_7nBPHF-hAE');
    const notStarted = formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'failed', outcome: { kind: 'not-started' } } });
    assert.match(notStarted, /^FAILED/m);
    assert.match(notStarted, /why: scheduled or not started/);
    const noSignal = formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'unverifiable', reason: 'live-signal-missing' } });
    assert.match(noSignal, /^UNVERIFIED/m);
    assert.match(noSignal, /why: .*isLive missing/);
  });

  it('explains an ended recording with its duration and gives no paste line', () => {
    const text = formatCheckLine({
      name: 'kyiv',
      parsed: parsed('-Q7FuPINDjA'),
      verdict: { verdict: 'recording', video: { videoId: '-Q7FuPINDjA', isLive: false, title: 'LIVE: View of Kyiv', author: 'DW News' } },
      durationSeconds: 24_181,
    });
    assert.match(text, /^RECORDING\s+kyiv/m);
    assert.match(text, /why: ended recording \(isLive=false, duration 24,181 s\)/);
    assert.doesNotMatch(text, /paste:/);
  });

  it('prints the author without empty quotes when the title is missing', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('zp6LNSoq000'),
      verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: '', author: 'Mt. of Olives Prayer Bridge' } },
    });
    assert.match(text, /zp6LNSoq000\s+by Mt\. of Olives Prayer Bridge$/m);
    assert.doesNotMatch(text, /""/);
  });

  it('explains a player error', () => {
    const text = formatCheckLine({
      name: null,
      parsed: parsed('e34xb-Fbl0U'),
      verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } },
    });
    assert.match(text, /^FAILED\s+https:\/\/www\.youtube\.com\/watch\?v=e34xb-Fbl0U$/m);
    assert.match(text, /why: YouTube player error 150/);
  });

  it('explains an entry that cannot be checked', () => {
    const text = formatCheckLine({ name: 'cnn', parsed: parsed('@CNN') });
    assert.match(text, /^INVALID\s+cnn\s+@CNN$/m);
    assert.match(text, /why: .*youtube\.com\/channel\/UC/);
  });

  it('explains HLS verdicts', () => {
    const entry = parsed('https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8');
    assert.match(formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'live', video: null } }), /why: HLS playlist is live \(it advanced between reloads\)$/m);
    assert.match(formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status: 403 } } }), /why: manifest returned HTTP 403/);
  });
});

describe('exitCodeFor', () => {
  it('is 0 only when every entry is live', () => {
    const live = { parsed: parsed('zp6LNSoq000'), verdict: { verdict: 'live', video: null } };
    const recording = { parsed: parsed('-Q7FuPINDjA'), verdict: { verdict: 'recording', video: null } };
    const invalid = { parsed: parsed('@CNN') };
    assert.equal(exitCodeFor([live, live]), 0);
    assert.equal(exitCodeFor([live, recording]), 1);
    assert.equal(exitCodeFor([live, invalid]), 1);
    assert.equal(exitCodeFor([]), 1);
  });
});

describe('observationFromRecord', () => {
  it('maps a page record onto the classifier observation', () => {
    assert.deepEqual(observationFromRecord({
      kind: 'channel',
      apiBlocked: false,
      mounted: true,
      elapsedMs: 4_200,
      frameLoaded: true,
      readyAtMs: 1_100,
      errorCode: null,
      video: { videoId: '', isLive: undefined, title: '', author: '' },
      durations: [],
    }), {
      transport: 'youtube',
      api: 'loaded',
      candidate: 'channel',
      elapsedMs: 4_200,
      frameLoaded: true,
      readyAtMs: 1_100,
      errorCode: null,
      video: { videoId: '', isLive: undefined, title: '', author: '' },
      durations: [],
    });
  });

  it('reads missing readings as not yet observed', () => {
    const observation = observationFromRecord({ kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true });
    assert.equal(observation.errorCode, null);
    assert.equal(observation.readyAtMs, null);
    assert.equal(observation.video, null);
    assert.deepEqual(observation.durations, []);
  });

  it('reports a blocked IFrame API', () => {
    assert.deepEqual(observationFromRecord({ kind: 'video', apiBlocked: true }), { transport: 'youtube', api: 'blocked' });
  });
});

describe('probeYouTubeCandidates', () => {
  it('polls a fake page until every candidate settles, without a browser', async () => {
    const snapshots = [
      [
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true, readyAtMs: null, errorCode: null, video: null, durations: [] },
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 1_000, frameLoaded: true, readyAtMs: null, errorCode: 150, video: null, durations: [] },
      ],
      [
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 2_000, frameLoaded: true, readyAtMs: 1_500, errorCode: null, video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives' }, durations: [{ atMs: 1_900, seconds: 90_000 }] },
        { kind: 'video', apiBlocked: false, mounted: true, elapsedMs: 2_000, frameLoaded: true, readyAtMs: null, errorCode: 150, video: null, durations: [] },
      ],
    ];
    let reads = 0;
    const sleeps = [];
    const page = {
      async mount(items) {
        assert.deepEqual(items, [{ kind: 'video', id: 'zp6LNSoq000' }, { kind: 'video', id: 'e34xb-Fbl0U' }]);
      },
      async read() {
        return snapshots[Math.min(reads++, snapshots.length - 1)];
      },
    };
    const results = await probeYouTubeCandidates(
      [parsed('zp6LNSoq000').candidate, parsed('e34xb-Fbl0U').candidate],
      { page, sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.equal(reads, 2);
    assert.deepEqual(sleeps, [LIVE_VIDEO_TIMING.pollMs]);
    assert.equal(results[0].verdict.verdict, 'live');
    assert.equal(results[0].durationSeconds, 90_000);
    assert.deepEqual(results[1].verdict, { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } });
  });
});

describe('probeYouTubeBatches', () => {
  const candidates = (count) => Array.from({ length: count }, (_, index) => parsed(`vid${String(index).padStart(8, '0')}`).candidate);
  const liveFor = (batch) => batch.map((candidate) => ({ verdict: { verdict: 'live', video: { videoId: candidate.videoId } }, durationSeconds: null, verdictAtMs: null }));
  const TIMED_OUT = { verdict: { verdict: 'failed', outcome: { kind: 'timeout' } }, durationSeconds: null, verdictAtMs: null };

  /** Asserts the run covered every candidate in order, failing only the ones the stub never probed. */
  function assertOnlySkippedFailed(results, entries, probed) {
    const skipped = entries.filter((candidate) => !probed.includes(candidate));
    assert.ok(skipped.length > 0, 'the failing batch must skip at least one candidate');
    assert.equal(results.length, entries.length);
    results.forEach((result, index) => {
      if (skipped.includes(entries[index])) {
        assert.deepEqual(result, TIMED_OUT);
        return;
      }
      assert.equal(result.verdict.verdict, 'live');
      assert.equal(result.verdict.video.videoId, entries[index].videoId);
    });
  }

  it('keeps the other batches when a page fails to open', async () => {
    const entries = candidates(20);
    const probed = [];
    const errors = [];
    let opened = 0;
    const results = await probeYouTubeBatches(entries, {
      openPage: async () => {
        opened += 1;
        if (opened === 2) throw new Error('page crashed');
        return { close: async () => {} };
      },
      probeBatch: async (batch) => {
        probed.push(...batch);
        return liveFor(batch);
      },
      onError: (message) => errors.push(message),
    });
    assert.ok(opened >= 3, 'a failed batch must not stop the batches after it');
    assertOnlySkippedFailed(results, entries, probed);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /page crashed/);
  });

  it('keeps the other batches when probing throws, and still closes that page', async () => {
    const entries = candidates(20);
    const probed = [];
    const errors = [];
    let closed = 0;
    let batches = 0;
    const results = await probeYouTubeBatches(entries, {
      openPage: async () => ({ close: async () => { closed += 1; } }),
      probeBatch: async (batch) => {
        batches += 1;
        if (batches === 1) throw new Error('page navigation failed');
        probed.push(...batch);
        return liveFor(batch);
      },
      onError: (message) => errors.push(message),
    });
    assert.equal(closed, batches, 'every opened page is closed, including the one that threw');
    assertOnlySkippedFailed(results, entries, probed);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /page navigation failed/);
  });
});

describe('probeHlsCandidate', () => {
  const MEDIA_URL = 'https://cdn.example.com/live/index.m3u8';
  const hls = (url = MEDIA_URL) => parsed(url).candidate;
  const playlist = (...lines) => `#EXTM3U\n${lines.join('\n')}\n`;
  const segments = (first, count, name = (n) => `seg${n}.ts`) =>
    Array.from({ length: count }, (_, i) => `#EXTINF:6.0,\n${name(first + i)}`).join('\n');

  /** Serves each URL's bodies in order (the last one repeats), records requests and waits, never sleeps. */
  function playlistServer(routes) {
    const requests = [];
    const delays = [];
    return {
      requests,
      delays,
      fetch: async (url, init) => {
        requests.push({ url, init });
        const bodies = routes[url] ?? [];
        const body = bodies[Math.min(requests.filter((request) => request.url === url).length, bodies.length) - 1];
        if (body === undefined) return { ok: false, status: 404, url, text: async () => '' };
        return { ok: true, status: 200, url, text: async () => body };
      },
      delay: async (ms, signal) => {
        assert.equal(signal, requests[0].init.signal, 'the wait honours the probe deadline signal');
        delays.push(ms);
      },
    };
  }

  it('reads a frozen playlist as not live, even with PROGRAM-DATE-TIME, PLAYLIST-TYPE:EVENT, or EXTINF alone', async () => {
    const frozenBodies = [
      playlist('#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:120', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z', segments(120, 3)),
      playlist('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-TARGETDURATION:6', segments(0, 3)),
      // Fail-closed live tags: EXTINF without ENDLIST is not enough — ended
      // playlists often omit ENDLIST and would otherwise green-pass.
      playlist('#EXT-X-TARGETDURATION:6', segments(0, 1)),
    ];
    for (const frozen of frozenBodies) {
      const server = playlistServer({ [MEDIA_URL]: [frozen] });
      const { verdict } = await probeHlsCandidate(hls(), server);
      assert.equal(verdict.verdict, 'failed');
      assert.equal(verdict.outcome.kind, 'hls-fatal');
      assert.match(verdict.outcome.detail, /^media playlist did not advance in 9 s$/);
      assert.deepEqual(server.requests.map((request) => request.url), [MEDIA_URL, MEDIA_URL, MEDIA_URL]);
      assert.deepEqual(server.delays, [6_000, 3_000]);
    }
  });

  it('reads a frozen playlist as not live when its CDN rotates a segment URL token on every request', async () => {
    const tokened = (token) => playlist('#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:120', segments(120, 3, (n) => `seg${n}.ts?token=${token}`));
    const server = playlistServer({ [MEDIA_URL]: [tokened('a1'), tokened('b2'), tokened('c3')] });
    const { verdict } = await probeHlsCandidate(hls(), server);
    assert.equal(verdict.verdict, 'failed');
    assert.match(verdict.outcome.detail, /^media playlist did not advance in 9 s$/);
  });

  it('reloads once more after an unchanged playlist instead of calling it frozen', async () => {
    const media = (sequence) => playlist('#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${sequence}`, segments(sequence, 3));
    const server = playlistServer({ [MEDIA_URL]: [media(10), media(10), media(11)] });
    const { verdict } = await probeHlsCandidate(hls(), server);
    assert.deepEqual(verdict, { verdict: 'live', video: null });
    assert.deepEqual(server.requests.map((request) => request.url), [MEDIA_URL, MEDIA_URL, MEDIA_URL]);
    assert.deepEqual(server.delays, [6_000, 3_000]);
  });

  it('calls a playlist frozen only after a second unchanged reload', async () => {
    const media = playlist('#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:10', segments(10, 3));
    const server = playlistServer({ [MEDIA_URL]: [media, media, media] });
    const { verdict } = await probeHlsCandidate(hls(), server);
    assert.equal(verdict.verdict, 'failed');
    assert.equal(verdict.outcome.kind, 'hls-fatal');
    assert.match(verdict.outcome.detail, /^media playlist did not advance in 9 s$/);
    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.delays, [6_000, 3_000]);
  });

  it('reads a deadline-clipped lone reload as unverifiable rather than frozen', async () => {
    const server = playlistServer({ [MEDIA_URL]: [playlist('#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:5', segments(5, 2))] });
    let clock = 0;
    const { verdict } = await probeHlsCandidate(hls(), {
      ...server,
      now: () => clock,
      fetch: async (url, init) => {
        clock += 12_000;
        return server.fetch(url, init);
      },
    });
    assert.deepEqual(verdict, { verdict: 'failed', outcome: { kind: 'timeout' } });
    assert.deepEqual(server.delays, [LIVE_VIDEO_TIMING.verdictDeadlineMs - 12_000]);
  });

  it('reports the probe deadline as a timeout and a connect failure by its error code', async () => {
    const timedOut = await probeHlsCandidate(hls(), {
      fetch: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
    });
    assert.deepEqual(timedOut.verdict, { verdict: 'failed', outcome: { kind: 'timeout' } });

    const unreachable = await probeHlsCandidate(hls(), {
      fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); },
    });
    assert.equal(unreachable.verdict.outcome.kind, 'hls-fatal');
    assert.equal(unreachable.verdict.outcome.detail, 'UND_ERR_CONNECT_TIMEOUT');
  });

  it('reads a playlist without PROGRAM-DATE-TIME as live once its media sequence advances', async () => {
    const wowza = (sequence) => playlist('#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${sequence}`, segments(sequence, 3, (n) => `media_w1052_${n}.ts`));
    const server = playlistServer({ [MEDIA_URL]: [wowza(43770), wowza(43794)] });
    const { verdict } = await probeHlsCandidate(hls(), server);
    assert.deepEqual(verdict, { verdict: 'live', video: null });
    assert.deepEqual(server.delays, [4_000]);
  });

  it('reads an EVENT playlist as live when it grows', async () => {
    const event = (count) => playlist('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', segments(0, count));
    const server = playlistServer({ [MEDIA_URL]: [event(2), event(3)] });
    assert.deepEqual((await probeHlsCandidate(hls(), server)).verdict, { verdict: 'live', video: null });
  });

  it('reads ENDLIST and VOD playlists as recordings from one fetch', async () => {
    for (const ended of [playlist('#EXT-X-TARGETDURATION:6', segments(0, 2), '#EXT-X-ENDLIST'), playlist('#EXT-X-PLAYLIST-TYPE:VOD', segments(0, 2))]) {
      const server = playlistServer({ [MEDIA_URL]: [ended] });
      assert.deepEqual((await probeHlsCandidate(hls(), server)).verdict, { verdict: 'recording', video: null });
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.delays, []);
    }
  });

  it('matches HLS tags as whole lines', async () => {
    const nearLive = playlist('#EXT-X-PLAYLIST-TYPE:EVENTUAL', '#EXT-X-PROGRAM-DATE-TIMEX:2026-09-15T00:00:00.000Z', '#EXT-X-TARGETDURATION:6', segments(0, 2));
    const frozen = await probeHlsCandidate(hls(), playlistServer({ [MEDIA_URL]: [nearLive] }));
    assert.equal(frozen.verdict.verdict, 'failed');
    assert.match(frozen.verdict.outcome.detail, /did not advance/);

    const nearEnded = (first) => playlist('#EXT-X-PLAYLIST-TYPE:VODX', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${first}`, segments(first, 2), '#EXT-X-ENDLISTX');
    const advancing = await probeHlsCandidate(hls(), playlistServer({ [MEDIA_URL]: [nearEnded(0), nearEnded(1)] }));
    assert.deepEqual(advancing.verdict, { verdict: 'live', video: null });
  });

  it('follows the first variant of a master playlist and reloads that variant', async () => {
    const master = 'https://cdn.example.com/live/master.m3u8';
    const variant = 'https://cdn.example.com/live/low/index.m3u8';
    const media = (sequence) => playlist('#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${sequence}`, segments(sequence, 3));
    const server = playlistServer({
      [master]: [playlist('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2400000', 'high/index.m3u8')],
      [variant]: [media(10), media(11)],
    });
    assert.deepEqual((await probeHlsCandidate(hls(master), server)).verdict, { verdict: 'live', video: null });
    assert.deepEqual(server.requests.map((request) => request.url), [master, variant, variant]);
    for (const request of server.requests) {
      assert.match(request.init.headers['user-agent'], /^Mozilla\//);
      assert.equal(request.init.redirect, 'manual');
    }
  });

  it('rejects an HTTP variant without fetching it', async () => {
    const master = 'https://cdn.example.com/live/master.m3u8';
    const httpVariant = 'http://cdn.example.com/live/low/index.m3u8';
    const requests = [];
    const { verdict } = await probeHlsCandidate(hls(master), {
      fetch: async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        return {
          ok: true,
          status: 200,
          url,
          text: async () => playlist('#EXT-X-STREAM-INF:BANDWIDTH=800000', httpVariant),
        };
      },
    });
    assert.equal(verdict.verdict, 'failed');
    assert.equal(verdict.outcome.kind, 'hls-fatal');
    assert.match(verdict.outcome.detail, /https/);
    assert.deepEqual(requests, [master]);
  });

  it('rejects an HTTPS-to-HTTP redirect without fetching the HTTP URL', async () => {
    const httpsUrl = MEDIA_URL;
    const httpUrl = 'http://cdn.example.com/live/index.m3u8';
    const requests = [];
    const { verdict } = await probeHlsCandidate(hls(httpsUrl), {
      fetch: async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        return {
          ok: false,
          status: 302,
          url,
          headers: { get: (name) => (name.toLowerCase() === 'location' ? httpUrl : null) },
          text: async () => '',
        };
      },
    });
    assert.equal(verdict.verdict, 'failed');
    assert.equal(verdict.outcome.kind, 'hls-fatal');
    assert.match(verdict.outcome.detail, /https/);
    assert.deepEqual(requests, [httpsUrl]);
  });

  it('follows an HTTPS redirect and reloads the final playlist', async () => {
    const front = 'https://cdn.example.com/live/front.m3u8';
    const dest = MEDIA_URL;
    const media = (sequence) => playlist('#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${sequence}`, segments(sequence, 3));
    const requests = [];
    const destBodies = [media(10), media(11)];
    const { verdict } = await probeHlsCandidate(hls(front), {
      fetch: async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        if (url === front) {
          return {
            ok: false,
            status: 302,
            url,
            headers: { get: (name) => (name.toLowerCase() === 'location' ? dest : null) },
            text: async () => '',
          };
        }
        const body = destBodies[Math.min(requests.filter((seen) => seen === dest).length, destBodies.length) - 1];
        return { ok: true, status: 200, url, text: async () => body };
      },
      delay: async () => {},
    });
    assert.deepEqual(verdict, { verdict: 'live', video: null });
    assert.deepEqual(requests, [front, dest, dest]);
  });

  it('names what is wrong with a body that cannot be live', async () => {
    const detail = async (body) => (await probeHlsCandidate(hls(), playlistServer({ [MEDIA_URL]: [body] }))).verdict.outcome.detail;
    assert.match(await detail('<html>blocked</html>'), /^not an HLS playlist/);
    assert.match(await detail(playlist('#EXT-X-STREAM-INF:BANDWIDTH=800000')), /^master playlist lists no variant/);
    assert.match(await detail(playlist('#EXT-X-TARGETDURATION:6')), /^media playlist has no segments/);
  });

  it('waits one target duration, then half of it, clamped to 1-10 s and to the time left before the deadline', async () => {
    const frozen = (...tags) => playlist(...tags, '#EXT-X-MEDIA-SEQUENCE:5', segments(5, 2));
    const waitFor = async (body, fetchMs) => {
      const server = playlistServer({ [MEDIA_URL]: [body] });
      let clock = 0;
      await probeHlsCandidate(hls(), {
        ...server,
        now: () => clock,
        fetch: async (url, init) => {
          clock += fetchMs;
          return server.fetch(url, init);
        },
      });
      return server.delays;
    };
    assert.deepEqual(await waitFor(frozen('#EXT-X-TARGETDURATION:30'), 1_000), [10_000, 5_000]);
    assert.deepEqual(await waitFor(frozen('#EXT-X-TARGETDURATION:0'), 1_000), [1_000, 500]);
    assert.deepEqual(await waitFor(frozen(), 1_000), [6_000, 3_000]);
    // A 12 s first fetch leaves no room for the second look, so the lone wait is all there is.
    assert.deepEqual(await waitFor(frozen('#EXT-X-TARGETDURATION:6'), 12_000), [LIVE_VIDEO_TIMING.verdictDeadlineMs - 12_000]);
  });
});

describe('runCheck', () => {
  it('prints one block per entry and exits 1 when any entry is not live', async () => {
    const out = [];
    const code = await runCheck(['jerusalem=zp6LNSoq000', 'kyiv=-Q7FuPINDjA', 'cnn=@CNN', 'aje=https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8'], {
      write: (line) => out.push(line),
      probeYouTube: async (candidates) => candidates.map((candidate) => (candidate.videoId === 'zp6LNSoq000'
        ? { verdict: { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives' } } }
        : { verdict: { verdict: 'recording', video: { videoId: '-Q7FuPINDjA', isLive: false, title: 'Kyiv', author: 'DW News' } }, durationSeconds: 24_181 })),
      probeHls: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
    });
    const text = out.join('\n');
    assert.equal(code, 1);
    assert.match(text, /^LIVE\s+jerusalem/m);
    assert.match(text, /^RECORDING\s+kyiv/m);
    assert.match(text, /^INVALID\s+cnn/m);
    assert.match(text, /^LIVE\s+aje/m);
    assert.match(text, /^2 of 4 entries are not live\.$/m);
  });

  it('calls a live HLS playlist live from Node once it advances', async () => {
    const advancing = [
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nseg0.ts\n',
      '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n',
    ];
    let fetches = 0;
    const fetchImpl = async () => {
      const body = advancing[Math.min(fetches++, advancing.length - 1)];
      return {
        ok: true,
        status: 200,
        url: 'https://hls.test/live.m3u8',
        text: async () => body,
      };
    };
    assert.deepEqual(
      await probeHlsCandidates([{ kind: 'hls', url: 'https://hls.test/live.m3u8' }], fetchImpl),
      [{ verdict: { verdict: 'live', video: null } }],
    );
    fetches = 0;
    const out = [];
    const code = await runCheck(['aje=https://hls.test/live.m3u8'], {
      write: (line) => out.push(line),
      probeYouTube: async () => { throw new Error('no YouTube entries were given'); },
      probeHls: (candidates) => probeHlsCandidates(candidates, fetchImpl),
    });
    const text = out.join('\n');
    assert.equal(code, 0, text);
    assert.match(text, /^LIVE\s+aje/m);
    assert.match(text, /why: HLS playlist is live \(it advanced between reloads\)$/m);
  });

  it('exits 0 when every entry is live and never launches a probe for an empty group', async () => {
    const code = await runCheck(['zp6LNSoq000'], {
      write: () => {},
      probeYouTube: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
      probeHls: async () => { throw new Error('no HLS entries were given'); },
    });
    assert.equal(code, 0);
  });

  it('prints usage and exits 2 on bad arguments', async () => {
    const out = [];
    assert.equal(await runCheck([], { write: (line) => out.push(line) }), 2);
    assert.match(out.join('\n'), /Usage/);
  });
});

describe('slotStatus', () => {
  const live = { verdict: 'live', unverifiableFromRunner: false };
  const dead = { verdict: 'failed', unverifiableFromRunner: false };
  const geo = { verdict: 'failed', unverifiableFromRunner: true };

  it('names what a slot needs from its attempts in try order', () => {
    assert.equal(slotStatus([]), 'empty');
    assert.equal(slotStatus([live, dead]), 'ok');
    assert.equal(slotStatus([dead, live]), 'degraded');
    assert.equal(slotStatus([dead, dead]), 'needs-replacement');
  });

  it('never counts an attempt the runner could not verify as a failure, and never lets it hide a dead entry ahead of it', () => {
    assert.equal(slotStatus([geo, live]), 'ok');
    assert.equal(slotStatus([geo, dead, live]), 'degraded');
    assert.equal(slotStatus([geo]), 'unverifiable-from-runner');
    assert.equal(slotStatus([geo, dead]), 'degraded');
    assert.equal(slotStatus([dead, geo]), 'degraded');
    assert.equal(slotStatus([dead, dead, geo]), 'degraded');
  });
});

describe('audit report (--all --report)', () => {
  const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
  const BLOOMBERG_HLS = 'https://bloomberg.com/media-manifest/streams/us.m3u8';
  const BBC_HLS = 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/iptv_hd_abr_v1.m3u8';
  const CANARY = 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg';
  const catalog = {
    webcams: {
      jerusalem: [watch('zp6LNSoq000')],
      'middle-east': [],
      kyiv: [watch('e2gC37ILQmk'), watch('VGnFLdQW39A')],
      washington: [watch('oDCAAfOSqvA')],
      taipei: [watch('z_fY1pj1VBw')],
      tokyo: [watch('_k-5U7IeK8g')],
      sydney: [watch('5uZa3-RMFos')],
    },
    gridPriority: ['jerusalem', 'middle-east', 'kyiv', 'washington', 'taipei', 'tokyo'],
    news: {
      bloomberg: [BLOOMBERG_HLS, watch('QB5BNdBFujE')],
      'bbc-news': [BBC_HLS],
      yahoo: [watch('KQp-e_XQnDE')],
      rtve: [],
    },
    canaries: [CANARY],
  };
  const surfaces = {
    webcamFeeds: [
      { id: 'jerusalem', region: 'middle-east' },
      { id: 'middle-east', region: 'middle-east' },
      { id: 'kyiv', region: 'europe' },
      { id: 'washington', region: 'americas' },
      { id: 'taipei', region: 'asia' },
      { id: 'tokyo', region: 'asia' },
      { id: 'sydney', region: 'asia' },
    ],
    gridCells: 4,
    newsDefaults: { full: ['bloomberg'], tech: ['bloomberg', 'yahoo'] },
    newsOptional: ['bloomberg', 'yahoo', 'bbc-news', 'rtve'],
  };
  const live = (videoId, title = 'Live cam', author = 'Cams') => ({
    verdict: { verdict: 'live', video: { videoId, isLive: true, title, author } },
    durationSeconds: 90_000,
    verdictAtMs: 2_100,
  });
  const youtubeVerdicts = {
    zp6LNSoq000: { verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } }, durationSeconds: null, verdictAtMs: 1_200 },
    e2gC37ILQmk: {
      verdict: { verdict: 'recording', video: { videoId: 'e2gC37ILQmk', isLive: false, title: 'LIVE: View of Kyiv', author: 'DW News' } },
      durationSeconds: 24_181,
      verdictAtMs: 8_400,
    },
    'KQp-e_XQnDE': { verdict: { verdict: 'unverifiable', reason: 'player-api-silent' }, durationSeconds: null, verdictAtMs: 15_000 },
  };
  const probeYouTube = async (candidates) => candidates.map((candidate) => (candidate.kind === 'channel'
    ? live('gCNeDWCI0vo', 'Al Jazeera English - Live', 'Al Jazeera English')
    : youtubeVerdicts[candidate.videoId] ?? live(candidate.videoId)));
  const probeHls = async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status: 403 } } }));

  async function audit(argv, overrides = {}) {
    const lines = [];
    const writes = [];
    const code = await runCheck(argv, {
      write: (line) => lines.push(line),
      catalog,
      surfaces,
      probeYouTube,
      probeHls,
      now: () => new Date('2026-09-15T05:17:00.000Z'),
      writeReport: (path, text) => writes.push({ path, report: JSON.parse(text) }),
      ...overrides,
    });
    return { code, lines, writes };
  }

  it('writes the report without changing the human output or the exit code', async () => {
    const plain = await audit(['--all']);
    const reported = await audit(['--all', '--report', 'audit.json']);
    assert.equal(plain.code, 1);
    assert.equal(reported.code, plain.code);
    assert.deepEqual(reported.lines, plain.lines);
    assert.deepEqual(plain.writes, []);
    assert.equal(reported.writes.length, 1);
    assert.equal(reported.writes[0].path, 'audit.json');
    assert.equal(reported.writes[0].report.checkedAt, '2026-09-15T05:17:00.000Z');
  });

  it('places each slot where customers see it and names the slot shown in its place', async () => {
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json']);
    assert.deepEqual(report.slots.map((slot) => [slot.slot, slot.surface, slot.shownByDefault, slot.status, slot.shownInstead]), [
      ['webcams/jerusalem', 'Webcam grid cell 1', true, 'needs-replacement', 'webcams/taipei'],
      ['webcams/middle-east', 'Webcam grid cell 2', true, 'empty', 'webcams/tokyo'],
      ['webcams/kyiv', 'Webcam grid cell 3', true, 'degraded', null],
      ['webcams/washington', 'Webcam grid cell 4', true, 'ok', null],
      ['webcams/taipei', 'Webcam grid cell 1', true, 'ok', null],
      ['webcams/tokyo', 'Webcam grid cell 2', true, 'ok', null],
      ['webcams/sydney', 'Webcam (Asia)', false, 'ok', null],
      ['live-news/bloomberg', 'Live News default (full, tech)', true, 'ok', null],
      ['live-news/bbc-news', 'Live News optional', false, 'unverifiable-from-runner', null],
      ['live-news/yahoo', 'Live News default (tech)', true, 'needs-replacement', null],
      ['live-news/rtve', 'Live News optional', false, 'empty', null],
    ]);
  });

  it('keeps a wall slot with no spare left in its cell with nothing shown instead', async () => {
    const thin = { ...catalog, webcams: { ...catalog.webcams, taipei: [], tokyo: [] } };
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: thin });
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));
    assert.equal(bySlot.get('webcams/jerusalem').shownInstead, null);
    assert.equal(bySlot.get('webcams/middle-east').shownInstead, null);
    assert.equal(bySlot.get('webcams/taipei').surface, 'Webcam (Asia)');
    assert.equal(bySlot.get('webcams/taipei').shownByDefault, false);
  });

  it('records every attempt in try order with its verdict and evidence', async () => {
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json']);
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));

    const [jerusalem] = bySlot.get('webcams/jerusalem').attempts;
    assert.equal(jerusalem.entry, watch('zp6LNSoq000'));
    assert.equal(jerusalem.kind, 'video');
    assert.equal(jerusalem.verdict, 'failed');
    assert.equal(jerusalem.unverifiableFromRunner, false);
    assert.match(jerusalem.why, /YouTube player error 150/);
    assert.equal(jerusalem.evidence.errorCode, 150);
    assert.equal(jerusalem.evidence.verdictAtMs, 1_200);

    const [recording, backup] = bySlot.get('webcams/kyiv').attempts;
    assert.equal(recording.verdict, 'recording');
    assert.match(recording.why, /ended recording \(isLive=false, duration 24,181 s\)/);
    assert.deepEqual(
      [recording.evidence.title, recording.evidence.author, recording.evidence.isLive, recording.evidence.durationSeconds],
      ['LIVE: View of Kyiv', 'DW News', false, 24_181],
    );
    assert.equal(backup.verdict, 'live');

    const [geo] = bySlot.get('live-news/bbc-news').attempts;
    assert.equal(geo.kind, 'hls');
    assert.equal(geo.unverifiableFromRunner, true);
    assert.equal(geo.evidence.httpStatus, 403);

    const [silent] = bySlot.get('live-news/yahoo').attempts;
    assert.equal(silent.verdict, 'unverifiable');
    assert.equal(silent.unverifiableFromRunner, false, 'still never ready in two checks alone while the canaries play');
    assert.equal(silent.why, 'the player never became ready, in the batch or in two checks alone');
    assert.deepEqual([silent.evidence.aloneChecks, silent.evidence.recheckSkipped], [2, false]);
    assert.deepEqual([jerusalem.evidence.aloneChecks, jerusalem.evidence.recheckSkipped], [0, false]);

    assert.deepEqual(bySlot.get('live-news/rtve').attempts, []);
    assert.deepEqual(report.canaries.map((canary) => [canary.entry, canary.kind, canary.verdict, canary.evidence.author]), [
      [CANARY, 'channel', 'live', 'Al Jazeera English'],
    ]);
  });

  it('counts a catalog entry that does not parse as dead, never as unverifiable from the runner', async () => {
    const typo = 'not-a-stream-url';
    const badCatalog = {
      webcams: {},
      gridPriority: [],
      news: { bloomberg: [typo], yahoo: [typo, watch('QB5BNdBFujE')] },
      canaries: [CANARY],
    };
    const { lines, writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: badCatalog });
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));

    const alone = bySlot.get('live-news/bloomberg');
    assert.deepEqual(
      [alone.attempts[0].verdict, alone.attempts[0].kind, alone.attempts[0].unverifiableFromRunner, alone.status],
      ['invalid', null, false, 'needs-replacement'],
      'a typo in the catalog must reach the issue, not pass as runner-dependent',
    );
    assert.match(alone.attempts[0].why, /not a YouTube video or channel URL, a video ID, or an https \.m3u8 URL/);

    const withBackup = bySlot.get('live-news/yahoo');
    assert.deepEqual([withBackup.attempts[1].verdict, withBackup.status], ['live', 'degraded']);
    assert.match(lines.join('\n'), /^INVALID\s+live-news\/bloomberg/m);
  });

  it('counts an HLS connection or runner-side TLS failure as unverifiable from the runner, and a stream that is gone as dead', async () => {
    const hlsOnly = { webcams: {}, gridPriority: [], news: { bloomberg: [BLOOMBERG_HLS] }, canaries: [CANARY] };
    const failWith = (detail) => async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-fatal', detail } } }));
    const cases = [
      // Slow, dropped or unreachable from this network.
      ['UND_ERR_CONNECT_TIMEOUT', true],
      ['UND_ERR_HEADERS_TIMEOUT', true],
      ['UND_ERR_BODY_TIMEOUT', true],
      ['ETIMEDOUT', true],
      ['EAI_AGAIN', true],
      ['ECONNRESET', true],
      ['UND_ERR_SOCKET', true],
      ['EPIPE', true],
      ['ENETUNREACH', true],
      ['EHOSTUNREACH', true],
      // Chains Node cannot complete without fetching an intermediate, which Chrome does.
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', true],
      ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', true],
      ['SELF_SIGNED_CERT_IN_CHAIN', true],
      // Gone or broken for viewers too.
      ['ENOTFOUND', false],
      ['ECONNREFUSED', false],
      ['CERT_HAS_EXPIRED', false],
      ['not an HLS media playlist', false],
    ];
    for (const [detail, unverifiable] of cases) {
      const { lines, writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: hlsOnly, probeHls: failWith(detail) });
      const [slot] = report.slots;
      assert.equal(slot.attempts[0].unverifiableFromRunner, unverifiable, detail);
      assert.equal(slot.status, unverifiable ? 'unverifiable-from-runner' : 'needs-replacement', detail);
      assert.deepEqual([slot.attempts[0].why, slot.attempts[0].evidence.detail], ['stream failed', detail], 'the report keeps fetch text out of why');
      assert.ok(lines.join('\n').includes(`why: stream failed: ${detail}`), 'the terminal still shows the detail');
    }
  });

  it('counts an HLS rate limit, origin error or region block as unverifiable from the runner, and a missing playlist as dead', async () => {
    const hlsOnly = { webcams: {}, gridPriority: [], news: { bloomberg: [BLOOMBERG_HLS] }, canaries: [CANARY] };
    const answer = (status) => async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status } } }));
    const cases = [[403, true], [451, true], [429, true], [500, true], [502, true], [503, true], [504, true], [400, false], [404, false], [410, false]];
    for (const [status, unverifiable] of cases) {
      const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: hlsOnly, probeHls: answer(status) });
      const [slot] = report.slots;
      assert.equal(slot.attempts[0].unverifiableFromRunner, unverifiable, `HTTP ${status}`);
      assert.equal(slot.status, unverifiable ? 'unverifiable-from-runner' : 'needs-replacement', `HTTP ${status}`);
    }

    const withBackup = { ...hlsOnly, news: { bloomberg: [BLOOMBERG_HLS, watch('QB5BNdBFujE')] } };
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: withBackup, probeHls: answer(503) });
    assert.equal(report.slots[0].status, 'ok', 'an origin error on the first entry does not file a degraded default slot');
  });

  it('counts a stream that never started, or a player never ready even alone, as dead; a missing live signal or blocked API stays unverifiable', async () => {
    const videoOnly = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const cases = [
      [{ verdict: 'failed', outcome: { kind: 'not-started' } }, false, 'needs-replacement', /scheduled or not started/],
      [{ verdict: 'unverifiable', reason: 'live-signal-missing' }, true, 'unverifiable-from-runner', /isLive missing/],
      [{ verdict: 'unverifiable', reason: 'player-api-silent' }, false, 'needs-replacement', /never became ready, in the batch or in two checks alone/],
      [{ verdict: 'unverifiable', reason: 'player-api-blocked' }, true, 'unverifiable-from-runner', /IFrame API did not load/],
    ];
    for (const [verdict, unverifiable, status, why] of cases) {
      const label = verdict.outcome?.kind ?? verdict.reason;
      const probeYouTube = async (candidates) => candidates.map((candidate) => (candidate.kind === 'channel'
        ? live('gCNeDWCI0vo')
        : { verdict, durationSeconds: null, verdictAtMs: 15_000 }));
      const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: videoOnly, probeYouTube });
      const [slot] = report.slots;
      assert.equal(slot.attempts[0].unverifiableFromRunner, unverifiable, label);
      assert.equal(slot.status, status, label);
      assert.match(slot.attempts[0].why, why, label);
    }
  });

  const SECOND_CANARY = 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg';
  const silentVerdict = { verdict: { verdict: 'unverifiable', reason: 'player-api-silent' }, durationSeconds: null, verdictAtMs: 15_000 };
  const timeoutVerdict = { verdict: { verdict: 'failed', outcome: { kind: 'timeout' } }, durationSeconds: null, verdictAtMs: null };
  const notStartedVerdict = { verdict: { verdict: 'failed', outcome: { kind: 'not-started' } }, durationSeconds: null, verdictAtMs: 15_000 };
  const idOf = (candidate) => candidate.videoId ?? candidate.channelId;
  /** An injected YouTube probe that records each call: the ids it got, in order, and its batch size. */
  function recordingProbe(verdictFor) {
    const calls = [];
    const probeYouTube = async (candidates, options = {}) => {
      calls.push({ ids: candidates.map(idOf), batchSize: options.batchSize ?? null });
      return candidates.map((candidate) => verdictFor(candidate, calls.length));
    };
    return { calls, probeYouTube };
  }

  it('probes the canaries in their own call before any slot entry', async () => {
    const catalog = {
      webcams: { taipei: [watch('z_fY1pj1VBw')] },
      gridPriority: ['taipei'],
      news: { bloomberg: [watch('QB5BNdBFujE'), 'https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'] },
      canaries: [CANARY, SECOND_CANARY],
    };
    const { calls, probeYouTube } = recordingProbe((candidate) => live(candidate.videoId ?? 'gCNeDWCI0vo'));
    await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    assert.deepEqual(calls, [
      { ids: ['UCNye-wNBqNL5ZzHSJj3l8Bg', 'UCknLrEdhRCp1aegoMqRaCZg'], batchSize: null },
      { ids: ['z_fY1pj1VBw', 'QB5BNdBFujE', 'UCIALMKvObZNtJ6AmdCLP7Lg'], batchSize: null },
    ]);
  });

  it('uses the verdict of a player re-checked alone when it never became ready in the batch', async () => {
    const catalog = { webcams: { taipei: [watch('z_fY1pj1VBw')] }, gridPriority: ['taipei'], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const { calls, probeYouTube } = recordingProbe((candidate, call) => (candidate.videoId === 'QB5BNdBFujE' && call === 2
      ? silentVerdict
      : live(candidate.videoId ?? 'gCNeDWCI0vo')));
    const { lines, writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    assert.deepEqual(calls.slice(2), [{ ids: ['QB5BNdBFujE'], batchSize: 1 }]);
    const bySlot = new Map(report.slots.map((slot) => [slot.slot, slot]));
    const [bloomberg] = bySlot.get('live-news/bloomberg').attempts;
    assert.equal(bySlot.get('live-news/bloomberg').status, 'ok');
    assert.deepEqual([bloomberg.verdict, bloomberg.evidence.aloneChecks], ['live', 1]);
    assert.equal(bySlot.get('webcams/taipei').attempts[0].evidence.aloneChecks, 0);
    assert.match(lines.join('\n'), /^LIVE\s+live-news\/bloomberg/m);
  });

  it('uses the second alone check when the first alone check stalls too', async () => {
    const catalog = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const { calls, probeYouTube } = recordingProbe((candidate, call) => {
      if (candidate.kind === 'channel') return live('gCNeDWCI0vo');
      return call === 4 ? live('QB5BNdBFujE') : silentVerdict;
    });
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    assert.deepEqual(calls.slice(2), [{ ids: ['QB5BNdBFujE'], batchSize: 1 }, { ids: ['QB5BNdBFujE'], batchSize: 1 }]);
    const [slot] = report.slots;
    assert.equal(slot.status, 'ok');
    assert.deepEqual([slot.attempts[0].verdict, slot.attempts[0].evidence.aloneChecks, slot.attempts[0].evidence.recheckSkipped], ['live', 2, false]);
  });

  it('counts a player that stalls in the batch and in two checks alone as dead while the canaries play; a missing live signal is not re-checked', async () => {
    const catalog = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')], yahoo: [watch('KQp-e_XQnDE')] }, canaries: [CANARY] };
    const { calls, probeYouTube } = recordingProbe((candidate) => {
      if (candidate.kind === 'channel') return live('gCNeDWCI0vo');
      if (candidate.videoId === 'KQp-e_XQnDE') return { verdict: { verdict: 'unverifiable', reason: 'live-signal-missing' }, durationSeconds: null, verdictAtMs: 15_000 };
      return silentVerdict;
    });
    const { lines, writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    assert.deepEqual(calls.slice(2), [{ ids: ['QB5BNdBFujE'], batchSize: 1 }, { ids: ['QB5BNdBFujE'], batchSize: 1 }]);
    const [bloomberg, yahoo] = report.slots;
    assert.equal(bloomberg.status, 'needs-replacement');
    assert.deepEqual(
      [bloomberg.attempts[0].verdict, bloomberg.attempts[0].unverifiableFromRunner, bloomberg.attempts[0].why, bloomberg.attempts[0].evidence.aloneChecks],
      ['unverifiable', false, 'the player never became ready, in the batch or in two checks alone', 2],
    );
    assert.equal(yahoo.status, 'unverifiable-from-runner');
    assert.equal(yahoo.attempts[0].evidence.aloneChecks, 0);
    assert.match(lines.join('\n'), /why: the player never became ready, in the batch or in two checks alone/);
  });

  it('skips the re-check and keeps a never-ready player unverifiable when no canary plays', async () => {
    const catalog = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const { calls, probeYouTube } = recordingProbe(() => silentVerdict);
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    // First canary pass (no live) + slot batch + one canary retry.
    assert.equal(calls.length, 3);
    const [slot] = report.slots;
    assert.equal(slot.status, 'unverifiable-from-runner');
    assert.deepEqual(
      [slot.attempts[0].unverifiableFromRunner, slot.attempts[0].evidence.aloneChecks, slot.attempts[0].evidence.recheckSkipped, slot.attempts[0].why],
      [true, 0, false, 'the player frame loaded but never became ready'],
    );
    assert.equal(report.canaries[0].verdict, 'unverifiable');
  });

  it('retries canaries once before alone rechecks so a flaky first canary pass still re-checks stalls', async () => {
    const catalog = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const { calls, probeYouTube } = recordingProbe((candidate, call) => {
      if (candidate.kind === 'channel') return call === 1 ? silentVerdict : live('gCNeDWCI0vo');
      return call === 4 ? live('QB5BNdBFujE') : silentVerdict;
    });
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
    assert.deepEqual(calls.map((call) => call.ids), [
      ['UCNye-wNBqNL5ZzHSJj3l8Bg'],
      ['QB5BNdBFujE'],
      ['UCNye-wNBqNL5ZzHSJj3l8Bg'],
      ['QB5BNdBFujE'],
    ]);
    const [slot] = report.slots;
    assert.equal(slot.status, 'ok');
    assert.deepEqual(
      [slot.attempts[0].verdict, slot.attempts[0].evidence.aloneChecks, slot.attempts[0].unverifiableFromRunner],
      ['live', 1, false],
    );
    assert.equal(report.canaries[0].verdict, 'live');
  });

  it('re-checks every YouTube stall alone: plays alone is ok, stalls in both alone checks is dead, no live canary leaves it unverifiable', async () => {
    const catalog = { webcams: {}, gridPriority: [], news: { bloomberg: [watch('QB5BNdBFujE')] }, canaries: [CANARY] };
    const stalls = [
      ['player-api-silent', silentVerdict, 'the player never became ready, in the batch or in two checks alone'],
      ['timeout', timeoutVerdict, 'no verdict within 15 s, in the batch or in two checks alone'],
      ['not-started', notStartedVerdict, 'scheduled or not started: YouTube lists it as live but it did not play within 15 s, in the batch or in two checks alone'],
    ];
    const run = async (verdictFor) => {
      const { calls, probeYouTube } = recordingProbe(verdictFor);
      const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube });
      return { calls, status: report.slots[0].status, attempt: report.slots[0].attempts[0] };
    };
    const canaryLive = (candidate) => (candidate.kind === 'channel' ? live('gCNeDWCI0vo') : null);
    for (const [kind, stall, deadWhy] of stalls) {
      const playsAlone = await run((candidate, call) => canaryLive(candidate) ?? (call === 3 ? live('QB5BNdBFujE') : stall));
      assert.deepEqual([playsAlone.status, playsAlone.attempt.verdict, playsAlone.attempt.evidence.aloneChecks], ['ok', 'live', 1], `${kind}: plays alone`);

      const stallsAlone = await run((candidate) => canaryLive(candidate) ?? stall);
      assert.equal(stallsAlone.calls.length, 4, `${kind}: the canary page, the batch and two alone checks`);
      assert.deepEqual(
        [stallsAlone.status, stallsAlone.attempt.why, stallsAlone.attempt.unverifiableFromRunner],
        ['needs-replacement', deadWhy, false],
        `${kind}: stalls alone`,
      );

      const noCanary = await run(() => stall);
      // First canary pass (no live) + slot batch + one canary retry; still no alone check.
      assert.equal(noCanary.calls.length, 3, `${kind}: no alone check without a live canary`);
      assert.deepEqual([noCanary.status, noCanary.attempt.unverifiableFromRunner], ['unverifiable-from-runner', true], `${kind}: no live canary`);
    }
  });

  it('stops checking alone once the audit time budget is used up, and leaves the rest unverifiable', async () => {
    const catalog = {
      webcams: {},
      gridPriority: [],
      news: { bloomberg: [watch('QB5BNdBFujE')], yahoo: [watch('KQp-e_XQnDE')], rtve: [watch('-xzg3wujOVM')] },
      canaries: [CANARY],
    };
    // Each alone check takes half the budget, so two run and nothing fits after them. Every kind of stall shares the budget.
    let nowMs = 0;
    const stallFor = { QB5BNdBFujE: silentVerdict, 'KQp-e_XQnDE': timeoutVerdict, '-xzg3wujOVM': notStartedVerdict };
    const { calls, probeYouTube } = recordingProbe((candidate, call) => {
      if (call > 2) nowMs += ALONE_RECHECK_BUDGET_MS / 2;
      return candidate.kind === 'channel' ? live('gCNeDWCI0vo') : stallFor[candidate.videoId];
    });
    const { lines, writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog, probeYouTube, clock: () => nowMs });
    assert.deepEqual(calls.slice(2).map((call) => call.ids), [['QB5BNdBFujE'], ['KQp-e_XQnDE']]);
    const once = 'checked alone once, second check skipped: audit time budget used up';
    const never = 'not re-checked: audit time budget used up';
    assert.deepEqual(
      report.slots.map((slot) => [slot.status, slot.attempts[0].why, slot.attempts[0].unverifiableFromRunner, slot.attempts[0].evidence.recheckSkipped, slot.attempts[0].evidence.aloneChecks]),
      [
        ['unverifiable-from-runner', once, true, true, 1],
        ['unverifiable-from-runner', once, true, true, 1],
        ['unverifiable-from-runner', never, true, true, 0],
      ],
    );
    assert.match(lines.join('\n'), /why: not re-checked: audit time budget used up/);
  });

  it('records a live HLS playlist as live once it advanced between reloads', async () => {
    const hlsOnly = { webcams: {}, gridPriority: [], news: { bloomberg: [BLOOMBERG_HLS] }, canaries: [CANARY] };
    const probeHls = async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } }));
    const { writes: [{ report }] } = await audit(['--all', '--report', 'audit.json'], { catalog: hlsOnly, probeHls });
    const [slot] = report.slots;
    assert.equal(slot.status, 'ok');
    assert.equal(slot.attempts[0].why, 'HLS playlist is live (it advanced between reloads)');
  });

  it('fails before probing when a slot has no place on the dashboard', async () => {
    let probed = false;
    const unplaced = { ...surfaces, webcamFeeds: surfaces.webcamFeeds.filter((feed) => feed.id !== 'sydney') };
    await assert.rejects(
      audit(['--all', '--report', 'audit.json'], { surfaces: unplaced, probeYouTube: async () => { probed = true; return []; } }),
      /webcams\/sydney/,
    );
    assert.equal(probed, false);
  });
});

describe('live video surfaces', () => {
  it('reads the webcam wall, regions and Live News defaults from the panels', () => {
    const surfaces = readLiveVideoSurfaces();
    assert.deepEqual(surfaces.webcamFeeds.map((feed) => feed.id).sort(), Object.keys(WEBCAM_SOURCES).sort());
    assert.ok(surfaces.webcamFeeds.every((feed) => /^[a-z-]+$/.test(feed.region)));
    assert.equal(surfaces.gridCells, 4);
    assert.deepEqual(Object.keys(surfaces.newsDefaults).sort(), ['full', 'tech']);
    assert.ok(surfaces.newsDefaults.full.includes('bloomberg'));
    const newsIds = new Set([...Object.values(surfaces.newsDefaults).flat(), ...surfaces.newsOptional]);
    assert.deepEqual([...newsIds].sort(), Object.keys(LIVE_NEWS_SOURCES).sort());
  });

  it('reads only arrays that open on their declaration line, never a ternary that mentions []', () => {
    const webcamsPanel = "const WEBCAM_FEEDS: WebcamFeed[] = [\n  { id: 'kyiv', city: 'Ukraine', country: 'Ukraine', region: 'europe' },\n];\nconst MAX_GRID_CELLS = 4;\n";
    const newsPanel = [
      'const FULL_LIVE_CHANNELS: LiveChannel[] = [',
      "  { id: 'bloomberg', name: 'Bloomberg' },",
      '];',
      'export const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [',
      "  { id: 'bloomberg', name: 'Bloomberg' },",
      '];',
      "const DEFAULT_LIVE_CHANNELS = SITE_VARIANT === 'tech' ? TECH_LIVE_CHANNELS : SITE_VARIANT === 'happy' ? [] : FULL_LIVE_CHANNELS;",
      'const _REGION_ENTRIES: { key: string; channelIds: string[] }[] = [',
      "  { id: 'decoy', key: 'na', channelIds: ['cnn'] },",
      '];',
      '',
    ].join('\n');
    assert.deepEqual(extractLiveVideoSurfaces({ webcamsPanel, newsPanel }).newsDefaults, { full: ['bloomberg'] });
  });

  it('fails loudly when a panel list can no longer be read', () => {
    const webcamsPanel = "const WEBCAM_FEEDS: WebcamFeed[] = [\n  { id: 'kyiv', city: 'Ukraine', country: 'Ukraine', region: 'europe' },\n];\nconst MAX_GRID_CELLS = 4;\n";
    const newsPanel = "const FULL_LIVE_CHANNELS: LiveChannel[] = [\n  { id: 'bloomberg', name: 'Bloomberg' },\n];\nexport const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [\n  { id: 'bloomberg', name: 'Bloomberg' },\n];\n";
    assert.deepEqual(extractLiveVideoSurfaces({ webcamsPanel, newsPanel }), {
      webcamFeeds: [{ id: 'kyiv', region: 'europe' }],
      gridCells: 4,
      newsDefaults: { full: ['bloomberg'] },
      newsOptional: ['bloomberg'],
    });
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: '', newsPanel }), /WEBCAM_FEEDS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: webcamsPanel.replace("region: 'europe'", 'region: REGION'), newsPanel }), /WEBCAM_FEEDS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel: webcamsPanel.replace('MAX_GRID_CELLS = 4', 'MAX_GRID_CELLS = CELLS'), newsPanel }), /MAX_GRID_CELLS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel, newsPanel: newsPanel.replace(/export const OPTIONAL[\s\S]*/, '') }), /OPTIONAL_LIVE_CHANNELS/);
    assert.throws(() => extractLiveVideoSurfaces({ webcamsPanel, newsPanel: newsPanel.replace("{ id: 'bloomberg', name: 'Bloomberg' },\n];\nexport", "{ id: ID, name: 'Bloomberg' },\n];\nexport") }), /FULL_LIVE_CHANNELS/);
  });
});
