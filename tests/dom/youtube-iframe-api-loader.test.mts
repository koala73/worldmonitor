import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadYouTubeIframeApi', () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.replaceChildren();
    delete (window as { YT?: unknown }).YT;
    delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
  });

  afterEach(() => {
    document.head.replaceChildren();
    delete (window as { YT?: unknown }).YT;
    delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
  });

  it('resolves when an existing iframe_api script already exposed YT.Player', async () => {
    const existing = document.createElement('script');
    existing.dataset.youtubeIframeApi = 'true';
    document.head.appendChild(existing);
    (window as { YT?: { Player: unknown } }).YT = { Player: function Player() {} };

    const { loadYouTubeIframeApi } = await import('@/services/live-video/youtube-iframe-api');
    await expect(loadYouTubeIframeApi()).resolves.toMatchObject({ Player: expect.any(Function) });
  });

  it('still waits on onYouTubeIframeAPIReady when the script exists but YT.Player does not', async () => {
    const existing = document.createElement('script');
    existing.dataset.youtubeIframeApi = 'true';
    document.head.appendChild(existing);

    const { loadYouTubeIframeApi } = await import('@/services/live-video/youtube-iframe-api');
    const pending = loadYouTubeIframeApi();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    (window as { YT?: { Player: unknown } }).YT = { Player: function Player() {} };
    (window as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady?.();
    await expect(pending).resolves.toMatchObject({ Player: expect.any(Function) });
  });
});
