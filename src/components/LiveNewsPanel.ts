import { Panel } from './Panel';
import { fetchLiveVideoInfo } from '@/services/live-news';
import { isDesktopRuntime, getRemoteApiBaseUrl, getApiBaseUrl, getLocalApiPort } from '@/services/runtime';
import { t } from '../services/i18n';
import { createFocusTrap } from '@/utils/focus-trap';
import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS, SITE_VARIANT } from '@/config';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

import { getStreamQuality } from '@/services/ai-flow-settings';
import { getActiveLiveMedia, playAllLiveMedia, registerLiveMediaStarter, releaseLiveMediaPlayback, requestLiveMediaPlayback, stopLiveMediaPlayback, unregisterLiveMediaStarter, type LiveMediaStopReason } from '@/services/live-media-controller';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsAlwaysOnChange } from '@/services/live-stream-settings';
import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { loadYouTubeIframeApi } from '@/services/live-video/youtube-iframe-api';
import { track } from '@/services/analytics';
import { createLiveMediaIdleNotice, trackLiveMediaIdleStop } from './live-media-idle-notice';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


// YouTube IFrame Player API types
type YouTubePlayer = {
  mute(): void;
  unMute(): void;
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(videoId: string): void;
  cueVideoById(videoId: string): void;
  setPlaybackQuality?(quality: string): void;
  getIframe?(): HTMLIFrameElement;
  getVolume?(): number;
  destroy(): void;
};

