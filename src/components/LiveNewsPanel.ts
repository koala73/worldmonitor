import { Panel } from './Panel';
import { isDesktopRuntime } from '@/services/runtime';
import { t } from '../services/i18n';
import { createFocusTrap } from '@/utils/focus-trap';
import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS } from '@/config';

import { getActiveLiveMedia, playAllLiveMedia, registerLiveMediaStarter, releaseLiveMediaPlayback, requestLiveMediaPlayback, stopLiveMediaPlayback, unregisterLiveMediaStarter, type LiveMediaStopReason } from '@/services/live-media-controller';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsAlwaysOnChange } from '@/services/live-stream-settings';
import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { sourceListsChannel, type LiveVideoSource, type OfflineReason } from '@/services/live-video/model';
import { withResolvedLiveVideos } from '@/services/live-video/resolved';
import { createFailureMemory, openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';
import { track } from '@/services/analytics';
import { createLiveMediaIdleNotice, trackLiveMediaIdleStop } from './live-media-idle-notice';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { OPTIONAL_LIVE_CHANNELS, getDefaultLiveChannels, hasBuiltinStreams, liveVideoSourceFor, loadChannelsFromStorage, saveChannelsToStorage, type LiveChannel } from '@/services/live-channels';
import { declareOverlay } from '@/utils/open-modal';
export { getDefaultLiveChannels, loadChannelsFromStorage } from '@/services/live-channels';

function offlineReasonText(reason: OfflineReason, name: string): string {
  switch (reason) {
    case 'embed-blocked': return t('components.liveNews.embedBlocked', { name });
    case 'unavailable': return t('components.liveNews.unavailable', { name });
    case 'no-entries': return t('components.liveNews.noStream', { name });
    case 'needs-channel-url': return t('components.liveNews.needsChannelUrl', { name });
    case 'insecure-url': return t('components.liveNews.insecureStream', { name });
    case 'not-live':
    case 'stream-ended': return t('components.liveNews.notLive', { name });
  }
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'offline-retry';
  button.textContent = label;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

function youtubeLink(watchUrl: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'offline-retry';
  link.href = watchUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('components.liveNews.openOnYouTube') || 'Open on YouTube';
  link.addEventListener('click', (e) => e.stopPropagation());
  return link;
}

/**
 * An explicit start (a channel click, Retry, the header play button) explains an offline channel.
 * An implicit one (play-all, auto-play, Resume) moves on to the next channel instead.
 */
type PlaybackOrigin = 'explicit' | 'implicit';

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

  // One verified live session for the active channel. Callbacks from a replaced session carry a stale generation.
  private videoSession: LiveVideoSession | null = null;
  // A player waiting for the resolved channel map before its session opens (renderPlayer).
  private pendingMount = false;
  private videoPhase: LiveVideoState['phase'] | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerGeneration = 0;
  private playbackOrigin: PlaybackOrigin = 'implicit';
  // Channels an implicit start already found offline, so it never skips in a circle.
  private skippedChannelIds = new Set<string>();
  // When each channel was last found offline. Implicit starts and "Play next channel" pass over it meanwhile.
  private readonly failureMemory = createFailureMemory();
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

  private deferredInit = false;
  private lazyObserver: IntersectionObserver | null = null;
  private idleCallbackId: number | ReturnType<typeof setTimeout> | null = null;
  /** Removes the open channel-management overlay and its document listener. Null while none is open. */
  private dismissChannelManagementModal: (() => void) | null = null;
  // Play-all cascade: start this panel's channel, but never start a disabled or collapsed panel.
  private readonly boundPlayAllStarter = () => {
    if (this.canHostLiveMedia()) this.triggerInit();
  };

  constructor() {
    super({ id: 'live-news', title: t('panels.liveNews'), className: 'panel-wide', closable: true, collapsible: true });
    this.insertLiveCountBadge(OPTIONAL_LIVE_CHANNELS.filter(hasBuiltinStreams).length);
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    const savedChannelId = loadFromStorage<string>(STORAGE_KEYS.activeChannel, '');
    const savedChannel = savedChannelId ? this.channels.find(c => c.id === savedChannelId) : null;
    this.activeChannel = savedChannel ?? this.channels[0] ?? { id: '', name: '' };
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
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
    if (this.idleStoppedAfterMs !== null) {
      this.setContentNodes(createLiveMediaIdleNotice({
        panel: 'live-news',
        heading: this.getChannelDisplayName(this.activeChannel),
        idleAfterMs: this.idleStoppedAfterMs,
      }));
      return;
    }
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
    this.setContentNodes(container);
  }

  private setupLazyInit(): void {
    this.lazyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) {
          this.lazyObserver?.disconnect();
          this.lazyObserver = null;
          // An idle stop ends only through Resume or Play; scrolling back into view is neither.
          if (!this.alwaysOn || this.idleStoppedAfterMs !== null) return;
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
    this.beginPlayback('implicit');
  }

  /** Starts the active channel. The origin decides what an offline channel does: explain itself, or hand over. */
  private beginPlayback(origin: PlaybackOrigin): void {
    this.playbackOrigin = origin;
    this.skippedChannelIds.clear();
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
      this.videoSession !== null ||
      this.pendingMount ||
      this.ownsLiveNewsMedia() ||
      (this.idleStoppedAfterMs === null && this.alwaysOn && !document.hidden && this.isPanelVisible());
  }

  private ownsLiveMediaForChannel(channelId: string): boolean {
    const activeMedia = getActiveLiveMedia('live-news');
    return activeMedia?.panelId === 'live-news' && activeMedia.streamId === channelId;
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
    this.beginPlayback('implicit');
  }

  private startPlaybackForActiveChannel(): void {
    this.isPlaying = true;
    this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.renderPlayer();
  }

  private stopPlaybackFromController(reason: LiveMediaStopReason): void {
    this.isPlaying = false;
    if (reason !== 'idle') this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.clearChannelLoadingState();
    this.destroyPlayer();
    // Skip DOM work on a detached panel; destroy() already runs destroyPlayer().
    if (this.element.isConnected) this.renderPlaceholder();
  }

  private saveChannels(): void {
    saveChannelsToStorage(this.channels);
  }

  private stopForIdle(idleAfterMs: number): void {
    if (this.isFullscreen || !this.isPlaying || !getActiveLiveMedia('live-news')) return;
    this.idleStoppedAfterMs = idleAfterMs;
    trackLiveMediaIdleStop('live-news', idleAfterMs);
    stopLiveMediaPlayback('live-news', 'idle');
  }

  private destroyPlayer(): void {
    this.playerGeneration += 1;
    this.pendingMount = false;
    this.videoSession?.destroy();
    this.videoSession = null;
    this.videoPhase = null;
    this.playerContainer = null;
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
    if (this.isPlaying || this.videoSession || this.pendingMount) {
      stopLiveMediaPlayback('live-news', 'user-paused');
      return;
    }

    this.beginPlayback('explicit');
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
    this.videoSession?.setMuted(this.isMuted);
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
      // A connecting channel keeps focus (it is never disabled), so its repeat clicks are ignored here.
      if (btn.getAttribute('aria-busy') === 'true') return;
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
    declareOverlay(overlay, { reload: 'blocking' });
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

    const dismiss = () => {
      focusTrap.deactivate();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      this.dismissChannelManagementModal = null;
    };
    const close = () => {
      dismiss();
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
    this.dismissChannelManagementModal = dismiss;
  }

  private refreshChannelSwitcher(): void {
    if (!this.channelSwitcher) return;
    setTrustedHtml(this.channelSwitcher, trustedHtml('', "legacy direct innerHTML migration"));
    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }
    // A fresh button carries neither mark, so put back what failure memory and the running session still say.
    this.syncOfflineButtonMarks();
    if (this.videoPhase === 'connecting') this.markChannelButtonLoading(this.activeChannel.id);
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

  private resetChannelButtonLoading(btn: HTMLElement): void {
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
  }

  // Clear every channel button, not only `.loading`. Success used to drop the
  // spinner class while leaving aria-busy set, and a later switch could strip
  // `.loading` from a still-busy predecessor.
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
      // CSS blocks the pointer during load (pointer-events: none). Announce the
      // same to keyboard/AT without `disabled`, which would drop focus to <body>
      // for the whole connection; the click handler ignores a busy button.
      btnEl.setAttribute('aria-busy', 'true');
      btnEl.setAttribute('aria-disabled', 'true');
    });
  }

  private markActiveChannelButton(channelId: string): void {
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      const isActive = btnEl.dataset.channelId === channelId;
      btnEl.classList.toggle('active', isActive);
      btnEl.setAttribute('aria-pressed', String(isActive));
    });
  }

  private setChannelOffline(channelId: string, offline: boolean): void {
    this.channelSwitcher?.querySelectorAll<HTMLElement>('.live-channel-btn').forEach(btn => {
      if (btn.dataset.channelId === channelId) btn.classList.toggle('offline', offline);
    });
  }

  /** Keep switcher offline marks aligned with failure memory (do not wipe on a no-intent switch). */
  private syncOfflineButtonMarks(): void {
    this.channelSwitcher?.querySelectorAll<HTMLElement>('.live-channel-btn').forEach(btn => {
      const id = btn.dataset.channelId;
      if (id) btn.classList.toggle('offline', this.failureMemory.isKnownOffline(id));
    });
  }

  private switchChannel(channel: LiveChannel): void {
    if (channel.id === this.activeChannel.id) {
      // An implicit start may have landed here without saving it. Choosing it makes it the viewer's channel:
      // saved, and explained rather than skipped if it goes offline. What is playing keeps playing.
      if (this.playbackOrigin === 'implicit') {
        saveToStorage(STORAGE_KEYS.activeChannel, channel.id);
        this.playbackOrigin = 'explicit';
      }
      return;
    }

    this.activeChannel = channel;
    saveToStorage(STORAGE_KEYS.activeChannel, channel.id);
    const shouldStartMedia = this.hasPlaybackIntent();
    this.markActiveChannelButton(channel.id);

    if (!shouldStartMedia) {
      this.clearChannelLoadingState();
      this.syncOfflineButtonMarks();
      this.renderPlaceholder();
      return;
    }

    this.beginPlayback('explicit');
    // Busy until this channel's session settles on a verdict (onVideoState) or playback stops.
    if (this.videoPhase === 'connecting') this.markChannelButtonLoading(channel.id);
  }

  /** The next channel after `from` in the switcher order that `accept` allows, wrapping around. */
  private nextChannel(from: LiveChannel, accept: (channel: LiveChannel) => boolean): LiveChannel | null {
    const start = this.channels.findIndex((channel) => channel.id === from.id);
    for (let step = 1; step < this.channels.length + (start === -1 ? 1 : 0); step++) {
      const candidate = this.channels[(start + step) % this.channels.length]!;
      if (candidate.id !== from.id && accept(candidate)) return candidate;
    }
    return null;
  }

  private showOfflineMessage(channel: LiveChannel, reason: OfflineReason = 'not-live', watchUrl: string | null = null): void {
    this.destroyPlayer();
    // Nothing is playing, so the header button offers play rather than pause.
    this.isPlaying = false;
    this.updateLiveIndicator();

    const card = document.createElement('div');
    card.className = 'live-offline live-offline-compact';
    card.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'offline-icon';
    icon.textContent = '📺';

    const text = document.createElement('div');
    text.className = 'offline-text';
    text.textContent = offlineReasonText(reason, this.getChannelDisplayName(channel));

    const actions = document.createElement('div');
    actions.className = 'live-offline-actions';
    if (reason === 'needs-channel-url' || reason === 'insecure-url') {
      actions.appendChild(actionButton(t('components.liveNews.manage') || 'Manage channels', () => this.openChannelManagementModal()));
    } else if (reason !== 'no-entries') {
      // switchChannel never restarts the channel it already holds, so retry re-requests playback for the current stream.
      const retry = actionButton(t('common.retry') || 'Retry', () => this.beginPlayback('explicit'));
      retry.dataset.liveRetry = '';
      actions.appendChild(retry);
    }
    // Managing channels while the card is up can remove the one it picked, so resolve again at click time.
    const nextChannel = () => this.nextChannel(channel, (candidate) => !this.failureMemory.isKnownOffline(candidate.id));
    if (nextChannel()) {
      actions.appendChild(actionButton(t('components.liveNews.playNextChannel') || 'Play next channel', () => {
        const next = nextChannel();
        if (next) this.switchChannel(next);
      }));
    }
    if (watchUrl) actions.appendChild(youtubeLink(watchUrl));

    card.append(icon, text, actions);
    // #6557: a terminal offline state is authoritative content.
    this.setContentNodes(card);
  }

  private renderPlayer(): void {
    this.destroyPlayer();
    const generation = ++this.playerGeneration;
    const isCurrent = () => generation === this.playerGeneration;
    const channel = this.activeChannel;
    const container = this.ensurePlayerContainer();
    const source = liveVideoSourceFor(channel);
    if (!sourceListsChannel(source)) {
      this.openPlayer(container, channel, source, isCurrent);
      return;
    }
    // A slot that lists a channel first asks for that channel's resolved live video (at most 1.5 s), showing the
    // connecting cover meanwhile. A stop, a channel switch or a new render bumps the generation and drops the mount.
    this.pendingMount = true;
    this.showPlayerStatus('cover', t('components.liveNews.connecting', { name: this.getChannelDisplayName(channel) }));
    void withResolvedLiveVideos(source).then((resolved) => {
      if (!isCurrent()) return;
      this.pendingMount = false;
      this.openPlayer(container, channel, resolved, isCurrent);
    });
  }

  private openPlayer(container: HTMLDivElement, channel: LiveChannel, source: LiveVideoSource, isCurrent: () => boolean): void {
    const session = openLiveVideo(container, {
      source,
      autoplay: true,
      muted: this.isMuted,
      presentation: { title: `${this.getChannelDisplayName(channel)} live feed`, className: 'live-news-media', controls: true },
      onState: (state) => {
        if (isCurrent()) this.onVideoState(channel, state);
      },
      onMutedChange: (muted) => {
        if (!isCurrent()) return;
        this.isMuted = muted;
        this.updateMuteIcon();
      },
      onPlayingChange: (playing) => {
        // The viewer paused or resumed from the player's own controls; the idle stop leaves a paused stream alone.
        if (!isCurrent() || this.isPlaying === playing) return;
        this.isPlaying = playing;
        this.updateLiveIndicator();
      },
    });
    // The first state arrives synchronously, and an offline one may already have moved playback on.
    if (isCurrent()) this.videoSession = session;
    else session.destroy();
  }

  private ensurePlayerContainer(): HTMLDivElement {
    this.deferredInit = true;
    const container = document.createElement('div');
    container.className = 'live-news-player';
    this.playerContainer = container;
    this.setContentNodes(container);
    return container;
  }

  private onVideoState(channel: LiveChannel, state: LiveVideoState): void {
    this.videoPhase = state.phase;
    if (state.phase !== 'connecting') this.clearChannelLoadingState();
    switch (state.phase) {
      case 'connecting':
        this.showPlayerStatus('cover', t('components.liveNews.connecting', { name: this.getChannelDisplayName(channel) }));
        return;
      case 'live':
        this.failureMemory.clear(channel.id);
        this.skippedChannelIds.clear();
        this.setChannelOffline(channel.id, false);
        this.showPlayerStatus(null);
        return;
      // A recording and an unverified stream both play, so neither is still offline.
      case 'recording':
        this.failureMemory.clear(channel.id);
        this.setChannelOffline(channel.id, false);
        this.showPlayerStatus('chip', t('components.liveNews.recording'));
        return;
      case 'unverified':
        this.failureMemory.clear(channel.id);
        this.setChannelOffline(channel.id, false);
        this.showPlayerStatus('chip', t('components.liveNews.unverified'), state.watchUrl);
        return;
      case 'offline':
        this.handleChannelOffline(channel, state.reason, state.watchUrl);
    }
  }

  /** A cover over the player while it connects, a corner chip for a disclosed state, or nothing once live. */
  private showPlayerStatus(kind: 'cover' | 'chip' | null, text = '', watchUrl: string | null = null): void {
    const container = this.playerContainer;
    if (!container) return;
    container.querySelector('.live-news-status')?.remove();
    if (!kind) return;

    const status = document.createElement('div');
    status.className = `live-news-status live-news-status--${kind}`;
    status.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = text;
    status.appendChild(label);
    if (watchUrl) {
      status.appendChild(actionButton(t('components.liveNews.signInToYouTube') || 'Sign in to YouTube', () => void this.openYouTubeSignIn()));
      status.appendChild(youtubeLink(watchUrl));
    }
    container.appendChild(status);
  }

  private handleChannelOffline(channel: LiveChannel, reason: OfflineReason, watchUrl: string | null): void {
    this.failureMemory.markOffline(channel.id);
    this.setChannelOffline(channel.id, true);
    if (this.playbackOrigin === 'implicit') {
      this.skippedChannelIds.add(channel.id);
      const next = this.nextChannel(channel, (candidate) => !this.skippedChannelIds.has(candidate.id) && !this.failureMemory.isKnownOffline(candidate.id));
      if (next) {
        this.playChannelWithoutSaving(next);
        return;
      }
    }
    this.showOfflineMessage(channel, reason, watchUrl);
  }

  /** Moves an implicit start on to another channel without making it the saved choice. */
  private playChannelWithoutSaving(channel: LiveChannel): void {
    this.activeChannel = channel;
    this.markActiveChannelButton(channel.id);
    this.requestPlaybackForActiveChannel();
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

  public refresh(): void {
    this.videoSession?.setMuted(this.isMuted);
  }

  /** Reload channel list from storage (e.g. after edit in separate channel management window). */
  public refreshChannelsFromStorage(): void {
    const activeIndex = this.channels.findIndex((c) => c.id === this.activeChannel.id);
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    this.refreshChannelSwitcher();
    if (this.channels.length === 0) {
      this.renderPlaceholder();
      return;
    }
    const current = this.channels.find((c) => c.id === this.activeChannel.id);
    if (!current) {
      // The active channel was removed, or an edit gave it a new id (a channel URL in place of a handle), so
      // take the channel now in its position. switchChannel never restarts the channel it already holds, so
      // hand it the replacement instead of assigning it first; it stops the old channel and saves the new one.
      const next = this.channels[Math.min(Math.max(activeIndex, 0), this.channels.length - 1)];
      if (next) this.switchChannel(next);
      return;
    }
    // An edit can keep the id and change what plays (a custom stream URL). Hold the edited channel, and move a
    // running session, or the offline card its last attempt left, onto the new source; a stopped channel plays
    // the new source next time.
    const sourceChanged = liveVideoSourceFor(current).entries.join('\n') !== liveVideoSourceFor(this.activeChannel).entries.join('\n');
    this.activeChannel = current;
    if (!sourceChanged) return;
    if (this.videoSession || this.pendingMount) this.renderPlayer();
    else if (this.ownsActiveLiveMedia()) this.beginPlayback('explicit');
  }

  public stopLiveMediaForClose(): void {
    const wasIdleStopped = this.idleStoppedAfterMs !== null;
    this.idleStoppedAfterMs = null;
    stopLiveMediaPlayback('live-news', 'destroyed');
    if (wasIdleStopped || this.videoSession || this.pendingMount) {
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
    // The overlay is parented to document.body and hides only by unmounting
    // (main.css toggles opacity, not display), so destroying the panel while
    // it was open left it on screen holding every automatic reload off for
    // the rest of the session, with a document keydown listener to match.
    this.dismissChannelManagementModal?.();
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
    if (this.isFullscreen) this.setFullscreen(false);

    super.destroy();
  }
}
