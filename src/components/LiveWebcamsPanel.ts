import { Panel } from './Panel';
import { IDLE_PAUSE_MS, STORAGE_KEYS } from '@/config';
import { isDesktopRuntime, getLocalApiPort } from '@/services/runtime';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '../services/i18n';
import { track, trackWebcamSelected, trackWebcamRegionFiltered } from '@/services/analytics';
import { getStreamQuality, subscribeStreamQualityChange } from '@/services/ai-flow-settings';
import { isMobileDevice, loadFromStorage, saveToStorage } from '@/utils';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsSettingsChange } from '@/services/live-stream-settings';

type WebcamRegion = 'iran' | 'middle-east' | 'europe' | 'asia' | 'americas' | 'space';

interface WebcamFeed {
  id: string;
  city: string;
  country: string;
  region: WebcamRegion;
  channelHandle: string;
  fallbackVideoId: string;
}

// Verified YouTube live stream IDs — validated Feb 2026 via title cross-check.
// IDs may rotate; update when stale.
const WEBCAM_FEEDS: WebcamFeed[] = [
  // Iran Attacks — Tehran, Tel Aviv, Jerusalem
  { id: 'iran-tehran', city: 'Tehran', country: 'Iran', region: 'iran', channelHandle: '@IranHDCams', fallbackVideoId: '-zGuR1qVKrU' },
  { id: 'iran-telaviv', city: 'Tel Aviv', country: 'Israel', region: 'iran', channelHandle: '@IsraelLiveCam', fallbackVideoId: 'gmtlJ_m2r5A' },
  { id: 'iran-jerusalem', city: 'Jerusalem', country: 'Israel', region: 'iran', channelHandle: '@JerusalemLive', fallbackVideoId: 'fIurYTprwzg' },
  { id: 'iran-multicam', city: 'Middle East', country: 'Multi', region: 'iran', channelHandle: '@MiddleEastCams', fallbackVideoId: 'Khfdb7qUvjk' },
  // Middle East — Jerusalem & Tehran adjacent (conflict hotspots)
  { id: 'jerusalem', city: 'Jerusalem', country: 'Israel', region: 'middle-east', channelHandle: '@TheWesternWall', fallbackVideoId: 'e34xb-Fbl0U' },
  { id: 'tehran', city: 'Tehran', country: 'Iran', region: 'middle-east', channelHandle: '@IranHDCams', fallbackVideoId: '-zGuR1qVKrU' },
  { id: 'tel-aviv', city: 'Tel Aviv', country: 'Israel', region: 'middle-east', channelHandle: '@IsraelLiveCam', fallbackVideoId: 'gmtlJ_m2r5A' },
  { id: 'mecca', city: 'Mecca', country: 'Saudi Arabia', region: 'middle-east', channelHandle: '@MakkahLive', fallbackVideoId: 'Cm1v4bteXbI' },
  { id: 'beirut-mtv', city: 'Beirut', country: 'Lebanon', region: 'middle-east', channelHandle: '@MTVLebanonNews', fallbackVideoId: 'djF-Lkgfp6k' },
  // Europe
  { id: 'kyiv', city: 'Kyiv', country: 'Ukraine', region: 'europe', channelHandle: '@DWNews', fallbackVideoId: '-Q7FuPINDjA' },
  { id: 'odessa', city: 'Odessa', country: 'Ukraine', region: 'europe', channelHandle: '@UkraineLiveCam', fallbackVideoId: 'e2gC37ILQmk' },
  { id: 'paris', city: 'Paris', country: 'France', region: 'europe', channelHandle: '@PalaisIena', fallbackVideoId: 'OzYp4NRZlwQ' },
  { id: 'st-petersburg', city: 'St. Petersburg', country: 'Russia', region: 'europe', channelHandle: '@SPBLiveCam', fallbackVideoId: 'CjtIYbmVfck' },
  { id: 'london', city: 'London', country: 'UK', region: 'europe', channelHandle: '@EarthCam', fallbackVideoId: 'Lxqcg1qt0XU' },
  // Americas
  { id: 'washington', city: 'Washington DC', country: 'USA', region: 'americas', channelHandle: '@AxisCommunications', fallbackVideoId: '1wV9lLe14aU' },
  { id: 'new-york', city: 'New York', country: 'USA', region: 'americas', channelHandle: '@EarthCam', fallbackVideoId: '4qyZLflp-sI' },
  { id: 'los-angeles', city: 'Los Angeles', country: 'USA', region: 'americas', channelHandle: '@VeniceVHotel', fallbackVideoId: 'EO_1LWqsCNE' },
  { id: 'miami', city: 'Miami', country: 'USA', region: 'americas', channelHandle: '@FloridaLiveCams', fallbackVideoId: '5YCajRjvWCg' },
  // Asia-Pacific — Taipei first (strait hotspot), then Shanghai, Tokyo, Seoul
  { id: 'taipei', city: 'Taipei', country: 'Taiwan', region: 'asia', channelHandle: '@JackyWuTaipei', fallbackVideoId: 'z_fY1pj1VBw' },
  { id: 'shanghai', city: 'Shanghai', country: 'China', region: 'asia', channelHandle: '@SkylineWebcams', fallbackVideoId: '76EwqI5XZIc' },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', region: 'asia', channelHandle: '@TokyoLiveCam4K', fallbackVideoId: '_k-5U7IeK8g' },
  { id: 'seoul', city: 'Seoul', country: 'South Korea', region: 'asia', channelHandle: '@UNvillage_live', fallbackVideoId: '-JhoMGoAfFc' },
  { id: 'sydney', city: 'Sydney', country: 'Australia', region: 'asia', channelHandle: '@WebcamSydney', fallbackVideoId: '7pcL-0Wo77U' },
  // Space
  { id: 'iss-earth', city: 'ISS Earth View', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'vytmBNhc9ig' },
  { id: 'nasa-live', city: 'NASA TV', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'zPH5KtjJFaQ' },
  { id: 'space-x', city: 'SpaceX', country: 'Space', region: 'space', channelHandle: '@SpaceX', fallbackVideoId: 'fO9e9jnhYK8' },
  { id: 'space-walk', city: 'Space', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'fO9e9jnhYK8' },
];

