import { Panel } from './Panel';
import { fetchLiveVideoId } from '@/services/live-news';
import { isDesktopRuntime, getRemoteApiBaseUrl } from '@/services/runtime';
import { invokeTauri } from '@/services/tauri-bridge';
import { t } from '../services/i18n';
import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS } from '@/config';

// YouTube IFrame Player API types
type YouTubePlayer = {
  mute(): void;
  unMute(): void;
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(videoId: string): void;
  cueVideoById(videoId: string): void;
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

export interface LiveChannel {
  id: string;
  name: string;
  handle: string; // YouTube channel handle (e.g., @bloomberg)
  fallbackVideoId?: string; // Fallback if no live stream detected
  videoId?: string; // Dynamically fetched live video ID
  isLive?: boolean;
  useFallbackOnly?: boolean; // Skip auto-detection, always use fallback
}

const SITE_VARIANT = import.meta.env.VITE_VARIANT || 'full';

// Full variant: World news channels (24/7 live streams)
const FULL_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@Bloomberg', fallbackVideoId: 'iEpJwprxDdk' },
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews', fallbackVideoId: 'YDvsBbKfLPA' },
  { id: 'euronews', name: 'Euronews', handle: '@euabortnews', fallbackVideoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'cnbc', name: 'CNBC', handle: '@CNBC', fallbackVideoId: '9NyxcX3rhQs' },
  { id: 'france24', name: 'France24', handle: '@FRANCE24English', fallbackVideoId: 'Ap-UM1O9RBU' },
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya', fallbackVideoId: 'n7eQejkXbnM', useFallbackOnly: true },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo', useFallbackOnly: true },
];

// Tech variant: Tech & business channels
const TECH_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@Bloomberg', fallbackVideoId: 'iEpJwprxDdk' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance', fallbackVideoId: 'KQp-e_XQnDE' },
  { id: 'cnbc', name: 'CNBC', handle: '@CNBC', fallbackVideoId: '9NyxcX3rhQs' },
  { id: 'nasa', name: 'NASA TV', handle: '@NASA', fallbackVideoId: 'fO9e9jnhYK8', useFallbackOnly: true },
];

// Optional channels users can add from the "Available Channels" tab UI
export const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [
  // North America
  { id: 'livenow-fox', name: 'LiveNOW from FOX', handle: '@LiveNOWfromFOX' },
  { id: 'fox-news', name: 'Fox News', handle: '@FoxNews', fallbackVideoId: 'QaftgYkG-ek', useFallbackOnly: true },
  { id: 'newsmax', name: 'Newsmax', handle: '@NEWSMAX', fallbackVideoId: 'cZikyozILOY', useFallbackOnly: true },
  { id: 'abc-news', name: 'ABC News', handle: '@ABCNews' },
  { id: 'cbs-news', name: 'CBS News', handle: '@CBSNews' },
  { id: 'nbc-news', name: 'NBC News', handle: '@NBCNews' },
  // Europe
  { id: 'welt', name: 'WELT', handle: '@WELTNachrichtensender' },
  { id: 'rtve', name: 'RTVE 24H', handle: '@RTVENoticias', fallbackVideoId: '7_srED6k0bE' },
  { id: 'trt-haber', name: 'TRT Haber', handle: '@trthaber' },
  { id: 'ntv-turkey', name: 'NTV', handle: '@NTV' },
  { id: 'cnn-turk', name: 'CNN TURK', handle: '@cnnturk' },
  { id: 'tv-rain', name: 'TV Rain', handle: '@tvrain' },
  // Latin America & Portuguese
  { id: 'cnn-brasil', name: 'CNN Brasil', handle: '@CNNbrasil', fallbackVideoId: '1kWRw-DA6Ns' },
  { id: 'jovem-pan', name: 'Jovem Pan News', handle: '@jovempannews' },
  { id: 'record-news', name: 'Record News', handle: '@recordnewsoficial' },
  { id: 'band-jornalismo', name: 'Band Jornalismo', handle: '@BandJornalismo' },
  { id: 'tn-argentina', name: 'TN (Todo Noticias)', handle: '@todonoticias', fallbackVideoId: 'cb12KmMMDJA' },
  { id: 'c5n', name: 'C5N', handle: '@c5n', fallbackVideoId: 'NdQSOItOQ5Y' },
  { id: 'milenio', name: 'MILENIO', handle: '@MILENIO' },
  { id: 'noticias-caracol', name: 'Noticias Caracol', handle: '@NoticiasCaracol' },
  { id: 'ntn24', name: 'NTN24', handle: '@NTN24' },
  { id: 't13', name: 'T13', handle: '@T13' },
  // Asia
  { id: 'tbs-news', name: 'TBS NEWS DIG', handle: '@tbsnewsdig', fallbackVideoId: 'ohI356mwBp8' },
  { id: 'ann-news', name: 'ANN News', handle: '@ANNnewsCH' },
  { id: 'ntv-news', name: 'NTV News (Japan)', handle: '@ntv_news' },
  { id: 'cti-news', name: 'CTI News (Taiwan)', handle: '@CtiTv', fallbackVideoId: 'wUPPkSANpyo', useFallbackOnly: true },
  { id: 'wion', name: 'WION', handle: '@WIONews' },
  { id: 'vtc-now', name: 'VTC NOW', handle: '@VTCNOW' },
  { id: 'cna-asia', name: 'CNA (NewsAsia)', handle: '@channelnewsasia' },
  { id: 'nhk-world', name: 'NHK World Japan', handle: '@NHKWORLDJAPAN' },
  // Africa
  { id: 'africanews', name: 'Africanews', handle: '@africanews' },
  { id: 'channels-tv', name: 'Channels TV', handle: '@channelstv' },
  { id: 'ktn-news', name: 'KTN News', handle: '@KTNNewsKE' },
  { id: 'enca', name: 'eNCA', handle: '@enewschannel' },
  { id: 'sabc-news', name: 'SABC News', handle: '@SABCNews' },
];