type YouTubePlayerConstructor = new (
  elementId: string | HTMLElement,
  options: {
    videoId: string;
    host?: string;
    playerVars: Record<string, number | string>;
    events: {
      onReady: () => void;
      onError?: (event: { data: number }) => void;
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

import { DIRECT_HLS_MAP, OPTIONAL_LIVE_CHANNELS, getDefaultLiveChannels, loadChannelsFromStorage, saveChannelsToStorage, type LiveChannel } from '@/services/live-channels';
export { getDefaultLiveChannels, loadChannelsFromStorage } from '@/services/live-channels';

export class LiveNewsPanel extends Panel {
  private channels: LiveChannel[] = [];
  private activeChannel!: LiveChannel;
  private channelSwitcher: HTMLElement | null = null;
  private isMuted = true;
  private isPlaying = false;
  private idleStoppedAfterMs: number | null = null;
  private muteBtn: HTMLButtonElement | null = null;
  private fullscreenBtn: HTMLButtonElement | null = null;
  private isFullscreen = false;
  private liveBtn: HTMLButtonElement | null = null;
  private readonly boundVisibilityHandler = () => {
    if (document.hidden) stopLiveMediaPlayback('live-news', 'hidden');
    else this.startAlwaysOnPlaybackIfVisible();
  };
  private alwaysOn = getLiveStreamsAlwaysOn();
  private unsubscribeStreamSettings: (() => void) | null = null;
  private unsubscribeIdle: (() => void) | null = null;

  // YouTube Player API state
  private player: YouTubePlayer | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerElement: HTMLDivElement | null = null;
  private playerElementId: string;
  private isPlayerReady = false;
  private currentVideoId: string | null = null;
  private readonly youtubeOrigin: string | null;
  private forceFallbackVideoForNextInit = false;

  // Desktop: always use sidecar embed for YouTube (tauri:// origin gets 153).
  // DIRECT_HLS_MAP channels use native <video> instead.
  private useDesktopEmbedProxy = isDesktopRuntime();
  private desktopEmbedIframe: HTMLIFrameElement | null = null;
  private desktopEmbedSession: { iframe: HTMLIFrameElement; channelId: string; sessionToken: number } | null = null;
  private desktopEmbedRenderToken = 0;
  private channelSwitchGeneration = 0;
  private suppressChannelClick = false;
  private channelDragTarget: HTMLElement | null = null;
  private channelDragStarted = false;
  private channelDragStartX = 0;
  private channelDragListenersAttached = false;
  private readonly boundChannelDragMove = (e: MouseEvent): void => {
    if (!this.channelDragTarget || !this.channelSwitcher) return;
    if (!this.channelDragStarted) {
      if (Math.abs(e.clientX - this.channelDragStartX) < 6) return;
      this.channelDragStarted = true;
      this.channelDragTarget.classList.add('live-channel-dragging');
    }
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.live-channel-btn') as HTMLElement | null;
    if (!target || target === this.channelDragTarget) return;
    const all = Array.from(this.channelSwitcher.querySelectorAll('.live-channel-btn'));
    const idx = all.indexOf(this.channelDragTarget);
    const targetIdx = all.indexOf(target);
    if (idx === -1 || targetIdx === -1) return;
    if (idx < targetIdx) {
      target.parentElement?.insertBefore(this.channelDragTarget, target.nextSibling);
    } else {
      target.parentElement?.insertBefore(this.channelDragTarget, target);
    }
  };
  private readonly boundChannelDragUp = (): void => {
    if (!this.channelDragTarget) return;
    if (this.channelDragStarted) {
      this.channelDragTarget.classList.remove('live-channel-dragging');
      this.applyChannelOrderFromDom();
      this.suppressChannelClick = true;
      setTimeout(() => {
        this.suppressChannelClick = false;
      }, 0);
    }
    this.channelDragTarget = null;
    this.channelDragStarted = false;
    this.detachChannelDragListeners();
  };

  private attachChannelDragListeners(): void {
    if (this.channelDragListenersAttached) return;
    document.addEventListener('mousemove', this.boundChannelDragMove);
    document.addEventListener('mouseup', this.boundChannelDragUp);
    this.channelDragListenersAttached = true;
  }

  private detachChannelDragListeners(): void {
    if (!this.channelDragListenersAttached) return;
    document.removeEventListener('mousemove', this.boundChannelDragMove);
    document.removeEventListener('mouseup', this.boundChannelDragUp);
    this.channelDragListenersAttached = false;
  }
  private boundMessageHandler!: (e: MessageEvent) => void;
  private muteSyncInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly MUTE_SYNC_POLL_MS = 500;

  // Bot-check detection: if player doesn't become ready within this timeout,
  // YouTube is likely showing "Sign in to confirm you're not a bot".
  private botCheckTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly BOT_CHECK_TIMEOUT_MS = 15_000;

  // Native HLS <video> element for direct stream playback (bypasses iframe/cookie issues)
  private nativeVideoElement: HTMLVideoElement | null = null;
  private hlsInstance: import('hls.js').default | null = null;
  private hlsFailureCooldown = new Map<string, number>();
  private readonly HLS_COOLDOWN_MS = 5 * 60 * 1000;
  private liveMediaSessionToken = 0;

  private deferredInit = false;
  private lazyObserver: IntersectionObserver | null = null;
  private idleCallbackId: number | ReturnType<typeof setTimeout> | null = null;
  // Play-all cascade: start this panel's channel, but never start a disabled or collapsed panel.
  private readonly boundPlayAllStarter = () => {
    if (this.canHostLiveMedia()) this.triggerInit();
  };

  constructor() {
    super({ id: 'live-news', title: t('panels.liveNews'), className: 'panel-wide', closable: true, collapsible: true });
    this.insertLiveCountBadge(OPTIONAL_LIVE_CHANNELS.length);
    this.youtubeOrigin = LiveNewsPanel.resolveYouTubeOrigin();
    this.playerElementId = `live-news-player-${Date.now()}`;
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    const savedChannelId = loadFromStorage<string>(STORAGE_KEYS.activeChannel, '');
    const savedChannel = savedChannelId ? this.channels.find(c => c.id === savedChannelId) : null;
    this.activeChannel = savedChannel ?? this.channels[0] ?? { id: '', name: '' };
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
    this.setupBridgeMessageListener();
    this.renderPlaceholder();
    this.setupLazyInit();
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
    this.unsubscribeIdle = subscribeLiveMediaIdle((idleAfterMs) => this.stopForIdle(idleAfterMs));
    this.unsubscribeStreamSettings = subscribeLiveStreamsAlwaysOnChange((alwaysOn) => {
      this.alwaysOn = alwaysOn;
      if (!alwaysOn) {
        // Cancel any pending lazy-init so leaving always-on cannot auto-start playback without intent.
        // Anything already playing keeps running — feeds coexist; the idle stop still applies.
        if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
        if (this.idleCallbackId !== null) {
          if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
          else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
          this.idleCallbackId = null;
        }
      }
      if (alwaysOn && !this.deferredInit && this.isPanelVisible()) {
        this.startAlwaysOnPlaybackIfVisible();
      } else if (alwaysOn && !this.deferredInit && !this.lazyObserver) {
        this.setupLazyInit();
      }
    });
    registerLiveMediaStarter('live-news', this.boundPlayAllStarter);
    document.addEventListener('keydown', this.boundFullscreenEscHandler);
  }

  private isPanelVisible(): boolean {
    if (!this.element.isConnected) return false;
    const rect = this.element.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
  }

  private renderPlaceholder(): void {
    this.deferredInit = false;
    this.playerContainer = null;
    this.playerElement = null;
    if (this.idleStoppedAfterMs !== null) {
      this.setContentNodes(createLiveMediaIdleNotice({
        panel: 'live-news',
        heading: this.getChannelDisplayName(this.activeChannel),
        idleAfterMs: this.idleStoppedAfterMs,
      }));
      return;
    }
    setTrustedHtml(this.content, trustedHtml('', "legacy direct innerHTML migration"));
    const container = document.createElement('div');
    container.className = 'live-news-placeholder live-media-shell';

    const status = document.createElement('div');
    status.className = 'live-media-shell-status';
    const dot = document.createElement('span');
    dot.className = 'live-media-shell-dot';
    const statusText = document.createElement('span');
    statusText.textContent = t('components.liveNews.readyStatus') || 'Ready when you are';
    status.append(dot, statusText);

    const label = document.createElement('div');
    label.className = 'live-media-shell-title';
    label.textContent = this.getChannelDisplayName(this.activeChannel);

    const playBtn = document.createElement('button');
    playBtn.className = 'offline-retry';
    playBtn.textContent = t('components.liveNews.playLiveFeed') || 'Play live feed';
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playAllLiveMedia();
    });

    container.appendChild(status);
    container.appendChild(label);
    container.appendChild(playBtn);
    container.addEventListener('click', () => playAllLiveMedia());
    this.content.appendChild(container);
  }

  private setupLazyInit(): void {
    this.lazyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) {
          this.lazyObserver?.disconnect();
          this.lazyObserver = null;
          if (!this.alwaysOn) return;
          if ('requestIdleCallback' in window) {
            this.idleCallbackId = (window as any).requestIdleCallback(
              () => { this.idleCallbackId = null; this.triggerInit(); },
              { timeout: 1000 },
            );
          } else {
            this.idleCallbackId = setTimeout(() => { this.idleCallbackId = null; this.triggerInit(); }, 1000);
          }
        }
      },
      { threshold: 0.1 },
    );
    this.lazyObserver.observe(this.element);
  }

  private triggerInit(): void {
    if (this.deferredInit) return;
    this.deferredInit = true;
    if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
    if (this.idleCallbackId !== null) {
      if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
      else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
      this.idleCallbackId = null;
    }
    this.requestPlaybackForActiveChannel();
  }

  private requestPlaybackForActiveChannel(): void {
    const streamId = this.activeChannel.id;
    requestLiveMediaPlayback(
      'live-news',
      streamId,
      () => this.startPlaybackForActiveChannel(),
      (reason) => this.stopPlaybackFromController(reason),
    );
  }

  private hasPlaybackIntent(): boolean {
    return this.deferredInit ||
      this.isPlaying ||
      !!this.player ||
      !!this.desktopEmbedIframe ||
      !!this.nativeVideoElement ||
      this.ownsLiveNewsMedia() ||
      (this.idleStoppedAfterMs === null && this.alwaysOn && !document.hidden && this.isPanelVisible());
  }

  private ownsLiveMediaForChannel(channelId: string): boolean {
    const activeMedia = getActiveLiveMedia('live-news');
    return activeMedia?.panelId === 'live-news' && activeMedia.streamId === channelId;
  }

  private ownsLiveMediaSession(channelId: string, sessionToken: number): boolean {
    return this.liveMediaSessionToken === sessionToken &&
      this.activeChannel.id === channelId &&
      this.ownsLiveMediaForChannel(channelId);
  }

  private ownsActiveLiveMedia(): boolean {
    return this.ownsLiveMediaForChannel(this.activeChannel.id);
  }

  private ownsLiveNewsMedia(): boolean {
    return getActiveLiveMedia('live-news')?.panelId === 'live-news';
  }

  private startAlwaysOnPlaybackIfVisible(): void {
    if (!this.alwaysOn || document.hidden || !this.element.isConnected || !this.isPanelVisible()) return;
    // An idle stop ends only through Resume or Play, so autoplay must not restart it on tab return.
    if (this.idleStoppedAfterMs !== null || this.ownsActiveLiveMedia()) return;
    this.requestPlaybackForActiveChannel();
  }

  private startPlaybackForActiveChannel(): void {
    this.liveMediaSessionToken += 1;
    this.isPlaying = true;
    this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.renderPlayer();
  }

  private stopPlaybackFromController(reason: LiveMediaStopReason): void {
    this.liveMediaSessionToken += 1;
    this.isPlaying = false;
    if (reason !== 'idle') this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.destroyPlayer();
    // Skip DOM work on a detached panel; destroy() already runs destroyPlayer().
    if (this.element.isConnected) this.renderPlaceholder();
  }

  private saveChannels(): void {
    saveChannelsToStorage(this.channels);
  }

  private getDirectHlsUrl(channelId: string): string | undefined {
    const url = DIRECT_HLS_MAP[channelId];
    if (!url) return undefined;
    const failedAt = this.hlsFailureCooldown.get(channelId);
    if (failedAt && Date.now() - failedAt < this.HLS_COOLDOWN_MS) return undefined;
    return url;
  }

  private get embedOrigin(): string {
    if (isDesktopRuntime()) return `http://localhost:${getLocalApiPort()}`;
    try { return new URL(getRemoteApiBaseUrl()).origin; } catch { return 'https://worldmonitor.app'; }
  }

  private setupBridgeMessageListener(): void {
    this.boundMessageHandler = (e: MessageEvent) => {
      const session = this.desktopEmbedSession;
      if (!session || e.source !== session.iframe.contentWindow) return;
      if (!this.ownsLiveMediaSession(session.channelId, session.sessionToken)) return;
      const expected = this.embedOrigin;
      const localOrigin = getApiBaseUrl();
      if (e.origin !== expected && (!localOrigin || e.origin !== localOrigin)) return;
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || !msg.type) return;
      if (msg.type === 'yt-ready') {
        this.clearBotCheckTimeout();
        this.isPlayerReady = true;
        this.syncDesktopEmbedState();
      } else if (msg.type === 'yt-error') {
        this.clearBotCheckTimeout();
        const code = Number(msg.code ?? 0);
        const channel = this.activeChannel;
        if (code === 153 && channel.fallbackVideoId &&
          channel.videoId !== channel.fallbackVideoId) {
          channel.videoId = channel.fallbackVideoId;
          this.renderDesktopEmbed(true);
        } else {
          this.showEmbedError(channel, code);
        }
      } else if (msg.type === 'yt-mute-state') {
        const muted = msg.muted === true;
        if (this.isMuted !== muted) {
          this.isMuted = muted;
          this.updateMuteIcon();
        }
      }
    };
    window.addEventListener('message', this.boundMessageHandler);
  }

  private static resolveYouTubeOrigin(): string | null {
    const fallbackOrigin = SITE_VARIANT === 'tech'
      ? 'https://worldmonitor.app'
      : 'https://worldmonitor.app';

    try {
      const { protocol, origin, host } = window.location;
      if (protocol === 'http:' || protocol === 'https:') {
        // Desktop webviews commonly run from tauri.localhost which can trigger
        // YouTube embed restrictions. Use canonical public origin instead.
        if (host === 'tauri.localhost' || host.endsWith('.tauri.localhost')) {
          return fallbackOrigin;
        }
        return origin;
      }
      if (protocol === 'tauri:' || protocol === 'asset:') {
        return fallbackOrigin;
      }
    } catch {
      // Ignore invalid location values.
    }
    return fallbackOrigin;
  }


  private stopForIdle(idleAfterMs: number): void {
    if (this.isFullscreen || !this.isPlaying || !getActiveLiveMedia('live-news')) return;
    this.idleStoppedAfterMs = idleAfterMs;
    trackLiveMediaIdleStop('live-news', idleAfterMs);
    stopLiveMediaPlayback('live-news', 'idle');
  }

  private stopMuteSyncPolling(): void {
    if (this.muteSyncInterval !== null) {
      clearInterval(this.muteSyncInterval);
      this.muteSyncInterval = null;
    }
  }

  private startMuteSyncPolling(): void {
    this.stopMuteSyncPolling();
    this.muteSyncInterval = setInterval(() => this.syncMuteStateFromPlayer(), LiveNewsPanel.MUTE_SYNC_POLL_MS);
  }

  private syncMuteStateFromPlayer(): void {
    if (this.useDesktopEmbedProxy || !this.player || !this.isPlayerReady) return;
    const p = this.player as { getVolume?(): number; isMuted?(): boolean };
    const muted = typeof p.isMuted === 'function'
      ? p.isMuted()
      : (p.getVolume?.() === 0);
    if (typeof muted === 'boolean' && muted !== this.isMuted) {
      this.isMuted = muted;
      this.updateMuteIcon();
    }
  }

  private destroyPlayer(): void {
    this.clearBotCheckTimeout();
    this.stopMuteSyncPolling();
    if (this.player) {
      if (typeof this.player.destroy === 'function') this.player.destroy();
      this.player = null;
    }

    if (this.hlsInstance) {
      this.hlsInstance.destroy();
      this.hlsInstance = null;
    }

    if (this.nativeVideoElement) {
      this.nativeVideoElement.pause();
      this.nativeVideoElement.removeAttribute('src');
      this.nativeVideoElement.load();
      this.nativeVideoElement = null;
    }

    this.desktopEmbedIframe = null;
    this.desktopEmbedSession = null;
    this.desktopEmbedRenderToken += 1;
    this.isPlayerReady = false;
    this.currentVideoId = null;

    // Clear the container to remove player/iframe
    if (this.playerContainer) {
      setTrustedHtml(this.playerContainer, trustedHtml('', "legacy direct innerHTML migration"));

      if (!this.useDesktopEmbedProxy) {
        // Recreate player element for JS API mode
        this.playerElement = document.createElement('div');
        this.playerElement.id = this.playerElementId;
        this.playerContainer.appendChild(this.playerElement);
      } else {
        this.playerElement = null;
      }
    }
  }

  private createLiveButton(): void {
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'live-mute-btn';
    this.liveBtn.title = 'Toggle playback';
    this.updateLiveIndicator();
    this.liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlayback();
    });
  }

  private updateLiveIndicator(): void {
    if (!this.liveBtn) return;
    setTrustedHtml(this.liveBtn, trustedHtml(this.isPlaying
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>', "legacy direct innerHTML migration"));
  }

  private togglePlayback(): void {
    if (this.isPlaying || this.player || this.desktopEmbedIframe || this.nativeVideoElement) {
      stopLiveMediaPlayback('live-news', 'user-paused');
      return;
    }

    this.requestPlaybackForActiveChannel();
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
    if (this.liveBtn) header?.appendChild(this.liveBtn);
    header?.appendChild(this.muteBtn);

    this.createFullscreenButton();
  }

  private createFullscreenButton(): void {
    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.className = 'live-mute-btn';
    this.fullscreenBtn.title = 'Fullscreen';
    setTrustedHtml(this.fullscreenBtn, trustedHtml('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', "legacy direct innerHTML migration"));
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('live-news-fullscreen', { entering: !this.isFullscreen });
      this.setFullscreen(!this.isFullscreen);
    });
    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.fullscreenBtn);
  }

  public override supportsFullscreen(): boolean {
    return true;
  }

  public override isFullscreenActive(): boolean {
    return this.isFullscreen;
  }

  public override setFullscreen(fullscreen: boolean): boolean {
    if (this.isFullscreen === fullscreen) return true;
    this.isFullscreen = fullscreen;
    this.element.classList.toggle('live-news-fullscreen', this.isFullscreen);
    document.body.classList.toggle('live-news-fullscreen-active', this.isFullscreen);

    if (this.fullscreenBtn) {
      this.fullscreenBtn.title = this.isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
      setTrustedHtml(this.fullscreenBtn, trustedHtml(this.isFullscreen
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', "legacy direct innerHTML migration"));
    }
    return true;
  }

  private boundFullscreenEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isFullscreen) this.setFullscreen(false);
  };

  private updateMuteIcon(): void {
    if (!this.muteBtn) return;
    setTrustedHtml(this.muteBtn, trustedHtml(this.isMuted
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>', "legacy direct innerHTML migration"));
    this.muteBtn.classList.toggle('unmuted', !this.isMuted);
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteIcon();
    this.syncPlayerState();
  }

  private getChannelDisplayName(channel: LiveChannel): string {
    return channel.name;
  }

  /** Creates a single channel tab button with click and drag handlers. */
  private createChannelButton(channel: LiveChannel): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `live-channel-btn ${channel.id === this.activeChannel.id ? 'active' : ''}`;
    btn.setAttribute('aria-pressed', String(channel.id === this.activeChannel.id));
    btn.dataset.channelId = channel.id;

    btn.textContent = this.getChannelDisplayName(channel);

    btn.style.cursor = 'grab';
    // Keyboard parity for the mouse drag reorder in createChannelSwitcher:
    // arrows move the focused channel one slot and persist through the same
    // applyChannelOrderFromDom path a completed drag uses.
    btn.addEventListener('keydown', (e) => {
      const back = e.key === 'ArrowLeft';
      const fwd = e.key === 'ArrowRight';
      if (!back && !fwd) return;
      const sibling = back ? btn.previousElementSibling : btn.nextElementSibling;
      if (!(sibling instanceof HTMLElement) || !sibling.classList.contains('live-channel-btn')) return;
      e.preventDefault();
      btn.parentElement?.insertBefore(btn, back ? sibling : sibling.nextElementSibling);
      this.applyChannelOrderFromDom();
      btn.focus();
    });
    btn.addEventListener('click', (e) => {
      if (this.suppressChannelClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      this.switchChannel(channel);
    });
    return btn;
  }

  private createChannelSwitcher(): void {
    this.channelSwitcher = document.createElement('div');
    this.channelSwitcher.className = 'live-news-switcher';

    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }

    this.channelSwitcher.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const btn = (e.target as HTMLElement).closest('.live-channel-btn') as HTMLElement | null;
      if (!btn) return;
      this.suppressChannelClick = false;
      this.channelDragTarget = btn;
      this.channelDragStarted = false;
      this.channelDragStartX = e.clientX;
      this.attachChannelDragListeners();
      e.preventDefault();
    });

    const toolbar = document.createElement('div');
    toolbar.className = 'live-news-toolbar';
    toolbar.appendChild(this.channelSwitcher);
    this.createManageButton(toolbar);
    this.element.insertBefore(toolbar, this.content);
  }

  private createManageButton(toolbar: HTMLElement): void {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'live-news-settings-btn';
    openBtn.title = t('components.liveNews.channelSettings') ?? 'Channel Settings';
    setTrustedHtml(openBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', "legacy direct innerHTML migration"));
    openBtn.addEventListener('click', () => {
      this.openChannelManagementModal();
    });
    toolbar.appendChild(openBtn);
  }

  private openChannelManagementModal(): void {
    const existing = document.querySelector('.live-channels-modal-overlay');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.className = 'live-channels-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('components.liveNews.manage') ?? 'Manage channels');

    const modal = document.createElement('div');
    modal.className = 'live-channels-modal';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'live-channels-modal-close';
    closeBtn.setAttribute('aria-label', t('common.close') ?? 'Close');
    setTrustedHtml(closeBtn, trustedHtml('&times;', "legacy direct innerHTML migration"));

    const container = document.createElement('div');

    modal.appendChild(closeBtn);
    modal.appendChild(container);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('active'));

    import('@/live-channels-window').then(async ({ initLiveChannelsWindow }) => {
      await initLiveChannelsWindow(container);
    }).catch(console.error);

    const close = () => {
      focusTrap.deactivate();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      this.refreshChannelsFromStorage();
    };
    const focusTrap = createFocusTrap(overlay);
    focusTrap.activate();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
  }

  private refreshChannelSwitcher(): void {
    if (!this.channelSwitcher) return;
    setTrustedHtml(this.channelSwitcher, trustedHtml('', "legacy direct innerHTML migration"));
    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }
  }

  private applyChannelOrderFromDom(): void {
    if (!this.channelSwitcher) return;
    const ids = Array.from(this.channelSwitcher.querySelectorAll<HTMLElement>('.live-channel-btn'))
      .map((el) => el.dataset.channelId)
      .filter((id): id is string => !!id);
    const orderMap = new Map(this.channels.map((c) => [c.id, c]));
    this.channels = ids.map((id) => orderMap.get(id)).filter((c): c is LiveChannel => !!c);
    this.saveChannels();
  }

  private async resolveChannelVideo(channel: LiveChannel, forceFallback = false): Promise<void> {
    const useFallbackVideo = channel.useFallbackOnly || forceFallback;

    if (this.getDirectHlsUrl(channel.id) || channel.hlsUrl) {
      channel.videoId = channel.fallbackVideoId;
      channel.isLive = true;
      return;
    }

    if (useFallbackVideo) {
      channel.videoId = channel.fallbackVideoId;
      channel.isLive = false;
      return;
    }

    // Skip fetchLiveVideoInfo for channels without handle (HLS-only)
    if (!channel.handle) {
      channel.videoId = channel.fallbackVideoId;
      channel.isLive = false;
      return;
    }

    const info = await fetchLiveVideoInfo(channel.handle);
    channel.videoId = info.videoId || channel.fallbackVideoId;
    channel.isLive = !!info.videoId;
    // Don't re-apply an hlsUrl while the channel is on HLS failure cooldown —
    // prevents an infinite retry loop in browsers (e.g. Firefox) that reject
    // YouTube HLS manifests via CORS. The cooldown lets the embed fallback run.
    const failedAt = this.hlsFailureCooldown.get(channel.id);
    const hlsCooldownActive = failedAt !== undefined && Date.now() - failedAt < this.HLS_COOLDOWN_MS;
    channel.hlsUrl = (!hlsCooldownActive && info.hlsUrl) ? info.hlsUrl : undefined;
  }

  private resetChannelButtonLoading(btn: HTMLElement): void {
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    (btn as HTMLButtonElement).disabled = false;
  }

  // Clear every channel button, not only `.loading`. Success used to drop the
  // spinner class while leaving aria-busy/disabled set, and a later switch
  // could strip `.loading` from a still-disabled predecessor.
  private clearChannelLoadingState(): void {
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      this.resetChannelButtonLoading(btn as HTMLElement);
    });
  }

  private markChannelButtonLoading(channelId: string): void {
    this.clearChannelLoadingState();
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      if (btnEl.dataset.channelId !== channelId) return;
      btnEl.classList.add('loading');
      // CSS blocks the pointer during load (pointer-events: none); mirror
      // that for keyboard/AT instead of leaving a silently dead button.
      btnEl.setAttribute('aria-busy', 'true');
      (btnEl as HTMLButtonElement).disabled = true;
    });
  }

  private async switchChannel(channel: LiveChannel): Promise<void> {
    if (channel.id === this.activeChannel.id) return;

    const generation = ++this.channelSwitchGeneration;
    this.activeChannel = channel;
    saveToStorage(STORAGE_KEYS.activeChannel, channel.id);
    const shouldStartMedia = this.hasPlaybackIntent();
    const hadLiveNewsOwnership = this.ownsLiveNewsMedia();

    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      const isActive = btnEl.dataset.channelId === channel.id;
      btnEl.classList.toggle('active', isActive);
      btnEl.setAttribute('aria-pressed', String(isActive));
    });

    if (!shouldStartMedia) {
      this.clearChannelLoadingState();
      this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
        (btn as HTMLElement).classList.remove('offline');
      });
      this.renderPlaceholder();
      return;
    }

    this.markChannelButtonLoading(channel.id);

    try {
      await this.resolveChannelVideo(channel);
      if (generation !== this.channelSwitchGeneration) return;
      if (!this.element?.isConnected) return;
      if (this.activeChannel.id !== channel.id) return;
      if (hadLiveNewsOwnership && !this.ownsLiveNewsMedia()) {
        this.renderPlaceholder();
        return;
      }
      if (!this.hasPlaybackIntent()) {
        this.renderPlaceholder();
        return;
      }

      this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
        const btnEl = btn as HTMLElement;
        if (btnEl.dataset.channelId === channel.id && !channel.videoId) {
          btnEl.classList.add('offline');
        }
      });

      this.requestPlaybackForActiveChannel();
    } finally {
      if (generation === this.channelSwitchGeneration) {
        this.clearChannelLoadingState();
      }
    }
  }

  private showOfflineMessage(channel: LiveChannel): void {
    this.destroyPlayer();
    const safeName = escapeHtml(channel.name);
    // #6557: a terminal offline state is authoritative content.
    this.setTrustedContent(trustedHtml(`
      <div class="live-offline live-offline-compact">
        <div class="offline-icon">📺</div>
        <div class="offline-text">${t('components.liveNews.notLive', { name: safeName })}</div>
        <button class="offline-retry" data-live-retry>${t('common.retry')}</button>
      </div>
    `, "legacy direct innerHTML migration"));
    // The repo's last inline onclick= lived here (CSP unsafe-inline
    // dependency). switchChannel no-ops when the id is already active, so
    // retry must re-request playback for the current stream.
    this.content.querySelector('[data-live-retry]')?.addEventListener('click', () => {
      this.requestPlaybackForActiveChannel();
    });
  }

  private showEmbedError(channel: LiveChannel, errorCode: number): void {
    this.destroyPlayer();
    const watchUrl = channel.videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(channel.videoId)}`
      : channel.handle
      ? `https://www.youtube.com/${encodeURIComponent(channel.handle)}`
      : 'https://www.youtube.com';
    const safeName = escapeHtml(channel.name);

    // #6557: a terminal embed-error state is authoritative content.
    this.setTrustedContent(trustedHtml(`
      <div class="live-offline live-offline-compact">
        <div class="offline-icon">!</div>
        <div class="offline-text">${t('components.liveNews.cannotEmbed', { name: safeName, code: String(errorCode) })}</div>
        <a class="offline-retry" href="${sanitizeUrl(watchUrl)}" target="_blank" rel="noopener noreferrer">${t('components.liveNews.openOnYouTube')}</a>
      </div>
    `, "legacy direct innerHTML migration"));
  }

  private renderPlayer(): void {
    this.ensurePlayerContainer();
    void this.initializePlayer();
  }

  private ensurePlayerContainer(): void {
    this.deferredInit = true;
    setTrustedHtml(this.content, trustedHtml('', "legacy direct innerHTML migration"));
    this.playerContainer = document.createElement('div');
    this.playerContainer.className = 'live-news-player';

    if (!this.useDesktopEmbedProxy) {
      this.playerElement = document.createElement('div');
      this.playerElement.id = this.playerElementId;
      this.playerContainer.appendChild(this.playerElement);
    } else {
      this.playerElement = null;
    }

    this.content.appendChild(this.playerContainer);
  }

  private postToEmbed(msg: Record<string, unknown>): void {
    if (!this.desktopEmbedIframe?.contentWindow) return;
    this.desktopEmbedIframe.contentWindow.postMessage(msg, this.embedOrigin);
  }

  private syncDesktopEmbedState(): void {
    this.postToEmbed({ type: this.isPlaying ? 'play' : 'pause' });
    this.postToEmbed({ type: this.isMuted ? 'mute' : 'unmute' });
  }

  private renderDesktopEmbed(force = false): void {
    if (!this.useDesktopEmbedProxy) return;
    void this.renderDesktopEmbedAsync(force);
  }

  private async renderDesktopEmbedAsync(force = false): Promise<void> {
    const channelId = this.activeChannel.id;
    const sessionToken = this.liveMediaSessionToken;
    const videoId = this.activeChannel.videoId;
    if (!videoId) {
      this.showOfflineMessage(this.activeChannel);
      return;
    }

    // Only recreate iframe when video ID changes (not for play/mute toggling).
    if (!force && this.currentVideoId === videoId && this.desktopEmbedIframe) {
      this.syncDesktopEmbedState();
      return;
    }

    const renderToken = ++this.desktopEmbedRenderToken;
    this.currentVideoId = videoId;
    this.isPlayerReady = true;

    // Always recreate if container was removed from DOM (e.g. showEmbedError replaced content).
    if (!this.playerContainer || !this.playerContainer.parentElement) {
      this.ensurePlayerContainer();
    }

    if (!this.playerContainer) {
      return;
    }

    this.desktopEmbedIframe = null;
    this.desktopEmbedSession = null;
    setTrustedHtml(this.playerContainer, trustedHtml('', "legacy direct innerHTML migration"));

    // Use local sidecar embed — YouTube rejects tauri:// parent origin with error 153,
    // and Vercel WAF blocks cloud bridge iframe loads. The sidecar serves the embed from
    // http://127.0.0.1:PORT which YouTube accepts and has no WAF.
    const quality = getStreamQuality();
    const params = new URLSearchParams({
      videoId,
      autoplay: this.isPlaying ? '1' : '0',
      mute: this.isMuted ? '1' : '0',
    });
    if (quality !== 'auto') params.set('vq', quality);
    // origin = canonical site origin YouTube trusts for embed restrictions.
    // parentOrigin = actual parent frame origin so postMessage round-trips work.
    params.set('origin', this.youtubeOrigin || 'https://worldmonitor.app');
    params.set('parentOrigin', window.location.origin);
    const embedUrl = `http://localhost:${getLocalApiPort()}/api/youtube-embed?${params.toString()}`;

    if (renderToken !== this.desktopEmbedRenderToken || !this.ownsLiveMediaSession(channelId, sessionToken)) {
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'live-news-embed-frame';
    iframe.src = embedUrl;
    iframe.title = `${this.activeChannel.name} live feed`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; storage-access';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('loading', 'eager');

    this.desktopEmbedIframe = iframe;
    this.desktopEmbedSession = { iframe, channelId, sessionToken };
    this.playerContainer.appendChild(iframe);
    this.startBotCheckTimeout();
  }

  private async renderNativeHlsPlayer(): Promise<void> {
    const hlsUrl = this.getDirectHlsUrl(this.activeChannel.id) || this.activeChannel.hlsUrl;
    if (!hlsUrl || !(hlsUrl.startsWith('https://') || hlsUrl.startsWith('http://127.0.0.1'))) return;
    const sessionToken = this.liveMediaSessionToken;

    this.destroyPlayer();
    this.ensurePlayerContainer();
    if (!this.playerContainer) return;
    setTrustedHtml(this.playerContainer, trustedHtml('', "legacy direct innerHTML migration"));

    const video = document.createElement('video');
    video.className = 'live-news-native-video';
    video.autoplay = this.isPlaying;
    video.muted = this.isMuted;
    video.playsInline = true;
    video.controls = true;
    video.setAttribute('referrerpolicy', 'no-referrer');
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';

    const failedChannel = this.activeChannel;

    let hlsErrorFired = false;
    const onHlsFatalError = () => {
      if (hlsErrorFired) return;
      hlsErrorFired = true;
      console.warn('[LiveNews] HLS fatal error for', failedChannel.id, hlsUrl);
      if (this.hlsInstance) { this.hlsInstance.destroy(); this.hlsInstance = null; }
      video.pause();
      video.removeAttribute('src');
      this.nativeVideoElement = null;
      this.hlsFailureCooldown.set(failedChannel.id, Date.now());
      failedChannel.hlsUrl = undefined;

      if (this.ownsLiveMediaSession(failedChannel.id, sessionToken)) {
        this.ensurePlayerContainer();
        void this.initializePlayer();
      }
    };

    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
    if (nativeHls) {
      // Safari / WKWebView: native HLS support
      video.src = hlsUrl;
      video.addEventListener('error', onHlsFatalError);
    } else {
      // Chrome / Firefox: lazy-load hls.js only when needed
      const { default: Hls } = await import('hls.js');
      if (!this.element?.isConnected || !this.ownsLiveMediaSession(failedChannel.id, sessionToken)) return;
      if (!Hls.isSupported()) {
        // No HLS support at all — fall through to YouTube
        onHlsFatalError();
        return;
      }
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      this.hlsInstance = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      // Monitor both hls.js fatal events and raw media element errors (e.g. decode failures).
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onHlsFatalError();
      });
      video.addEventListener('error', onHlsFatalError);
    }

    video.addEventListener('volumechange', () => {
      if (!this.nativeVideoElement) return;
      const muted = this.nativeVideoElement.muted || this.nativeVideoElement.volume === 0;
      if (muted !== this.isMuted) {
        this.isMuted = muted;
        this.updateMuteIcon();
      }
    });

    video.addEventListener('pause', () => {
      if (!this.nativeVideoElement) return;
      if (this.isPlaying) {
        this.isPlaying = false;
        this.updateLiveIndicator();
      }
    });

    video.addEventListener('play', () => {
      if (!this.nativeVideoElement) return;
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.updateLiveIndicator();
      }
    });

    this.nativeVideoElement = video;
    this.playerContainer.appendChild(video);
    this.isPlayerReady = true;
    this.currentVideoId = this.activeChannel.videoId || null;

    // WKWebView blocks autoplay without user gesture. Force muted play, then restore.
    if (this.isPlaying) {
      const wantUnmute = !this.isMuted;
      video.muted = true;
      video.play()?.then(() => {
        if (wantUnmute && this.nativeVideoElement === video && this.ownsLiveMediaSession(failedChannel.id, sessionToken)) {
          video.muted = false;
        }
      }).catch(() => {});
    }
  }

  private syncNativeVideoState(): void {
    if (!this.nativeVideoElement) return;
    this.nativeVideoElement.muted = this.isMuted;
    if (this.isPlaying) {
      this.nativeVideoElement.play()?.catch(() => {});
    } else {
      this.nativeVideoElement.pause();
    }
  }

  private async initializePlayer(): Promise<void> {
    if (!this.useDesktopEmbedProxy && !this.nativeVideoElement && this.player) return;

    const channel = this.activeChannel;
    const channelId = channel.id;
    const sessionToken = this.liveMediaSessionToken;
    const useFallbackVideo = channel.useFallbackOnly || this.forceFallbackVideoForNextInit;
    this.forceFallbackVideoForNextInit = false;
    await this.resolveChannelVideo(channel, useFallbackVideo);
    if (!this.element?.isConnected) return;
    if (!this.ownsLiveMediaSession(channelId, sessionToken)) return;

    if (this.getDirectHlsUrl(this.activeChannel.id) || this.activeChannel.hlsUrl) {
      void this.renderNativeHlsPlayer();
      return;
    }

    if (!this.activeChannel.videoId || !/^[\w-]{10,12}$/.test(this.activeChannel.videoId)) {
      this.showOfflineMessage(this.activeChannel);
      return;
    }

    if (this.useDesktopEmbedProxy) {
      this.renderDesktopEmbed(true);
      return;
    }

    await loadYouTubeIframeApi();
    if (!this.element?.isConnected) return;
    if (!this.ownsLiveMediaSession(channelId, sessionToken)) return;
    if (this.player || !this.playerElement || !window.YT?.Player) return;

    // When YT.Player receives a DOM element it replaces that element in the
    // parent — the mutation fires on playerContainer, not inside playerElement.
    // Passing the string ID instead makes the API insert the iframe *as a child*
    // of the div, which the observer on playerContainer can catch.
    // We add storage-access so YouTube can call requestStorageAccess() and
    // access the user's cached session (avoids bot-check for signed-in users).
    const storageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLIFrameElement) {
            let isYouTube = false;
            try {
              const parsed = new URL(node.src);
              isYouTube = parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com');
            } catch {
              isYouTube = false;
            }
            if (!isYouTube) continue;
            const cur = node.getAttribute('allow') || '';
            if (!cur.includes('storage-access')) {
              node.setAttribute('allow', cur ? `${cur}; storage-access` : 'storage-access');
            }
            storageObserver.disconnect();
            if (observerTimeout !== null) clearTimeout(observerTimeout);
            return;
          }
        }
      }
    });
    // Auto-disconnect after 10 s to avoid leaking the observer if the iframe
    // never appears (e.g. YT.Player throws or the API fails to load).
    let observerTimeout: ReturnType<typeof setTimeout> | null = null;
    if (this.playerContainer) {
      storageObserver.observe(this.playerContainer, { childList: true, subtree: true });
      observerTimeout = setTimeout(() => storageObserver.disconnect(), 10_000);
    }

    const playerChannelId = this.activeChannel.id;
    const playerSessionToken = this.liveMediaSessionToken;
    try {
      this.player = new window.YT!.Player(this.playerElementId, {
      host: 'https://www.youtube.com',
      videoId: this.activeChannel.videoId,
      playerVars: {
        autoplay: this.isPlaying ? 1 : 0,
        mute: this.isMuted ? 1 : 0,
        rel: 0,
        playsinline: 1,
        enablejsapi: 1,
        ...(this.youtubeOrigin
          ? {
            origin: this.youtubeOrigin,
            widget_referrer: this.youtubeOrigin,
          }
          : {}),
      },
      events: {
        onReady: () => {
          if (!this.ownsLiveMediaSession(playerChannelId, playerSessionToken)) return;
          this.clearBotCheckTimeout();
          this.isPlayerReady = true;
          this.currentVideoId = this.activeChannel.videoId || null;
          const iframe = this.player?.getIframe?.();
          if (iframe) iframe.referrerPolicy = 'strict-origin-when-cross-origin';
          const quality = getStreamQuality();
          if (quality !== 'auto') this.player?.setPlaybackQuality?.(quality);
          this.syncPlayerState();
          this.startMuteSyncPolling();
        },
        onError: (event) => {
          if (!this.ownsLiveMediaSession(playerChannelId, playerSessionToken)) return;
          this.clearBotCheckTimeout();
          const errorCode = Number(event?.data ?? 0);

          // Retry once with known fallback stream.
          if (
            errorCode === 153 &&
            this.activeChannel.fallbackVideoId &&
            this.activeChannel.videoId !== this.activeChannel.fallbackVideoId
          ) {
            this.destroyPlayer();
            this.forceFallbackVideoForNextInit = true;
            this.ensurePlayerContainer();
            void this.initializePlayer();
            return;
          }

          // Desktop-specific last resort: switch to cloud bridge embed.
          if (errorCode === 153 && isDesktopRuntime()) {
            this.useDesktopEmbedProxy = true;
            this.destroyPlayer();
            this.ensurePlayerContainer();
            this.renderDesktopEmbed(true);
            return;
          }

          this.destroyPlayer();
          this.showEmbedError(this.activeChannel, errorCode);
        },
      },
    });
    } catch (err) {
      // YT.Player constructor threw — disconnect the observer so it doesn't leak.
      storageObserver.disconnect();
      if (observerTimeout !== null) clearTimeout(observerTimeout);
      throw err;
    }

    this.startBotCheckTimeout();
  }

  private startBotCheckTimeout(): void {
    this.clearBotCheckTimeout();
    const channelId = this.activeChannel.id;
    const sessionToken = this.liveMediaSessionToken;
    this.botCheckTimeout = setTimeout(() => {
      this.botCheckTimeout = null;
      if (!this.isPlayerReady && this.ownsLiveMediaSession(channelId, sessionToken)) {
        this.showBotCheckPrompt();
      }
    }, LiveNewsPanel.BOT_CHECK_TIMEOUT_MS);
  }

  private clearBotCheckTimeout(): void {
    if (this.botCheckTimeout) {
      clearTimeout(this.botCheckTimeout);
      this.botCheckTimeout = null;
    }
  }

  private showBotCheckPrompt(): void {
    const channel = this.activeChannel;
    const watchUrl = channel.videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(channel.videoId)}`
      : channel.handle
      ? `https://www.youtube.com/${encodeURIComponent(channel.handle)}`
      : 'https://www.youtube.com';

    this.destroyPlayer();
    setTrustedHtml(this.content, trustedHtml('', "legacy direct innerHTML migration"));

    const wrapper = document.createElement('div');
    wrapper.className = 'live-offline live-offline-compact';

    const icon = document.createElement('div');
    icon.className = 'offline-icon';
    icon.textContent = '\u26A0\uFE0F';

    const text = document.createElement('div');
    text.className = 'offline-text';
    text.textContent = t('components.liveNews.botCheck', { name: channel.name }) || 'YouTube is requesting sign-in verification';

    const actions = document.createElement('div');
    actions.className = 'bot-check-actions';

    const signinBtn = document.createElement('button');
    signinBtn.className = 'offline-retry bot-check-signin';
    signinBtn.textContent = t('components.liveNews.signInToYouTube') || 'Sign in to YouTube';
    signinBtn.addEventListener('click', () => this.openYouTubeSignIn());

    const retryBtn = document.createElement('button');
    retryBtn.className = 'offline-retry bot-check-retry';
    retryBtn.textContent = t('common.retry') || 'Retry';
    retryBtn.addEventListener('click', () => {
      this.ensurePlayerContainer();
      if (this.useDesktopEmbedProxy) {
        this.renderDesktopEmbed(true);
      } else {
        void this.initializePlayer();
      }
    });

    const ytLink = document.createElement('a');
    ytLink.className = 'offline-retry';
    ytLink.href = watchUrl;
    ytLink.target = '_blank';
    ytLink.rel = 'noopener noreferrer';
    ytLink.textContent = t('components.liveNews.openOnYouTube') || 'Open on YouTube';

    actions.append(signinBtn, retryBtn, ytLink);
    wrapper.append(icon, text, actions);
    this.content.appendChild(wrapper);
  }

  private async openYouTubeSignIn(): Promise<void> {
    const youtubeLoginUrl = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/';
    if (isDesktopRuntime()) {
      try {
        const { tryInvokeTauri } = await import('@/services/tauri-bridge');
        await tryInvokeTauri('open_youtube_login');
      } catch {
        window.open(youtubeLoginUrl, '_blank', 'noopener,noreferrer');
      }
    } else {
      window.open(youtubeLoginUrl, '_blank', 'noopener,noreferrer');
    }
  }

  private syncPlayerState(): void {
    // Native HLS <video> (desktop + web for CORS-enabled streams)
    if (this.nativeVideoElement) {
      const videoId = this.activeChannel.videoId;
      if (videoId && this.currentVideoId !== videoId) {
        // Channel changed — reinitialize
        void this.initializePlayer();
      } else {
        this.syncNativeVideoState();
      }
      return;
    }

    if (this.useDesktopEmbedProxy) {
      const videoId = this.activeChannel.videoId;
      if (videoId && this.currentVideoId !== videoId) {
        this.renderDesktopEmbed(true);
      } else {
        this.syncDesktopEmbedState();
      }
      return;
    }

    if (!this.player || !this.isPlayerReady) return;

    const videoId = this.activeChannel.videoId;
    if (!videoId) return;

    // Handle channel switch
    const isNewVideo = this.currentVideoId !== videoId;
    if (isNewVideo) {
      this.currentVideoId = videoId;
      if (!this.playerElement || !document.getElementById(this.playerElementId)) {
        this.ensurePlayerContainer();
        void this.initializePlayer();
        return;
      }
      if (this.isPlaying) {
        if (typeof this.player.loadVideoById === 'function') {
          this.player.loadVideoById(videoId);
        }
      } else {
        if (typeof this.player.cueVideoById === 'function') {
          this.player.cueVideoById(videoId);
        }
      }
    }

    if (this.isMuted) {
      this.player.mute?.();
    } else {
      this.player.unMute?.();
    }

    if (this.isPlaying) {
      if (isNewVideo) {
        // WKWebView loses user gesture context after await.
        // Pause then play after a delay — mimics the manual workaround.
        this.player.pauseVideo?.();
        setTimeout(() => {
          if (this.player && this.isPlaying) {
            this.player.mute?.();
            this.player.playVideo?.();
            // Restore mute state after play starts
            if (!this.isMuted) {
              setTimeout(() => { this.player?.unMute?.(); }, 500);
            }
          }
        }, 800);
      } else {
        this.player.playVideo?.();
      }
    } else {
      this.player.pauseVideo?.();
    }
  }

  public refresh(): void {
    this.syncPlayerState();
  }

  /** Reload channel list from storage (e.g. after edit in separate channel management window). */
  public refreshChannelsFromStorage(): void {
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    this.refreshChannelSwitcher();
    if (this.channels.length === 0) {
      this.renderPlaceholder();
      return;
    }
    if (!this.channels.some((c) => c.id === this.activeChannel.id)) {
      void this.switchChannel(this.channels[0]!);
    }
  }

  public stopLiveMediaForClose(): void {
    this.liveMediaSessionToken += 1;
    const wasIdleStopped = this.idleStoppedAfterMs !== null;
    this.idleStoppedAfterMs = null;
    stopLiveMediaPlayback('live-news', 'destroyed');
    if (wasIdleStopped || this.player || this.desktopEmbedIframe || this.nativeVideoElement) {
      this.isPlaying = false;
      this.updateLiveIndicator();
      this.destroyPlayer();
      this.renderPlaceholder();
    }
  }

  public resumeLiveMediaForShow(): void {
    if (!this.alwaysOn) return;
    if (this.isPanelVisible()) {
      this.startAlwaysOnPlaybackIfVisible();
    } else if (!this.lazyObserver) {
      this.setupLazyInit();
    }
  }

  public destroy(): void {
    this.liveMediaSessionToken += 1;
    unregisterLiveMediaStarter('live-news', this.boundPlayAllStarter);
    releaseLiveMediaPlayback('live-news');
    this.destroyPlayer();
    this.unsubscribeStreamSettings?.();
    this.unsubscribeStreamSettings = null;
    this.unsubscribeIdle?.();
    this.unsubscribeIdle = null;

    if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
    if (this.idleCallbackId !== null) {
      if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
      else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
      this.idleCallbackId = null;
    }

    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    document.removeEventListener('keydown', this.boundFullscreenEscHandler);
    this.detachChannelDragListeners();
    window.removeEventListener('message', this.boundMessageHandler);
    if (this.isFullscreen) this.setFullscreen(false);

    this.playerContainer = null;

    super.destroy();
  }
}
