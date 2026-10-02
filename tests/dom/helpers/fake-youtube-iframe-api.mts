import type {
  YouTubeNamespaceLike,
  YouTubePlayerEvents,
  YouTubePlayerLike,
  YouTubeVideoDataLike,
} from '@/services/live-video/youtube-iframe-api';

export interface FakeVideo {
  videoId: string;
  isLive?: boolean;
  title?: string;
  author?: string;
  duration?: number;
}

const PLAYING = 1;
const PAUSED = 2;

/** Stands in for `YT.Player` attached to an iframe. Tests drive it with ready/play/error/setState. */
export class FakeYouTubePlayer implements YouTubePlayerLike {
  readonly iframe: HTMLIFrameElement;
  destroyed = false;
  muted = true;
  private readonly events: YouTubePlayerEvents;
  private video: FakeVideo | null = null;
  private state = -1;

  constructor(iframe: HTMLIFrameElement, options: { events: YouTubePlayerEvents }) {
    this.iframe = iframe;
    this.events = options.events;
  }

  /** The video id in the iframe's embed URL ('live_stream' for a channel embed). */
  get embeddedVideoId(): string {
    return /\/embed\/([^?]+)/.exec(this.iframe.src)?.[1] ?? '';
  }

  ready(video: FakeVideo): void {
    this.video = video;
    // The real API renames the attached iframe after the video it loaded.
    if (video.title) this.iframe.title = video.title;
    this.events.onReady?.();
  }

  setState(state: number): void {
    this.state = state;
    this.events.onStateChange?.({ data: state });
  }

  error(code: number): void {
    this.events.onError?.({ data: code });
  }

  goLive(video: Partial<FakeVideo> = {}): void {
    this.ready({ videoId: this.embeddedVideoId, isLive: true, duration: 3_600, ...video });
    this.setState(PLAYING);
  }

  getVideoData(): YouTubeVideoDataLike {
    if (!this.video) return {};
    return { video_id: this.video.videoId, isLive: this.video.isLive, title: this.video.title ?? '', author: this.video.author ?? '' };
  }

  getDuration(): number {
    return this.video?.duration ?? 0;
  }

  getPlayerState(): number {
    return this.state;
  }

  mute(): void {
    this.muted = true;
  }

  unMute(): void {
    this.muted = false;
  }

  isMuted(): boolean {
    return this.muted;
  }

  playVideo(): void {
    this.setState(PLAYING);
  }

  pauseVideo(): void {
    this.setState(PAUSED);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeYouTubeIframeApi {
  readonly namespace: YouTubeNamespaceLike;
  readonly players: FakeYouTubePlayer[];
  /** The newest player whose iframe has this title, e.g. 'Jerusalem live webcam'. */
  playerFor(title: string): FakeYouTubePlayer;
}

/** `autoLive` makes every player report a live stream on the next microtask, like a healthy wall. */
export function createFakeYouTubeIframeApi(options: { autoLive?: boolean } = {}): FakeYouTubeIframeApi {
  const players: FakeYouTubePlayer[] = [];

  class Player extends FakeYouTubePlayer {
    constructor(iframe: HTMLIFrameElement, playerOptions: { events: YouTubePlayerEvents }) {
      super(iframe, playerOptions);
      players.push(this);
      if (options.autoLive) queueMicrotask(() => this.goLive());
    }
  }

  return {
    namespace: { Player },
    players,
    playerFor(title) {
      const matches = players.filter((candidate) => candidate.iframe.title === title && !candidate.destroyed);
      const player = matches[matches.length - 1];
      if (!player) throw new Error(`no live player for "${title}"`);
      return player;
    },
  };
}