export const OPTIONAL_CHANNEL_REGIONS: { key: string; labelKey: string; channelIds: string[] }[] = [
  { key: 'na', labelKey: 'components.liveNews.regionNorthAmerica', channelIds: ['livenow-fox', 'fox-news', 'newsmax', 'abc-news', 'cbs-news', 'nbc-news'] },
  { key: 'eu', labelKey: 'components.liveNews.regionEurope', channelIds: ['welt', 'rtve', 'trt-haber', 'ntv-turkey', 'cnn-turk', 'tv-rain'] },
  { key: 'latam', labelKey: 'components.liveNews.regionLatinAmerica', channelIds: ['cnn-brasil', 'jovem-pan', 'record-news', 'band-jornalismo', 'tn-argentina', 'c5n', 'milenio', 'noticias-caracol', 'ntn24', 't13'] },
  { key: 'asia', labelKey: 'components.liveNews.regionAsia', channelIds: ['tbs-news', 'ann-news', 'ntv-news', 'cti-news', 'wion', 'vtc-now', 'cna-asia', 'nhk-world'] },
  { key: 'africa', labelKey: 'components.liveNews.regionAfrica', channelIds: ['africanews', 'channels-tv', 'ktn-news', 'enca', 'sabc-news'] },
];

const DEFAULT_LIVE_CHANNELS = SITE_VARIANT === 'tech' ? TECH_LIVE_CHANNELS : FULL_LIVE_CHANNELS;

/** Default channel list for the current variant (for restore in channel management). */
export function getDefaultLiveChannels(): LiveChannel[] {
  return [...DEFAULT_LIVE_CHANNELS];
}

export interface StoredLiveChannels {
  order: string[];
  custom?: LiveChannel[];
  /** Display name overrides for built-in channels (and custom). */
  displayNameOverrides?: Record<string, string>;
}

const DEFAULT_STORED: StoredLiveChannels = {
  order: DEFAULT_LIVE_CHANNELS.map((c) => c.id),
};

export const BUILTIN_IDS = new Set([
  ...FULL_LIVE_CHANNELS.map((c) => c.id),
  ...TECH_LIVE_CHANNELS.map((c) => c.id),
  ...OPTIONAL_LIVE_CHANNELS.map((c) => c.id),
]);

export function loadChannelsFromStorage(): LiveChannel[] {
  const stored = loadFromStorage<StoredLiveChannels>(STORAGE_KEYS.liveChannels, DEFAULT_STORED);
  const order = stored.order?.length ? stored.order : DEFAULT_STORED.order;
  const channelMap = new Map<string, LiveChannel>();
  for (const c of FULL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of TECH_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of OPTIONAL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of stored.custom ?? []) {
    if (c.id && c.handle) channelMap.set(c.id, { ...c });
  }
  const overrides = stored.displayNameOverrides ?? {};
  for (const [id, name] of Object.entries(overrides)) {
    const ch = channelMap.get(id);
    if (ch) ch.name = name;
  }
  const result: LiveChannel[] = [];
  for (const id of order) {
    const ch = channelMap.get(id);
    if (ch) result.push(ch);
  }
  return result;
}

