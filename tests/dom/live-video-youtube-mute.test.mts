import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';
import { openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';

import { createFakeYouTubeIframeApi, type FakeYouTubeIframeApi, type FakeYouTubePlayer } from './helpers/fake-youtube-iframe-api.mts';

const loader = vi.hoisted(() => ({ api: null as FakeYouTubeIframeApi | null }));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: () => Promise.resolve(loader.api?.namespace ?? null),
}));

const LIVE_VIDEO = 'https://www.youtube.com/watch?v=gCNeDWCI0vo';

interface LiveTile {
  readonly player: FakeYouTubePlayer;
  readonly states: LiveVideoState[];
  readonly onMutedChange: ReturnType<typeof vi.fn>;
}

let session: LiveVideoSession | undefined;

async function polls(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(count * LIVE_VIDEO_TIMING.pollMs);
}

/** Opens a muted web YouTube tile and lets its stream go live. */
async function openLiveTile(): Promise<LiveTile> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const states: LiveVideoState[] = [];
  const onMutedChange = vi.fn();
  session = openLiveVideo(container, {
    source: { slot: 'live-news/mute-test', entries: [LIVE_VIDEO], origin: 'builtin' },
    autoplay: true,
    muted: true,
    presentation: { title: 'Mute test live stream', className: 'live-news-frame', controls: true },
    onState: (state) => states.push(state),
    onMutedChange,
  });
  await vi.advanceTimersByTimeAsync(0);
  const player = loader.api?.players[0];
  if (!player) throw new Error('no YouTube player attached');
  player.goLive();
  await polls(1);
  expect(states[states.length - 1]?.phase).toBe('live');
  return { player, states, onMutedChange };
}

beforeEach(() => {
  // The tile carries a real YouTube embed URL; keep happy-dom from fetching it.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  loader.api = createFakeYouTubeIframeApi();
});

afterEach(() => {
  session?.destroy();
  session = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('live video web YouTube mute sync', () => {
  it('reports a viewer unmuting from the YouTube controls once, after the stream is live', async () => {
    const { player, onMutedChange } = await openLiveTile();

    await polls(3);
    expect(onMutedChange).not.toHaveBeenCalled();

    // The viewer clicks the speaker in YouTube's own control bar: no API call reaches the session.
    player.muted = false;
    await polls(3);
    expect(onMutedChange).toHaveBeenCalledTimes(1);
    expect(onMutedChange).toHaveBeenCalledWith(false);

    player.muted = true;
    await polls(2);
    expect(onMutedChange).toHaveBeenCalledTimes(2);
    expect(onMutedChange).toHaveBeenLastCalledWith(true);
  });

  it('does not echo back a mute change the session made', async () => {
    const { player, onMutedChange } = await openLiveTile();

    session?.setMuted(false);
    expect(player.muted).toBe(false);
    await polls(3);

    expect(onMutedChange).not.toHaveBeenCalled();
  });

  it('applies a mute toggle made before the player was ready, and never reports the stale value', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onMutedChange = vi.fn();
    session = openLiveVideo(container, {
      source: { slot: 'live-news/mute-test', entries: [LIVE_VIDEO], origin: 'builtin' },
      autoplay: true,
      muted: true,
      presentation: { title: 'Mute test live stream', className: 'live-news-frame', controls: true },
      onState: () => {},
      onMutedChange,
    });

    // The viewer clicks the header sound button while the IFrame API is still loading.
    session.setMuted(false);
    await vi.advanceTimersByTimeAsync(0);
    const player = loader.api?.players[0];
    if (!player) throw new Error('no YouTube player attached');
    player.goLive();
    await polls(3);

    expect(player.muted).toBe(false);
    expect(onMutedChange).not.toHaveBeenCalled();
  });

  it('stops reading the player once destroyed', async () => {
    const { player, onMutedChange } = await openLiveTile();

    session?.destroy();
    player.muted = false;
    await polls(3);

    expect(onMutedChange).not.toHaveBeenCalled();
  });
});