const MAX_GRID_CELLS = 4;

// Eco mode pauses streams after inactivity to save CPU/bandwidth.
const ECO_IDLE_PAUSE_MS = IDLE_PAUSE_MS;
const IDLE_ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;

type ViewMode = 'grid' | 'single';
type RegionFilter = 'all' | WebcamRegion;

const ALL_REGIONS: RegionFilter[] = ['all', 'iran', 'middle-east', 'europe', 'americas', 'asia', 'space'];

interface WebcamPrefs {
  regionFilter: RegionFilter;
  viewMode: ViewMode;
  activeFeedId: string;
}

function loadWebcamPrefs(forceSingleView: boolean): WebcamPrefs {
  const stored = loadFromStorage<Partial<WebcamPrefs>>(STORAGE_KEYS.webcamPrefs, {});
  const region = stored.regionFilter as RegionFilter;
  const regionFilter = ALL_REGIONS.includes(region) ? region : 'iran';
  const viewMode = forceSingleView ? 'single'
    : (stored.viewMode === 'grid' || stored.viewMode === 'single' ? stored.viewMode : 'grid');
  const regionFeeds = regionFilter === 'all' ? WEBCAM_FEEDS
    : WEBCAM_FEEDS.filter(f => f.region === regionFilter);
  const matchedFeed = regionFeeds.find(f => f.id === stored.activeFeedId);
  const activeFeedId = matchedFeed?.id ?? regionFeeds[0]?.id ?? WEBCAM_FEEDS[0]!.id;
  return { regionFilter, viewMode, activeFeedId };
}

function saveWebcamPrefs(prefs: WebcamPrefs): void {
  saveToStorage(STORAGE_KEYS.webcamPrefs, prefs);
}

interface WebcamIframeTracker {
  feed: WebcamFeed;
  container: HTMLElement;
  timeout: ReturnType<typeof setTimeout> | null;
  blocked: boolean;
}