export function saveChannelsToStorage(channels: LiveChannel[]): void {
  const order = channels.map((c) => c.id);
  const custom = channels.filter((c) => !BUILTIN_IDS.has(c.id));
  const builtinNames = new Map<string, string>();
  for (const c of [...FULL_LIVE_CHANNELS, ...TECH_LIVE_CHANNELS, ...OPTIONAL_LIVE_CHANNELS]) builtinNames.set(c.id, c.name);
  const displayNameOverrides: Record<string, string> = {};
  for (const c of channels) {
    if (builtinNames.has(c.id) && c.name !== builtinNames.get(c.id)) {
      displayNameOverrides[c.id] = c.name;
    }
  }
  saveToStorage(STORAGE_KEYS.liveChannels, { order, custom, displayNameOverrides });
}

export class LiveNewsPanel extends Panel {
  private static apiPromise: Promise<void> | null = null;
  private channels: LiveChannel[] = [];
  private activeChannel!: LiveChannel;
  private channelSwitcher: HTMLElement | null = null;
  private isMuted = true;
  private isPlaying = true;
  private wasPlayingBeforeIdle = true;
  private muteBtn: HTMLButtonElement | null = null;
  private liveBtn: HTMLButtonElement | null = null;
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
  private boundVisibilityHandler!: () => void;
  private boundIdleResetHandler!: () => void;

  // YouTube Player API state
  private player: YouTubePlayer | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerElement: HTMLDivElement | null = null;
  private playerElementId: string;
  private isPlayerReady = false;
  private currentVideoId: string | null = null;
  private readonly youtubeOrigin: string | null;
  private forceFallbackVideoForNextInit = false;

  // Desktop fallback: embed via cloud bridge page to avoid YouTube 153.
  // Starts false — try native JS API first; switches to true on Error 153.
  private useDesktopEmbedProxy = false;
  private desktopEmbedIframe: HTMLIFrameElement | null = null;
  private desktopEmbedRenderToken = 0;
  private boundMessageHandler!: (e: MessageEvent) => void;
  private muteSyncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MUTE_SYNC_POLL_MS = 500;

  constructor() {
    super({ id: 'live-news', title: t('panels.liveNews') });
    this.youtubeOrigin = LiveNewsPanel.resolveYouTubeOrigin();
    this.playerElementId = `live-news-player-${Date.now()}`;
    this.element.classList.add('panel-wide');
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    this.activeChannel = this.channels[0]!;
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
    this.setupBridgeMessageListener();
    this.renderPlayer();
    this.setupIdleDetection();
  }

  private saveChannels(): void {
    saveChannelsToStorage(this.channels);
  }

  private get embedOrigin(): string {
    try { return new URL(getRemoteApiBaseUrl()).origin; } catch { return 'https://worldmonitor.app'; }
  }

