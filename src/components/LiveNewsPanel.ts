import { Panel } from './Panel';

type YouTubePlayer = {
  mute(): void;
  unMute(): void;
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(videoId: string): void;
  cueVideoById(videoId: string): void;
};

type YouTubePlayerConstructor = new (
  elementId: string | HTMLElement,
  options: {
    videoId: string;
    playerVars: Record<string, number | string>;
    events: {
      onReady: () => void;
    };
  },
) => YouTubePlayer;

type YouTubeNamespace = {
  Player: YouTubePlayerConstructor;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface LiveChannel {
  id: string;
  name: string;
  videoId: string;
}

const LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', videoId: 'iEpJwprxDdk' },
  { id: 'sky', name: 'SkyNews', videoId: 'YDvsBbKfLPA' },
  { id: 'euronews', name: 'Euronews', videoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', videoId: 'LuKwFajn37U' },
  { id: 'france24', name: 'France24', videoId: 'Ap-UM1O9RBU' },
  { id: 'alarabiya', name: 'AlArabiya', videoId: 'n7eQejkXbnM' },
  { id: 'aljazeera', name: 'AlJazeera', videoId: 'gCNeDWCI0vo' },
];

export class LiveNewsPanel extends Panel {
  private static apiPromise: Promise<void> | null = null;
  private activeChannel: LiveChannel = LIVE_CHANNELS[0]!;
  private channelSwitcher: HTMLElement | null = null;
  private isMuted = true;
  private isPlaying = true;
  private muteBtn: HTMLButtonElement | null = null;
  private liveBtn: HTMLButtonElement | null = null;
  private player: YouTubePlayer | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerElement: HTMLDivElement | null = null;
  private playerElementId: string;
  private isPlayerReady = false;
  private currentVideoId: string | null = null;

  constructor() {
    super({ id: 'live-news', title: 'Live News', showCount: false, trackActivity: false });
    this.playerElementId = `${this.panelId}-player`;
    this.element.classList.add('panel-wide');
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
    this.renderPlayer();
  }

  private createLiveButton(): void {
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'live-indicator-btn';
    this.liveBtn.title = 'Toggle playback';
    this.updateLiveIndicator();
    this.liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlayback();
    });

    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.liveBtn);
  }

  private updateLiveIndicator(): void {
    if (!this.liveBtn) return;
    this.liveBtn.innerHTML = this.isPlaying
      ? '<span class="live-dot"></span>Live'
      : '<span class="live-dot paused"></span>Paused';
    this.liveBtn.classList.toggle('paused', !this.isPlaying);
  }

  private togglePlayback(): void {
    this.isPlaying = !this.isPlaying;
    this.updateLiveIndicator();
    this.renderPlayer();
  }

  private createMuteButton(): void {
    this.muteBtn = document.createElement('button');
    this.muteBtn.className = 'live-mute-btn';
    this.muteBtn.title = 'Toggle sound';
    this.updateMuteIcon();
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });

    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.muteBtn);
  }

  private updateMuteIcon(): void {
    if (!this.muteBtn) return;
    this.muteBtn.innerHTML = this.isMuted
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    this.muteBtn.classList.toggle('unmuted', !this.isMuted);
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteIcon();
    this.renderPlayer();
  }

  private createChannelSwitcher(): void {
    this.channelSwitcher = document.createElement('div');
    this.channelSwitcher.className = 'live-news-switcher';

    LIVE_CHANNELS.forEach(channel => {
      const btn = document.createElement('button');
      btn.className = `live-channel-btn ${channel.id === this.activeChannel.id ? 'active' : ''}`;
      btn.dataset.channelId = channel.id;
      btn.textContent = channel.name;
      btn.addEventListener('click', () => this.switchChannel(channel));
      this.channelSwitcher!.appendChild(btn);
    });

    this.element.insertBefore(this.channelSwitcher, this.content);
  }

  private switchChannel(channel: LiveChannel): void {
    if (channel.id === this.activeChannel.id) return;

    this.activeChannel = channel;

    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.channelId === channel.id);
    });

    this.renderPlayer();
  }

  private renderPlayer(): void {
    this.ensurePlayerContainer();
    void this.initializePlayer();
    this.syncPlayerState();
  }

  private ensurePlayerContainer(): void {
    if (this.playerContainer && this.playerElement) return;

    this.content.innerHTML = '';
    this.playerContainer = document.createElement('div');
    this.playerContainer.className = 'live-news-player';

    this.playerElement = document.createElement('div');
    this.playerElement.id = this.playerElementId;
    this.playerContainer.appendChild(this.playerElement);

    this.content.appendChild(this.playerContainer);
  }

  private static loadYouTubeApi(): Promise<void> {
    if (LiveNewsPanel.apiPromise) return LiveNewsPanel.apiPromise;

    LiveNewsPanel.apiPromise = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        resolve();
        return;
      }

      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[data-youtube-iframe-api="true"]',
      );

      if (existingScript) {
        if (window.YT?.Player) {
          resolve();
          return;
        }

        const previousReady = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          previousReady?.();
          resolve();
        };

        return;
      }

      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve();
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(script);
    });

    return LiveNewsPanel.apiPromise;
  }

  private async initializePlayer(): Promise<void> {
    if (this.player) return;
    await LiveNewsPanel.loadYouTubeApi();
    if (this.player || !this.playerElement) return;

    const autoplayParam = this.isPlaying ? 1 : 0;
    const muteParam = this.isMuted ? 1 : 0;

    this.player = new window.YT!.Player(this.playerElement, {
      videoId: this.activeChannel.videoId,
      playerVars: {
        autoplay: autoplayParam,
        mute: muteParam,
        rel: 0,
      },
      events: {
        onReady: () => {
          this.isPlayerReady = true;
          this.currentVideoId = this.activeChannel.videoId;
          this.syncPlayerState();
        },
      },
    });
  }

  private syncPlayerState(): void {
    if (!this.player || !this.isPlayerReady) return;

    if (this.currentVideoId !== this.activeChannel.videoId) {
      this.currentVideoId = this.activeChannel.videoId;
      if (this.isPlaying) {
        this.player.loadVideoById(this.activeChannel.videoId);
      } else {
        this.player.cueVideoById(this.activeChannel.videoId);
      }
    }

    if (this.isMuted) {
      this.player.mute();
    } else {
      this.player.unMute();
    }

    if (this.isPlaying) {
      this.player.playVideo();
    } else {
      this.player.pauseVideo();
    }
  }

  public refresh(): void {
    this.renderPlayer();
  }
}