export class LiveWebcamsPanel extends Panel {
  private viewMode: ViewMode = 'grid';
  private regionFilter: RegionFilter = 'iran';
  private activeFeed: WebcamFeed = WEBCAM_FEEDS[0]!;
  private toolbar: HTMLElement | null = null;
  private iframes: HTMLIFrameElement[] = [];
  private iframeTrackers = new Map<HTMLIFrameElement, WebcamIframeTracker>();
  private observer: IntersectionObserver | null = null;
  private isVisible = false;
  // Stream lifecycle
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;
  private boundIdleResetHandler!: () => void;
  private boundVisibilityHandler!: () => void;
  private idleDetectionEnabled = false;
  private isIdle = false;
  private alwaysOn = getLiveStreamsAlwaysOn();
  private unsubscribeStreamSettings: (() => void) | null = null;

  // UI
  private fullscreenBtn: HTMLButtonElement | null = null;
  private isFullscreen = false;
  private readonly forceSingleView = !isDesktopRuntime() && isMobileDevice();
  private readonly EMBED_READY_TIMEOUT_MS = 15000;
  private boundEmbedMessageHandler: (e: MessageEvent) => void;

  constructor() {
    super({ id: 'live-webcams', title: t('panels.liveWebcams'), className: 'panel-wide', closable: true, collapsible: true });
    this.insertLiveCountBadge(WEBCAM_FEEDS.length);

    const prefs = loadWebcamPrefs(this.forceSingleView);
    this.regionFilter = prefs.regionFilter;
    this.viewMode = prefs.viewMode;
    this.activeFeed = WEBCAM_FEEDS.find(f => f.id === prefs.activeFeedId) ?? WEBCAM_FEEDS[0]!;

    this.createFullscreenButton();
    this.createToolbar();
    this.setupIntersectionObserver();
    this.setupIdleDetection();
    subscribeStreamQualityChange(() => this.render());
    this.unsubscribeStreamSettings = subscribeLiveStreamsSettingsChange((alwaysOn) => {
      this.alwaysOn = alwaysOn;
      this.applyIdleMode();
    });
    this.boundEmbedMessageHandler = (e) => this.handleEmbedMessage(e);
    window.addEventListener('message', this.boundEmbedMessageHandler);
    this.render();
    document.addEventListener('keydown', this.boundFullscreenEscHandler);
  }