  private setupBridgeMessageListener(): void {
    this.boundMessageHandler = (e: MessageEvent) => {
      if (e.source !== this.desktopEmbedIframe?.contentWindow) return;
      const expected = this.embedOrigin;
      if (e.origin !== expected && e.origin !== 'http://127.0.0.1:46123') return;
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || !msg.type) return;
      if (msg.type === 'yt-ready') {
        this.isPlayerReady = true;
        this.syncDesktopEmbedState();
      } else if (msg.type === 'yt-error') {
        const code = Number(msg.code ?? 0);
        if (code === 153 && this.activeChannel.fallbackVideoId &&
          this.activeChannel.videoId !== this.activeChannel.fallbackVideoId) {
          this.activeChannel.videoId = this.activeChannel.fallbackVideoId;
          this.renderDesktopEmbed(true);
        } else {
          this.showEmbedError(this.activeChannel, code);
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

  private setupIdleDetection(): void {
    // Suspend idle timer when hidden, resume when visible
    this.boundVisibilityHandler = () => {
      if (document.hidden) {
        // Suspend idle timer so background playback isn't killed
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
      } else {
        this.resumeFromIdle();
        this.boundIdleResetHandler();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // Track user activity to detect idle (pauses after 5 min inactivity)
    this.boundIdleResetHandler = () => {
      if (this.idleTimeout) clearTimeout(this.idleTimeout);
      this.resumeFromIdle();
      this.idleTimeout = setTimeout(() => this.pauseForIdle(), this.IDLE_PAUSE_MS);
    };

    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler, { passive: true });
    });

    // Start the idle timer
    this.boundIdleResetHandler();
  }

  private pauseForIdle(): void {
    if (this.isPlaying) {
      this.wasPlayingBeforeIdle = true;
      this.isPlaying = false;
      this.updateLiveIndicator();
    }
    this.destroyPlayer();
  }

  private stopMuteSyncPolling(): void {
    if (this.muteSyncInterval !== null) {
      clearInterval(this.muteSyncInterval);
      this.muteSyncInterval = null;
    }
  }

  private startMuteSyncPolling(): void {
    this.stopMuteSyncPolling();
    this.muteSyncInterval = setInterval(() => this.syncMuteStateFromPlayer(), this.MUTE_SYNC_POLL_MS);
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
    this.stopMuteSyncPolling();
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    this.desktopEmbedIframe = null;
    this.desktopEmbedRenderToken += 1;
    this.isPlayerReady = false;
    this.currentVideoId = null;

    // Clear the container to remove player/iframe
    if (this.playerContainer) {
      this.playerContainer.innerHTML = '';

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

  private resumeFromIdle(): void {
    if (this.wasPlayingBeforeIdle && !this.isPlaying) {
      this.isPlaying = true;
      this.updateLiveIndicator();
      void this.initializePlayer();
    }
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
    this.wasPlayingBeforeIdle = this.isPlaying;
    this.updateLiveIndicator();
    if (this.isPlaying && !this.player && !this.desktopEmbedIframe) {
      this.ensurePlayerContainer();
      void this.initializePlayer();
    } else {
      this.syncPlayerState();
    }
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
    this.syncPlayerState();
  }

  /** Creates a single channel tab button with click and drag handlers. */
  private createChannelButton(channel: LiveChannel): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `live-channel-btn ${channel.id === this.activeChannel.id ? 'active' : ''}`;
    btn.dataset.channelId = channel.id;
    btn.draggable = true;
    btn.textContent = channel.name;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.switchChannel(channel);
    });
    btn.addEventListener('dragstart', (e) => {
      btn.classList.add('live-channel-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', channel.id);
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('live-channel-dragging');
      this.applyChannelOrderFromDom();
    });
    return btn;
  }

  private createChannelSwitcher(): void {
    this.channelSwitcher = document.createElement('div');
    this.channelSwitcher.className = 'live-news-switcher';

    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }

    this.channelSwitcher.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = this.channelSwitcher?.querySelector('.live-channel-dragging');
      if (!dragging || !this.channelSwitcher) return;
      const target = (e.target as HTMLElement).closest?.('.live-channel-btn');
      if (!target || target === dragging) return;
      const all = Array.from(this.channelSwitcher.querySelectorAll('.live-channel-btn'));
      const idx = all.indexOf(dragging as Element);
      const targetIdx = all.indexOf(target);
      if (idx === -1 || targetIdx === -1) return;
      if (idx < targetIdx) {
        target.parentElement?.insertBefore(dragging, target.nextSibling);
      } else {
        target.parentElement?.insertBefore(dragging, target);
      }
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
    openBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    openBtn.addEventListener('click', () => {
      if (isDesktopRuntime()) {
        void invokeTauri<void>('open_live_channels_window_command', {
          base_url: window.location.origin,
        }).catch(() => {});
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('live-channels', '1');
      window.open(url.toString(), 'worldmonitor-live-channels', 'width=440,height=560,scrollbars=yes');
    });
    toolbar.appendChild(openBtn);
  }

  private refreshChannelSwitcher(): void {
    if (!this.channelSwitcher) return;
    this.channelSwitcher.innerHTML = '';
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
    const liveVideoId = useFallbackVideo ? null : await fetchLiveVideoId(channel.handle);
    channel.videoId = liveVideoId || channel.fallbackVideoId;
    channel.isLive = !!liveVideoId;
  }

  private async switchChannel(channel: LiveChannel): Promise<void> {
    if (channel.id === this.activeChannel.id) return;

    this.activeChannel = channel;

    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      btnEl.classList.toggle('active', btnEl.dataset.channelId === channel.id);
      if (btnEl.dataset.channelId === channel.id) {
        btnEl.classList.add('loading');
      }
    });

