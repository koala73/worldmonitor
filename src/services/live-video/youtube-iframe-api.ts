// Loads the YouTube IFrame Player API once per page. Call it only after play intent: fetching the
// script is itself a YouTube request, and the click-to-play gate promises none before a click.

export interface YouTubeVideoDataLike {
  video_id?: string;
  /** Undocumented but present; missing means YouTube stopped exposing it. */
  isLive?: boolean;
  title?: string;
  author?: string;
}

export interface YouTubePlayerLike {
  getVideoData(): YouTubeVideoDataLike;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

export interface YouTubePlayerEvents {
  onReady?: () => void;
  onError?: (event: { data: number }) => void;
  onStateChange?: (event: { data: number }) => void;
}

export interface YouTubeNamespaceLike {
  Player: new (target: HTMLIFrameElement, options: { events: YouTubePlayerEvents }) => YouTubePlayerLike;
}

interface YouTubeApiGlobals {
  YT?: { Player?: unknown };
  onYouTubeIframeAPIReady?: () => void;
}

let apiPromise: Promise<YouTubeNamespaceLike | null> | null = null;

function loadedApi(): YouTubeNamespaceLike | null {
  const api = (window as unknown as YouTubeApiGlobals).YT;
  return api?.Player ? (api as unknown as YouTubeNamespaceLike) : null;
}

/** Resolves the `YT` namespace, or null when the script is blocked (ad blocker, network). Never rejects. */
export function loadYouTubeIframeApi(): Promise<YouTubeNamespaceLike | null> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const ready = loadedApi();
    if (ready) {
      resolve(ready);
      return;
    }

    const globals = window as unknown as YouTubeApiGlobals;
    const previousReady = globals.onYouTubeIframeAPIReady;
    globals.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(loadedApi());
    };
    // Script tag can outlive a missed ready callback (API finished between the
    // first loadedApi() probe and waiter install). Re-check before waiting.
    if (document.querySelector('script[data-youtube-iframe-api="true"]')) {
      const alreadyReady = loadedApi();
      if (alreadyReady) resolve(alreadyReady);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.youtubeIframeApi = 'true';
    script.onerror = () => {
      console.warn('[live-video] YouTube IFrame API failed to load (ad blocker or network issue)');
      apiPromise = null;
      script.remove();
      resolve(null);
    };
    document.head.appendChild(script);
  });

  return apiPromise;
}
