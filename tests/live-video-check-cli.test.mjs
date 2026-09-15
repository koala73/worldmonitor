import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  catalogTargets,
  classifyHlsPlaylist,
  exitCodeFor,
  formatCheckLine,
  observationFromRecord,
  parseCheckArgs,
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
    assert.deepEqual(entries.map((row) => row.name), ['webcams/kyiv', 'webcams/new-york', 'webcams/new-york#2', 'canary/1']);
    assert.deepEqual(empty, ['webcams/tel-aviv']);
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
    assert.match(formatCheckLine({ name: null, parsed: entry, verdict: { verdict: 'live', video: null } }), /why: HLS playlist is live \(playback not checked outside a browser\)$/m);
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

describe('classifyHlsPlaylist', () => {
  it('reads live, VOD and non-playlist bodies', () => {
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n'), 'live');
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n'), 'vod');
    assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nseg1.ts\n'), 'vod');
    assert.equal(classifyHlsPlaylist('<html>blocked</html>'), 'unknown');
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

  it('calls a live HLS playlist live from Node and says playback was not checked', async () => {
    const out = [];
    const code = await runCheck(['aje=https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8'], {
      write: (line) => out.push(line),
      probeYouTube: async () => { throw new Error('no YouTube entries were given'); },
      fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n'),
    });
    const text = out.join('\n');
    assert.equal(code, 0);
    assert.match(text, /^LIVE\s+aje/m);
    assert.match(text, /why: HLS playlist is live \(playback not checked outside a browser\)$/m);
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
