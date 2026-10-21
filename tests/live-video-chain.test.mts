import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceChain,
  failureKey,
  LIVE_VIDEO_TIMING,
  parseSource,
  parseSourceEntry,
  startChain,
  watchUrlFor,
  youtubeEmbedSrc,
  type Candidate,
  type ChainState,
  type LiveVideoSource,
  type ParsedSource,
  type SettledVerdict,
} from '../src/services/live-video/model.ts';

const JERUSALEM = 'https://www.youtube.com/watch?v=zp6LNSoq000';
const KYIV_RECORDING = '-Q7FuPINDjA';
const AJE_CHANNEL = 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg';
const AJE_HLS = 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8';

function source(entries: readonly string[], origin: LiveVideoSource['origin'] = 'builtin'): ParsedSource {
  return parseSource({ slot: 'webcams/test', entries, origin });
}

function candidate(entry: string): Candidate {
  const parsed = parseSourceEntry(entry);
  if (!parsed.ok) throw new Error(`fixture ${entry} does not parse`);
  return parsed.candidate;
}

const LIVE: SettledVerdict = { verdict: 'live', video: { videoId: 'zp6LNSoq000', isLive: true, title: 'Western Wall', author: 'Mt. of Olives' } };
const RECORDING: SettledVerdict = { verdict: 'recording', video: { videoId: KYIV_RECORDING, isLive: false, title: 'Kyiv', author: 'DW News' } };
const EMBED_BLOCKED: SettledVerdict = { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } };
const NOT_FOUND: SettledVerdict = { verdict: 'failed', outcome: { kind: 'player-error', code: 100 } };
const SILENT: SettledVerdict = { verdict: 'unverifiable', reason: 'player-api-silent' };
const BLOCKED_API: SettledVerdict = { verdict: 'unverifiable', reason: 'player-api-blocked' };
const NOT_STARTED: SettledVerdict = { verdict: 'failed', outcome: { kind: 'not-started' } };
const SIGNAL_MISSING: SettledVerdict = { verdict: 'unverifiable', reason: 'live-signal-missing' };

function verdict(state: ChainState, settled: SettledVerdict, parsed: ParsedSource, nowMs = 10_000) {
  return advanceChain(state, { type: 'verdict', verdict: settled }, parsed, nowMs);
}

describe('parseSource', () => {
  it('keeps valid entries in try order', () => {
    const parsed = source([JERUSALEM, AJE_CHANNEL, AJE_HLS]);
    assert.deepEqual(parsed.candidates.map(({ candidate: c }) => c.kind), ['video', 'channel', 'hls']);
    assert.equal(parsed.problem, null);
  });

  it('skips entries that do not parse when others do', () => {
    const parsed = source(['@CNN', JERUSALEM]);
    assert.deepEqual(parsed.candidates.map(({ entry }) => entry), [JERUSALEM]);
    assert.equal(parsed.problem, null);
  });

  it('names why nothing is playable', () => {
    assert.equal(source([]).problem, 'no-entries');
    assert.equal(source(['@CNN']).problem, 'needs-channel-url');
    assert.equal(source(['http://example.com/live.m3u8']).problem, 'insecure-url');
    assert.equal(source(['not a url']).problem, 'no-entries');
  });
});

describe('startChain', () => {
  it('goes offline without mounting when nothing is playable', () => {
    assert.deepEqual(startChain(source([]), new Set()), {
      state: { phase: 'offline', reason: 'no-entries', order: [], attempts: [], liveLostAtMs: null },
      effect: { type: 'unmount' },
    });
  });

  it('mounts the first candidate', () => {
    const step = startChain(source([JERUSALEM, AJE_CHANNEL]), new Set());
    assert.equal(step.state.phase, 'connecting');
    assert.deepEqual(step.effect, { type: 'mount', index: 0 });
  });

  it('tries recently failed candidates last', () => {
    const parsed = source([JERUSALEM, AJE_CHANNEL]);
    const step = startChain(parsed, new Set([failureKey('webcams/test', candidate(JERUSALEM))]));
    assert.deepEqual(step.effect, { type: 'mount', index: 1 });
    assert.deepEqual(step.state.order, [1, 0]);
  });

  it('still tries everything when every candidate failed recently', () => {
    const parsed = source([JERUSALEM, AJE_CHANNEL]);
    const memory = new Set(parsed.candidates.map(({ candidate: c }) => failureKey('webcams/test', c)));
    assert.deepEqual(startChain(parsed, memory).effect, { type: 'mount', index: 0 });
  });
});

