import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_VIDEO_TIMING } from '@/services/live-video/model';
import { openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';

const iframeApi = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('@/services/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/runtime')>()),
  isDesktopRuntime: () => true,
  getLocalApiPort: () => 47001,
}));

vi.mock('@/services/live-video/youtube-iframe-api', () => ({ loadYouTubeIframeApi: iframeApi.load }));

const SIDECAR_ORIGIN = 'http://localhost:47001';
const CHANNEL_ID = 'UCNye-wNBqNL5ZzHSJj3l8Bg';

interface SidecarTile {
  readonly container: HTMLElement;
  readonly frame: HTMLIFrameElement;
  readonly frameWindow: { postMessage: ReturnType<typeof vi.fn> };
  readonly states: LiveVideoState[];
  readonly onMutedChange: ReturnType<typeof vi.fn>;
}

let session: LiveVideoSession | undefined;

function openChannelTile(): SidecarTile {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const states: LiveVideoState[] = [];
  const onMutedChange = vi.fn();
  session = openLiveVideo(container, {
    source: { slot: 'webcams/sidecar-test', entries: [`https://www.youtube.com/channel/${CHANNEL_ID}`], origin: 'builtin' },
    autoplay: true,
    muted: true,
    presentation: { title: 'Sidecar live webcam', className: 'webcam-iframe', controls: false },
    onState: (state) => states.push(state),
    onMutedChange,
  });
  const frame = container.querySelector('iframe');
  if (!frame) throw new Error('no sidecar frame mounted');
  // happy-dom loads no page into the frame; this stands in for the sidecar player's window.
  const frameWindow = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => frameWindow });
  return { container, frame, frameWindow, states, onMutedChange };
}

function receive(data: unknown, from: { source: unknown; origin: string }): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: from.origin, source: from.source as MessageEventSource }));
}

async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LIVE_VIDEO_TIMING.pollMs);
}

beforeEach(() => {
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
});

afterEach(() => {
  session?.destroy();
  session = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('live video sidecar transport', () => {
  it('embeds the channel from the local sidecar and never loads the YouTube IFrame API', () => {
    const { frame, states } = openChannelTile();

    const src = new URL(frame.src);
    expect(src.origin).toBe(SIDECAR_ORIGIN);
    expect(src.pathname).toBe('/api/youtube-embed');
    expect(src.searchParams.get('channel')).toBe(CHANNEL_ID);
    expect(src.searchParams.get('parentOrigin')).toBe(window.location.origin);
    expect(states).toEqual([{ phase: 'connecting', attempt: 1, of: 1 }]);
    expect(iframeApi.load).not.toHaveBeenCalled();
  });

  it('probes the sidecar origin only after a ready signal from its own frame', async () => {
    const { frameWindow } = openChannelTile();

    receive({ type: 'yt-ready' }, { source: window, origin: SIDECAR_ORIGIN });
    receive({ type: 'yt-ready' }, { source: frameWindow, origin: 'https://www.youtube.com' });
    receive({ type: 'yt-ready' }, { source: frameWindow, origin: 'http://localhost:9999' });
    await poll();
    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    receive({ type: 'yt-ready' }, { source: frameWindow, origin: SIDECAR_ORIGIN });
    await poll();
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: 'probe' }, SIDECAR_ORIGIN);
  });

  it('goes live on video data from its own frame and ignores the same data from anywhere else', async () => {
    const { frameWindow, states } = openChannelTile();
    const liveData = { type: 'yt-video-data', videoId: 'abcdefghijk', isLive: true, title: 'Live now', author: 'Test Channel', state: 1, duration: 120 };

    receive({ type: 'yt-ready' }, { source: frameWindow, origin: SIDECAR_ORIGIN });
    receive(liveData, { source: window, origin: SIDECAR_ORIGIN });
    receive(liveData, { source: frameWindow, origin: 'https://www.youtube.com' });
    await poll();
    expect(states[states.length - 1]?.phase).toBe('connecting');

    receive(liveData, { source: frameWindow, origin: SIDECAR_ORIGIN });
    await poll();
    expect(states[states.length - 1]).toEqual({
      phase: 'live',
      via: 'channel',
      title: 'Live now',
      author: 'Test Channel',
      watchUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
  });

  it('ignores the sidecar echoing back a mute change the session made, and reports a real one', () => {
    const { frameWindow, onMutedChange } = openChannelTile();

    session?.setMuted(false);
    // The sidecar's own mute-sync poll reports what the session just asked for.
    receive({ type: 'yt-mute-state', muted: false }, { source: frameWindow, origin: SIDECAR_ORIGIN });
    expect(onMutedChange).not.toHaveBeenCalled();

    // The viewer mutes from YouTube's own control bar inside the sidecar player.
    receive({ type: 'yt-mute-state', muted: true }, { source: frameWindow, origin: SIDECAR_ORIGIN });
    expect(onMutedChange).toHaveBeenCalledTimes(1);
    expect(onMutedChange).toHaveBeenCalledWith(true);
  });

  it('relays mute to the sidecar and stops listening once destroyed', async () => {
    const { container, frameWindow, states } = openChannelTile();

    session?.setMuted(false);
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: 'unmute' }, SIDECAR_ORIGIN);

    session?.destroy();
    receive({ type: 'yt-error', code: 150 }, { source: frameWindow, origin: SIDECAR_ORIGIN });
    await poll();
    expect(container.querySelector('iframe')).toBeNull();
    expect(states).toHaveLength(1);
  });
});
