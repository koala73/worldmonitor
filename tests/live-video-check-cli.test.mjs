import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
} from '../scripts/check-live-video-sources.mjs';
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