  private createFullscreenButton(): void {
    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.className = 'live-mute-btn';
    this.fullscreenBtn.title = 'Fullscreen';
    this.fullscreenBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('webcam-fullscreen', { entering: !this.isFullscreen });
      this.toggleFullscreen();
    });
    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.fullscreenBtn);
  }

  private toggleFullscreen(): void {
    this.isFullscreen = !this.isFullscreen;
    this.element.classList.toggle('live-news-fullscreen', this.isFullscreen);
    document.body.classList.toggle('live-news-fullscreen-active', this.isFullscreen);
    if (this.fullscreenBtn) {
      this.fullscreenBtn.title = this.isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
      this.fullscreenBtn.innerHTML = this.isFullscreen
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    }
  }

  private boundFullscreenEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isFullscreen) this.toggleFullscreen();
  };

  private savePrefs(): void {
    saveWebcamPrefs({
      regionFilter: this.regionFilter,
      viewMode: this.viewMode,
      activeFeedId: this.activeFeed.id,
    });
  }

  private get filteredFeeds(): WebcamFeed[] {
    if (this.regionFilter === 'all') return WEBCAM_FEEDS;
    return WEBCAM_FEEDS.filter(f => f.region === this.regionFilter);
  }

  private static readonly ALL_GRID_IDS = ['jerusalem', 'tehran', 'kyiv', 'washington'];

  private get gridFeeds(): WebcamFeed[] {
    if (this.regionFilter === 'all') {
      return LiveWebcamsPanel.ALL_GRID_IDS
        .map(id => WEBCAM_FEEDS.find(f => f.id === id)!)
        .filter(Boolean);
    }
    return this.filteredFeeds.slice(0, MAX_GRID_CELLS);
  }

  private createToolbar(): void {
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'webcam-toolbar';

    const regionGroup = document.createElement('div');
    regionGroup.className = 'webcam-toolbar-group';

    const regions: { key: RegionFilter; label: string }[] = [
      { key: 'iran', label: t('components.webcams.regions.iran') },
      { key: 'all', label: t('components.webcams.regions.all') },
      { key: 'middle-east', label: t('components.webcams.regions.mideast') },
      { key: 'europe', label: t('components.webcams.regions.europe') },
      { key: 'americas', label: t('components.webcams.regions.americas') },
      { key: 'asia', label: t('components.webcams.regions.asia') },
      { key: 'space', label: t('components.webcams.regions.space') },
    ];

    regions.forEach(({ key, label }) => {
      const btn = document.createElement('button');
      btn.className = `webcam-region-btn${key === this.regionFilter ? ' active' : ''}`;
      btn.dataset.region = key;
      btn.textContent = label;
      btn.addEventListener('click', () => this.setRegionFilter(key));
      regionGroup.appendChild(btn);
    });

    const viewGroup = document.createElement('div');
    viewGroup.className = 'webcam-toolbar-group';

    const gridBtn = document.createElement('button');
    gridBtn.className = `webcam-view-btn${this.viewMode === 'grid' ? ' active' : ''}`;
    gridBtn.dataset.mode = 'grid';
    gridBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>';
    gridBtn.title = 'Grid view';
    gridBtn.addEventListener('click', () => this.setViewMode('grid'));

    const singleBtn = document.createElement('button');
    singleBtn.className = `webcam-view-btn${this.viewMode === 'single' ? ' active' : ''}`;
    singleBtn.dataset.mode = 'single';
    singleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="18" height="14" rx="2"/><rect x="3" y="19" width="18" height="2" rx="1"/></svg>';
    singleBtn.title = 'Single view';
    singleBtn.addEventListener('click', () => this.setViewMode('single'));

    // On mobile we force single view and hide/disable the grid toggle.
    if (this.forceSingleView) {
      gridBtn.disabled = true;
      gridBtn.style.display = 'none';
    }

    viewGroup.appendChild(gridBtn);
    viewGroup.appendChild(singleBtn);

    this.toolbar.appendChild(regionGroup);
    this.toolbar.appendChild(viewGroup);
    this.element.insertBefore(this.toolbar, this.content);
  }

  private setRegionFilter(filter: RegionFilter): void {
    if (filter === this.regionFilter) return;
    trackWebcamRegionFiltered(filter);
    this.regionFilter = filter;
    this.toolbar?.querySelectorAll('.webcam-region-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.region === filter);
    });
    const feeds = this.filteredFeeds;
    if (feeds.length > 0 && !feeds.includes(this.activeFeed)) {
      this.activeFeed = feeds[0]!;
    }
    this.savePrefs();
    this.render();
  }

  private setViewMode(mode: ViewMode): void {
    if (this.forceSingleView && mode === 'grid') return;
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.savePrefs();
    this.toolbar?.querySelectorAll('.webcam-view-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
    });
    this.render();
  }

  private buildEmbedUrl(videoId: string): string {
    const quality = getStreamQuality();
    if (isDesktopRuntime()) {
      // Use local sidecar embed — YouTube rejects tauri:// parent origin with error 153.
      // The sidecar serves the embed from http://127.0.0.1:PORT which YouTube accepts.
      const params = new URLSearchParams({ videoId, autoplay: '1', mute: '1' });
      if (quality !== 'auto') params.set('vq', quality);
      return `http://localhost:${getLocalApiPort()}/api/youtube-embed?${params.toString()}`;
    }
    const vq = quality !== 'auto' ? `&vq=${quality}` : '';
    return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&origin=${window.location.origin}${vq}`;
  }

  private createIframe(feed: WebcamFeed): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    iframe.className = 'webcam-iframe';
    iframe.src = this.buildEmbedUrl(feed.fallbackVideoId);
    iframe.title = `${feed.city} live webcam`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; storage-access';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    if (!isDesktopRuntime()) {
      iframe.allowFullscreen = true;
      iframe.setAttribute('loading', 'lazy');
    }
    return iframe;
  }

  private findIframeBySource(source: MessageEventSource | null): HTMLIFrameElement | null {
    if (!source || !(source instanceof Window)) return null;
    for (const iframe of this.iframes) {
      if (iframe.contentWindow === source) return iframe;
    }
    return null;
  }

  private clearIframeTimeout(iframe: HTMLIFrameElement): void {
    const tracker = this.iframeTrackers.get(iframe);
    if (!tracker?.timeout) return;
    clearTimeout(tracker.timeout);
    tracker.timeout = null;
  }

  private markIframeBlocked(iframe: HTMLIFrameElement): void {
    const tracker = this.iframeTrackers.get(iframe);
    if (!tracker || tracker.blocked) return;
    tracker.blocked = true;
    this.clearIframeTimeout(iframe);
    this.renderBlockedOverlay(iframe, tracker.feed, tracker.container);
  }

  private markIframeReady(iframe: HTMLIFrameElement): void {
    const tracker = this.iframeTrackers.get(iframe);
    if (!tracker) return;
    tracker.blocked = false;
    this.clearIframeTimeout(iframe);
    tracker.container.querySelector('.webcam-embed-fallback')?.remove();
  }

  private trackIframe(iframe: HTMLIFrameElement, feed: WebcamFeed, container: HTMLElement): void {
    const tracker: WebcamIframeTracker = {
      feed,
      container,
      timeout: null,
      blocked: false,
    };
    this.iframeTrackers.set(iframe, tracker);

    // YouTube embeds post yt-ready/yt-state (desktop sidecar) or native YT API events (web with enablejsapi=1).
    // If nothing arrives within the timeout, assume blocked/stuck.
    // Fallback: iframe load event cancels the timeout — Firefox privacy restrictions
    // can block YouTube JS API postMessage while the video plays fine.
    iframe.addEventListener('load', () => this.markIframeReady(iframe), { once: true });
    tracker.timeout = setTimeout(() => this.markIframeBlocked(iframe), this.EMBED_READY_TIMEOUT_MS);
  }

  private retryIframe(oldIframe: HTMLIFrameElement): void {
    const tracker = this.iframeTrackers.get(oldIframe);
    if (!tracker) return;

    if (!oldIframe.parentNode) {
      this.clearIframeTimeout(oldIframe);
      return;
    }
    const freshIframe = this.createIframe(tracker.feed);
    oldIframe.replaceWith(freshIframe);
    oldIframe.src = 'about:blank';

    const idx = this.iframes.indexOf(oldIframe);
    if (idx >= 0) this.iframes[idx] = freshIframe;

    this.clearIframeTimeout(oldIframe);
    this.iframeTrackers.delete(oldIframe);
    this.trackIframe(freshIframe, tracker.feed, tracker.container);
    tracker.container.querySelector('.webcam-embed-fallback')?.remove();
  }

  private renderBlockedOverlay(iframe: HTMLIFrameElement, feed: WebcamFeed, container: HTMLElement): void {
    container.querySelector('.webcam-embed-fallback')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'webcam-embed-fallback';
    overlay.addEventListener('click', (e) => e.stopPropagation());

    const message = document.createElement('div');
    message.className = 'webcam-embed-fallback-text';
    message.textContent = 'This stream is blocked or failed to load.';

    const actions = document.createElement('div');
    actions.className = 'webcam-embed-fallback-actions';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'offline-retry webcam-embed-retry';
    retryBtn.textContent = t('common.retry') || 'Retry';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.retryIframe(iframe);
    });

    const openBtn = document.createElement('a');
    openBtn.className = 'offline-retry webcam-embed-open';
    openBtn.href = `https://www.youtube.com/watch?v=${encodeURIComponent(feed.fallbackVideoId)}`;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener noreferrer';
    openBtn.textContent = t('components.liveNews.openOnYouTube') || 'Open on YouTube';
    openBtn.addEventListener('click', (e) => e.stopPropagation());

    actions.append(retryBtn, openBtn);
    overlay.append(message, actions);
    container.appendChild(overlay);
  }

  private handleEmbedMessage(e: MessageEvent): void {
    const iframe = this.findIframeBySource(e.source);
    if (!iframe) return;

    // Desktop sidecar posts { type: 'yt-ready' | 'yt-state' | 'yt-error' }
    const msg = e.data as { type?: string; state?: number; code?: number; event?: string; info?: unknown } | string | null;

    // YouTube native API (web) posts JSON strings: '{"event":"onReady",...}'
    if (typeof msg === 'string') {
      if (msg[0] !== '{') return;
      try {
        const parsed = JSON.parse(msg) as { event?: string; info?: { playerState?: number } };
        if (parsed.event === 'onReady' || parsed.event === 'initialDelivery') {
          this.markIframeReady(iframe);
        } else if (parsed.event === 'infoDelivery' && parsed.info?.playerState === 1) {
          this.markIframeReady(iframe);
        }
      } catch { /* not YouTube JSON — ignore */ }
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // Desktop sidecar format
    if (msg.type === 'yt-ready') {
      this.markIframeReady(iframe);
      return;
    }

    if (msg.type === 'yt-state' && (msg.state === 1 || msg.state === 3)) {
      this.markIframeReady(iframe);
      return;
    }

    if (msg.type === 'yt-error') {
      this.markIframeBlocked(iframe);
    }
  }

  private render(): void {
    this.destroyIframes();

    if (!this.isVisible || this.isIdle) {
      this.content.innerHTML = `<div class="webcam-placeholder">${escapeHtml(t('components.webcams.paused'))}</div>`;
      return;
    }

    if (this.viewMode === 'grid') {
      this.renderGrid();
    } else {
      this.renderSingle();
    }
  }

  private renderGrid(): void {
    if (this.forceSingleView) {
      this.viewMode = 'single';
      this.renderSingle();
      return;
    }

    this.content.innerHTML = '';
    this.content.className = 'panel-content webcam-content';

    const grid = document.createElement('div');
    grid.className = 'webcam-grid';

    const feeds = this.gridFeeds;
    const desktop = isDesktopRuntime();

    feeds.forEach((feed, i) => {
      const cell = document.createElement('div');
      cell.className = 'webcam-cell';

      const label = document.createElement('div');
      label.className = 'webcam-cell-label';
      label.innerHTML = `<span class="webcam-live-dot"></span><span class="webcam-city">${escapeHtml(feed.city.toUpperCase())}</span>`;

      if (desktop) {
        // On desktop, clicks pass through label (pointer-events:none in CSS)
        // to YouTube iframe so users click play directly. Add expand button.
        const expandBtn = document.createElement('button');
        expandBtn.className = 'webcam-expand-btn';
        expandBtn.title = t('webcams.expand') || 'Expand';
        expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          trackWebcamSelected(feed.id, feed.city, 'grid');
          this.activeFeed = feed;
          this.setViewMode('single');
        });
        label.appendChild(expandBtn);
      } else {
        cell.addEventListener('click', () => {
          trackWebcamSelected(feed.id, feed.city, 'grid');
          this.activeFeed = feed;
          this.setViewMode('single');
        });
      }

      cell.appendChild(label);
      grid.appendChild(cell);

      if (desktop && i > 0) {
        // Stagger iframe creation on desktop — WKWebView throttles concurrent autoplay.
        setTimeout(() => {
          if (!this.isVisible || this.isIdle) return;
          const iframe = this.createIframe(feed);
          cell.insertBefore(iframe, label);
          this.iframes.push(iframe);
          this.trackIframe(iframe, feed, cell);
        }, i * 800);
      } else {
        const iframe = this.createIframe(feed);
        cell.insertBefore(iframe, label);
        this.iframes.push(iframe);
        this.trackIframe(iframe, feed, cell);
      }
    });

    this.content.appendChild(grid);
  }

  private renderSingle(): void {
    this.content.innerHTML = '';
    this.content.className = 'panel-content webcam-content';

    const wrapper = document.createElement('div');
    wrapper.className = 'webcam-single';

    const iframe = this.createIframe(this.activeFeed);
    wrapper.appendChild(iframe);
    this.iframes.push(iframe);
    this.trackIframe(iframe, this.activeFeed, wrapper);

    const switcher = document.createElement('div');
    switcher.className = 'webcam-switcher';

    if (!this.forceSingleView) {
      const backBtn = document.createElement('button');
      backBtn.className = 'webcam-feed-btn webcam-back-btn';
      backBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg> Grid';
      backBtn.addEventListener('click', () => this.setViewMode('grid'));
      switcher.appendChild(backBtn);
    }

    this.filteredFeeds.forEach(feed => {
      const btn = document.createElement('button');
      btn.className = `webcam-feed-btn${feed.id === this.activeFeed.id ? ' active' : ''}`;
      btn.textContent = feed.city;
      btn.addEventListener('click', () => {
        trackWebcamSelected(feed.id, feed.city, 'single');
        this.activeFeed = feed;
        this.savePrefs();
        this.render();
      });
      switcher.appendChild(btn);
    });

    this.content.appendChild(wrapper);
    this.content.appendChild(switcher);
  }

  private destroyIframes(): void {
    this.iframeTrackers.forEach((tracker, iframe) => {
      if (tracker.timeout) clearTimeout(tracker.timeout);
      iframe.src = 'about:blank';
      iframe.remove();
    });
    this.iframeTrackers.clear();
    this.iframes.forEach(iframe => {
      if (iframe.isConnected) {
        iframe.src = 'about:blank';
        iframe.remove();
      }
    });
    this.iframes = [];
  }

  private setupIntersectionObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        const wasVisible = this.isVisible;
        this.isVisible = entries.some(e => e.isIntersecting);
        if (this.isVisible && !wasVisible && !this.isIdle) {
          this.render();
        } else if (!this.isVisible && wasVisible) {
          this.destroyIframes();
        }
      },
      { threshold: 0.1 }
    );
    this.observer.observe(this.element);
  }

  private applyIdleMode(): void {
    if (this.alwaysOn) {
      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout);
        this.idleTimeout = null;
      }
      if (this.idleDetectionEnabled) {
        IDLE_ACTIVITY_EVENTS.forEach((event) => {
          document.removeEventListener(event, this.boundIdleResetHandler);
        });
        this.idleDetectionEnabled = false;
      }
      if (this.isIdle && !document.hidden) {
        this.isIdle = false;
        if (this.isVisible) this.render();
      }
      return;
    }

    if (!this.idleDetectionEnabled) {
      IDLE_ACTIVITY_EVENTS.forEach((event) => {
        document.addEventListener(event, this.boundIdleResetHandler, { passive: true });
      });
      this.idleDetectionEnabled = true;
    }

    this.boundIdleResetHandler();
  }

  private setupIdleDetection(): void {
    // Background: always suspend when the document is hidden.
    this.boundVisibilityHandler = () => {
      if (document.hidden) {
        // Suspend idle timer so background playback isn't killed.
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        return;
      }

      // Visible again.
      if (this.isIdle) {
        this.isIdle = false;
        if (this.isVisible) this.render();
      }

      this.applyIdleMode();
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // Eco mode idle timer.
    this.boundIdleResetHandler = () => {
      if (this.alwaysOn) return;
      if (this.idleTimeout) clearTimeout(this.idleTimeout);
      if (this.isIdle) {
        this.isIdle = false;
        if (this.isVisible) this.render();
      }
      this.idleTimeout = setTimeout(() => {
        this.isIdle = true;
        this.destroyIframes();
        this.content.innerHTML = `<div class="webcam-placeholder">${escapeHtml(t('components.webcams.pausedIdle'))}</div>`;
      }, ECO_IDLE_PAUSE_MS);
    };

    this.applyIdleMode();
  }

  public refresh(): void {
    if (this.isVisible && !this.isIdle) {
      this.render();
    }
  }

  public destroy(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    document.removeEventListener('keydown', this.boundFullscreenEscHandler);
    window.removeEventListener('message', this.boundEmbedMessageHandler);
    IDLE_ACTIVITY_EVENTS.forEach(event => {
      document.removeEventListener(event, this.boundIdleResetHandler);
    });
    if (this.isFullscreen) this.toggleFullscreen();
    this.observer?.disconnect();
    this.unsubscribeStreamSettings?.();
    this.unsubscribeStreamSettings = null;
    this.destroyIframes();
    super.destroy();
  }
}