    await this.resolveChannelVideo(channel);

    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      btnEl.classList.remove('loading');
      if (btnEl.dataset.channelId === channel.id && !channel.videoId) {
        btnEl.classList.add('offline');
      }
    });

    if (!channel.videoId || !/^[\w-]{10,12}$/.test(channel.videoId)) {
      this.showOfflineMessage(channel);
      return;
    }

    if (this.useDesktopEmbedProxy) {
      this.renderDesktopEmbed(true);
      return;
    }

    if (!this.player) {
      this.ensurePlayerContainer();
      void this.initializePlayer();
      return;
    }

    this.syncPlayerState();
  }

  private showOfflineMessage(channel: LiveChannel): void {
    this.content.innerHTML = `
      <div class="live-offline">
        <div class="offline-icon">📺</div>
        <div class="offline-text">${t('components.liveNews.notLive', { name: channel.name })}</div>
        <button class="offline-retry" onclick="this.closest('.panel').querySelector('.live-channel-btn.active')?.click()">${t('common.retry')}</button>
      </div>
    `;
  }

  private showEmbedError(channel: LiveChannel, errorCode: number): void {
    const watchUrl = channel.videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(channel.videoId)}`
      : `https://www.youtube.com/${channel.handle}`;

    this.content.innerHTML = `
      <div class="live-offline">
        <div class="offline-icon">!</div>
        <div class="offline-text">${t('components.liveNews.cannotEmbed', { name: channel.name, code: String(errorCode) })}</div>
        <a class="offline-retry" href="${watchUrl}" target="_blank" rel="noopener noreferrer">${t('components.liveNews.openOnYouTube')}</a>
      </div>
    `;
  }

  private renderPlayer(): void {
    this.ensurePlayerContainer();
    void this.initializePlayer();
  }

  private ensurePlayerContainer(): void {
    this.content.innerHTML = '';
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

  private buildDesktopEmbedPath(videoId: string, origin?: string): string {
    const params = new URLSearchParams({
      videoId,
      autoplay: this.isPlaying ? '1' : '0',
      mute: this.isMuted ? '1' : '0',
    });
    if (origin) params.set('origin', origin);
    return `/api/youtube/embed?${params.toString()}`;
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

    this.playerContainer.innerHTML = '';

    // Always use cloud URL for iframe embeds — the local sidecar requires
    // an Authorization header that iframe src requests cannot carry.
    const remoteBase = getRemoteApiBaseUrl();
    const embedUrl = `${remoteBase}${this.buildDesktopEmbedPath(videoId)}`;

    if (renderToken !== this.desktopEmbedRenderToken) {
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'live-news-embed-frame';
    iframe.src = embedUrl;
    iframe.title = `${this.activeChannel.name} live feed`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.setAttribute('loading', 'eager');

    this.playerContainer.appendChild(iframe);
    this.desktopEmbedIframe = iframe;
  }

  private static loadYouTubeApi(): Promise<void> {
    if (LiveNewsPanel.apiPromise) return LiveNewsPanel.apiPromise;

    LiveNewsPanel.apiPromise = new Promise((resolve) => {
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
      script.onerror = () => {
        console.warn('[LiveNews] YouTube IFrame API failed to load (ad blocker or network issue)');
        LiveNewsPanel.apiPromise = null;
        script.remove();
        resolve();
      };
      document.head.appendChild(script);
    });

    return LiveNewsPanel.apiPromise;
  }

  private async initializePlayer(): Promise<void> {
    if (!this.useDesktopEmbedProxy && this.player) return;

    const useFallbackVideo = this.activeChannel.useFallbackOnly || this.forceFallbackVideoForNextInit;
    this.forceFallbackVideoForNextInit = false;
    await this.resolveChannelVideo(this.activeChannel, useFallbackVideo);

    if (!this.activeChannel.videoId || !/^[\w-]{10,12}$/.test(this.activeChannel.videoId)) {
      this.showOfflineMessage(this.activeChannel);
      return;
    }

    if (this.useDesktopEmbedProxy) {
      this.renderDesktopEmbed(true);
      return;
    }

    await LiveNewsPanel.loadYouTubeApi();
    if (this.player || !this.playerElement || !window.YT?.Player) return;

    this.player = new window.YT!.Player(this.playerElement, {
      host: 'https://www.youtube-nocookie.com',
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
          this.isPlayerReady = true;
          this.currentVideoId = this.activeChannel.videoId || null;
          const iframe = this.player?.getIframe?.();
          if (iframe) iframe.referrerPolicy = 'strict-origin-when-cross-origin';
          this.syncPlayerState();
          this.startMuteSyncPolling();
        },
        onError: (event) => {
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
  }

  private syncPlayerState(): void {
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
        this.player.loadVideoById(videoId);
      } else {
        this.player.cueVideoById(videoId);
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
        this.player.pauseVideo();
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
    if (!this.channels.some((c) => c.id === this.activeChannel.id)) {
      this.activeChannel = this.channels[0]!;
      void this.switchChannel(this.activeChannel);
    }
    this.refreshChannelSwitcher();
  }

  public destroy(): void {
    this.stopMuteSyncPolling();
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    window.removeEventListener('message', this.boundMessageHandler);
    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.removeEventListener(event, this.boundIdleResetHandler);
    });

    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this.desktopEmbedIframe = null;
    this.isPlayerReady = false;
    this.playerContainer = null;
    this.playerElement = null;

    super.destroy();
  }
}