describe('advanceChain', () => {
  it('locks onto a live verdict and keeps the transport', () => {
    const parsed = source([JERUSALEM]);
    const step = verdict(startChain(parsed, new Set()).state, LIVE, parsed);
    assert.equal(step.state.phase, 'live');
    assert.deepEqual(step.effect, { type: 'keep' });
  });

  it('moves to the next candidate after a failure', () => {
    const parsed = source([JERUSALEM, AJE_CHANNEL]);
    const step = verdict(startChain(parsed, new Set()).state, EMBED_BLOCKED, parsed);
    assert.equal(step.state.phase, 'connecting');
    assert.deepEqual(step.effect, { type: 'mount', index: 1 });
    assert.equal(step.state.attempts.length, 1);
  });

  it('never keeps an ended recording from a built-in source', () => {
    const parsed = source([KYIV_RECORDING]);
    const step = verdict(startChain(parsed, new Set()).state, RECORDING, parsed);
    assert.deepEqual(step.state.phase === 'offline' && step.state.reason, 'not-live');
    assert.deepEqual(step.effect, { type: 'unmount' });
  });

  it('keeps an ended recording a user added as a video', () => {
    const parsed = source([KYIV_RECORDING], 'custom');
    const step = verdict(startChain(parsed, new Set()).state, RECORDING, parsed);
    assert.equal(step.state.phase, 'recording');
    assert.deepEqual(step.effect, { type: 'keep' });
  });

  it('summarizes why every candidate failed', () => {
    const blocked = source([JERUSALEM, KYIV_RECORDING]);
    let step = startChain(blocked, new Set());
    step = verdict(step.state, EMBED_BLOCKED, blocked);
    step = verdict(step.state, EMBED_BLOCKED, blocked);
    assert.equal(step.state.phase === 'offline' && step.state.reason, 'embed-blocked');

    const ended = source([JERUSALEM, AJE_CHANNEL]);
    step = startChain(ended, new Set());
    step = verdict(step.state, RECORDING, ended);
    step = verdict(step.state, { verdict: 'failed', outcome: { kind: 'channel-not-live' } }, ended);
    assert.equal(step.state.phase === 'offline' && step.state.reason, 'not-live');

    const mixed = source([JERUSALEM, AJE_CHANNEL]);
    step = startChain(mixed, new Set());
    step = verdict(step.state, EMBED_BLOCKED, mixed);
    step = verdict(step.state, NOT_FOUND, mixed);
    assert.equal(step.state.phase === 'offline' && step.state.reason, 'unavailable');
  });

  it('treats a player that never became ready as a failure for a built-in source', () => {
    const parsed = source([JERUSALEM, AJE_CHANNEL]);
    const step = verdict(startChain(parsed, new Set()).state, SILENT, parsed);
    assert.deepEqual(step.effect, { type: 'mount', index: 1 });
  });

  it('keeps a user-added frame whose player never became ready, disclosed as unverified', () => {
    const parsed = source([JERUSALEM], 'custom');
    const step = verdict(startChain(parsed, new Set()).state, SILENT, parsed);
    assert.deepEqual(step.state.phase === 'unverified' && step.state.reason, 'player-api-silent');
    assert.deepEqual(step.effect, { type: 'keep' });
  });

  it('hops to an HLS candidate when the YouTube player API is blocked, else keeps the frame unverified', () => {
    const withHls = source([JERUSALEM, AJE_CHANNEL, AJE_HLS]);
    assert.deepEqual(verdict(startChain(withHls, new Set()).state, BLOCKED_API, withHls).effect, { type: 'mount', index: 2 });

    const youtubeOnly = source([JERUSALEM, AJE_CHANNEL]);
    const step = verdict(startChain(youtubeOnly, new Set()).state, BLOCKED_API, youtubeOnly);
    assert.deepEqual(step.state.phase === 'unverified' && step.state.reason, 'player-api-blocked');
    assert.deepEqual(step.effect, { type: 'keep' });
  });

  it('counts a stream that never started as not live', () => {
    const scheduled = source([JERUSALEM]);
    const step = verdict(startChain(scheduled, new Set()).state, NOT_STARTED, scheduled);
    assert.equal(step.state.phase === 'offline' && step.state.reason, 'not-live');
    assert.deepEqual(step.effect, { type: 'unmount' });

    const mixed = source([JERUSALEM, AJE_CHANNEL, KYIV_RECORDING]);
    let next = verdict(startChain(mixed, new Set()).state, NOT_STARTED, mixed);
    assert.deepEqual(next.effect, { type: 'mount', index: 1 });
    next = verdict(next.state, { verdict: 'failed', outcome: { kind: 'channel-not-live' } }, mixed);
    next = verdict(next.state, RECORDING, mixed);
    assert.equal(next.state.phase === 'offline' && next.state.reason, 'not-live');
  });

  it('treats a missing live signal like a blocked player API: never the next YouTube candidate', () => {
    // The signal is missing for every video, so moving on would empty the wall.
    const builtin = source([JERUSALEM, AJE_CHANNEL]);
    const step = verdict(startChain(builtin, new Set()).state, SIGNAL_MISSING, builtin);
    assert.deepEqual(step.state.phase === 'unverified' && step.state.reason, 'live-signal-missing');
    assert.deepEqual(step.effect, { type: 'keep' });

    const custom = source([JERUSALEM, AJE_CHANNEL], 'custom');
    assert.deepEqual(verdict(startChain(custom, new Set()).state, SIGNAL_MISSING, custom).effect, { type: 'keep' });

    const withHls = source([JERUSALEM, AJE_CHANNEL, AJE_HLS]);
    assert.deepEqual(verdict(startChain(withHls, new Set()).state, SIGNAL_MISSING, withHls).effect, { type: 'mount', index: 2 });
  });

  it('re-resolves once when a live stream ends, then goes offline if it ends again soon', () => {
    const parsed = source([AJE_CHANNEL, JERUSALEM]);
    let step = verdict(startChain(parsed, new Set()).state, LIVE, parsed, 1_000);
    step = advanceChain(step.state, { type: 'live-lost' }, parsed, 60_000);
    assert.equal(step.state.phase, 'connecting');
    assert.deepEqual(step.effect, { type: 'mount', index: 0 });
    assert.equal(step.state.attempts.length, 0);

    step = verdict(step.state, LIVE, parsed, 61_000);
    const soon = advanceChain(step.state, { type: 'live-lost' }, parsed, 60_000 + LIVE_VIDEO_TIMING.relockWindowMs - 1);
    assert.equal(soon.state.phase === 'offline' && soon.state.reason, 'stream-ended');
    assert.deepEqual(soon.effect, { type: 'unmount' });

    const later = advanceChain(step.state, { type: 'live-lost' }, parsed, 60_000 + LIVE_VIDEO_TIMING.relockWindowMs);
    assert.equal(later.state.phase, 'connecting');
  });

  it('ignores a lost stream that was never live', () => {
    const parsed = source([JERUSALEM]);
    const connecting = startChain(parsed, new Set()).state;
    assert.deepEqual(advanceChain(connecting, { type: 'live-lost' }, parsed, 5_000), { state: connecting, effect: { type: 'keep' } });
  });

  it('restarts from the top on retry, and ignores retry while connecting', () => {
    const parsed = source([JERUSALEM]);
    const connecting = startChain(parsed, new Set()).state;
    assert.deepEqual(advanceChain(connecting, { type: 'retry' }, parsed, 5_000), { state: connecting, effect: { type: 'keep' } });

    const offline = verdict(connecting, EMBED_BLOCKED, parsed).state;
    assert.deepEqual(advanceChain(offline, { type: 'retry' }, parsed, 5_000), startChain(parsed, new Set()));
  });

  it('ignores a verdict once the chain has settled', () => {
    const parsed = source([JERUSALEM]);
    const live = verdict(startChain(parsed, new Set()).state, LIVE, parsed).state;
    assert.deepEqual(verdict(live, EMBED_BLOCKED, parsed), { state: live, effect: { type: 'keep' } });
  });
});

