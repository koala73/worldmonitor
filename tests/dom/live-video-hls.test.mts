import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';
import { openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';

const hlsjs = vi.hoisted(() => {
  type Listener = (event: string, data: unknown) => void;
  const instances: FakeHls[] = [];

  /** Stands in for hls.js: the test plays the part of the playlist loader. */
  class FakeHls {
    static readonly Events = { LEVEL_LOADED: 'hlsLevelLoaded', ERROR: 'hlsError' } as const;
    static isSupported(): boolean {
      return true;
    }

    readonly listeners = new Map<string, Listener>();
    destroyed = false;

    constructor() {
      instances.push(this);
    }

    on(event: string, listener: Listener): void {
      this.listeners.set(event, listener);
    }

    loadSource(): void {}
    attachMedia(): void {}

    destroy(): void {
      this.destroyed = true;
    }

    loadLivePlaylist(): void {
      this.listeners.get(FakeHls.Events.LEVEL_LOADED)?.(FakeHls.Events.LEVEL_LOADED, { details: { live: true } });
    }
  }

  return { FakeHls, instances };
});
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('hls.js', () => ({ default: hlsjs.FakeHls }));

vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  track: analytics.track,
}));

const STREAM = 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8';
const LIVE: LiveVideoState = { phase: 'live', via: 'hls', title: null, author: null, watchUrl: null };

interface HlsTile {
  readonly container: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly states: LiveVideoState[];
}

let session: LiveVideoSession | undefined;

function openHlsTile(onPlayingChange?: (playing: boolean) => void, onMutedChange?: (muted: boolean) => void): HlsTile {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const states: LiveVideoState[] = [];
  session = openLiveVideo(container, {
    source: { slot: 'webcams/hls-test', entries: [STREAM], origin: 'builtin' },
    autoplay: true,
    muted: true,
    presentation: { title: 'HLS live webcam', className: 'webcam-iframe', controls: false },
    onState: (state) => states.push(state),
    onPlayingChange,
    onMutedChange,
  });
  const video = container.querySelector('video');
  if (!video) throw new Error('no video element mounted');
  return { container, video, states };
}

/** Mounts through hls.js and lets it report a live playlist; nothing has played yet. */
async function openLivePlaylistTile(onPlayingChange?: (playing: boolean) => void): Promise<HlsTile> {
  const tile = openHlsTile(onPlayingChange);
  await vi.advanceTimersByTimeAsync(0);
  const hls = hlsjs.instances[hlsjs.instances.length - 1];
  if (!hls) throw new Error('hls.js was never constructed');
  hls.loadLivePlaylist();
  return tile;
}

async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LIVE_VIDEO_TIMING.pollMs);
}

/** Moves the media clock forward, then lets one poll observe it. */
async function play(tile: HlsTile, seconds: number): Promise<void> {
  tile.video.currentTime += seconds;
  await poll();
}

function lastState(tile: HlsTile): LiveVideoState | undefined {
  return tile.states[tile.states.length - 1];
}

function everShownLive(tile: HlsTile): boolean {
  return tile.states.some((state) => state.phase === 'live');
}

beforeEach(() => {
  vi.useFakeTimers();
  hlsjs.instances.length = 0;
  analytics.track.mockClear();
});

afterEach(() => {
  session?.destroy();
  session = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('live video HLS transport', () => {
  it('never shows a live playlist that sits on a stalled frame as live, and fails it as not started at the deadline', async () => {
    const tile = await openLivePlaylistTile();
    expect(tile.video.paused).toBe(false);

    await vi.advanceTimersByTimeAsync(LIVE_VIDEO_TIMING.verdictDeadlineMs - LIVE_VIDEO_TIMING.pollMs);
    expect(everShownLive(tile)).toBe(false);
    expect(lastState(tile)?.phase).toBe('connecting');

    await poll();
    expect(everShownLive(tile)).toBe(false);
    expect(lastState(tile)).toEqual({ phase: 'offline', reason: 'not-live', watchUrl: null });
    expect(tile.container.querySelector('video')).toBeNull();
    expect(analytics.track).toHaveBeenCalledWith('live-video-attempt-failed', { slot: 'webcams/hls-test', kind: 'hls', outcome: 'not-started' });
  });

  it('goes live only once the media clock has advanced a full second while playing', async () => {
    const tile = await openLivePlaylistTile();

    await poll();
    await play(tile, 0.5);
    expect(everShownLive(tile)).toBe(false);

    await play(tile, 0.5);
    expect(lastState(tile)).toEqual(LIVE);
  });

  it('counts neither a seek nor a clock that moves while paused as playback', async () => {
    const tile = await openLivePlaylistTile();

    await poll();
    // hls.js seeks a live stream to its live edge before any frame renders.
    await play(tile, 30);
    await poll();
    expect(everShownLive(tile)).toBe(false);

    tile.video.pause();
    await play(tile, 2);
    await play(tile, 2);
    expect(everShownLive(tile)).toBe(false);

    await tile.video.play();
    await poll();
    await play(tile, 1);
    expect(lastState(tile)).toEqual(LIVE);
  });

  it('reads the video element for native HLS and needs the same playback progress', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const tile = openHlsTile();
    await vi.advanceTimersByTimeAsync(0);
    expect(hlsjs.instances).toHaveLength(0);
    expect(tile.video.getAttribute('src')).toBe(STREAM);

    Object.defineProperty(tile.video, 'duration', { configurable: true, value: Infinity });
    tile.video.dispatchEvent(new Event('loadedmetadata'));
    await poll();
    await poll();
    expect(everShownLive(tile)).toBe(false);

    await play(tile, 1);
    expect(lastState(tile)).toEqual(LIVE);
  });

  it('ignores the volumechange its own setMuted caused, and reports a real one', () => {
    const onMutedChange = vi.fn();
    const tile = openHlsTile(undefined, onMutedChange);

    session?.setMuted(false);
    tile.video.dispatchEvent(new Event('volumechange'));
    expect(onMutedChange).not.toHaveBeenCalled();

    // The viewer mutes from the video element's own controls.
    tile.video.muted = true;
    tile.video.dispatchEvent(new Event('volumechange'));
    expect(onMutedChange).toHaveBeenCalledTimes(1);
    expect(onMutedChange).toHaveBeenCalledWith(true);
  });

  it('keeps a live stream live when the viewer pauses it, and reports the pause', async () => {
    const onPlayingChange = vi.fn();
    const tile = await openLivePlaylistTile(onPlayingChange);
    await poll();
    await play(tile, 1);
    expect(lastState(tile)).toEqual(LIVE);
    const statesWhenLive = tile.states.length;

    tile.video.pause();
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(2 * LIVE_VIDEO_TIMING.verdictDeadlineMs);

    expect(tile.states).toHaveLength(statesWhenLive);
    expect(tile.container.querySelector('video')).toBe(tile.video);
  });
});