describe('failureKey', () => {
  it('separates slots and candidates', () => {
    const video = candidate(JERUSALEM);
    assert.notEqual(failureKey('webcams/a', video), failureKey('webcams/b', video));
    assert.notEqual(failureKey('webcams/a', video), failureKey('webcams/a', candidate(AJE_CHANNEL)));
    assert.equal(failureKey('webcams/a', video), failureKey('webcams/a', candidate('zp6LNSoq000')));
  });
});

describe('youtubeEmbedSrc', () => {
  const options = { origin: 'https://www.worldmonitor.app', autoplay: true, muted: true, controls: false, quality: null };

  it('builds a video embed that the IFrame API can attach to', () => {
    const url = new URL(youtubeEmbedSrc(candidate(JERUSALEM) as Extract<Candidate, { kind: 'video' }>, options));
    assert.equal(`${url.origin}${url.pathname}`, 'https://www.youtube.com/embed/zp6LNSoq000');
    assert.equal(url.searchParams.get('enablejsapi'), '1');
    assert.equal(url.searchParams.get('origin'), 'https://www.worldmonitor.app');
    assert.equal(url.searchParams.get('widget_referrer'), 'https://www.worldmonitor.app');
    assert.equal(url.searchParams.get('autoplay'), '1');
    assert.equal(url.searchParams.get('mute'), '1');
    assert.equal(url.searchParams.get('controls'), '0');
    assert.equal(url.searchParams.get('playsinline'), '1');
    assert.equal(url.searchParams.has('vq'), false);
  });

  it('builds a channel live embed with quality', () => {
    const url = new URL(youtubeEmbedSrc(candidate(AJE_CHANNEL) as Extract<Candidate, { kind: 'channel' }>, { ...options, muted: false, quality: 'hd720' }));
    assert.equal(`${url.origin}${url.pathname}`, 'https://www.youtube.com/embed/live_stream');
    assert.equal(url.searchParams.get('channel'), 'UCNye-wNBqNL5ZzHSJj3l8Bg');
    assert.equal(url.searchParams.get('mute'), '0');
    assert.equal(url.searchParams.get('vq'), 'hd720');
  });
});

describe('watchUrlFor', () => {
  it('links a video, a channel live page, and nothing for HLS', () => {
    assert.equal(watchUrlFor(candidate(JERUSALEM)), 'https://www.youtube.com/watch?v=zp6LNSoq000');
    assert.equal(watchUrlFor(candidate(AJE_CHANNEL)), 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live');
    assert.equal(watchUrlFor(candidate(AJE_HLS)), null);
    assert.equal(watchUrlFor(null), null);
  });
});
