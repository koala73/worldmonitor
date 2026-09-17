import { Panel } from './Panel';
import { STORAGE_KEYS } from '@/config';
import { isDesktopRuntime, getLocalApiPort } from '@/services/runtime';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '../services/i18n';
import { track, trackWebcamSelected, trackWebcamRegionFiltered } from '@/services/analytics';
import { getStreamQuality, subscribeStreamQualityChange } from '@/services/ai-flow-settings';
import { isMobileDevice, loadFromStorage, saveToStorage } from '@/utils';
import { playAllLiveMedia, registerLiveMediaStarter, unregisterLiveMediaStarter } from '@/services/live-media-controller';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsAlwaysOnChange } from '@/services/live-stream-settings';
import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { createLiveMediaIdleNotice, trackLiveMediaIdleStop } from './live-media-idle-notice';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { isAllowedWebcamEmbedMessageOrigin } from './_live-webcams-origin';


type WebcamRegion = 'middle-east' | 'europe' | 'asia' | 'americas' | 'space';

interface WebcamFeed {
  id: string;
  city: string;
  country: string;
  region: WebcamRegion;
  fallbackVideoId: string;
}

// YouTube live stream IDs, each checked live on 2026-09-17 with `npm run live-video:check`.
// Broadcasters end and restart streams, so re-run the checker before trusting an ID.
const WEBCAM_FEEDS: WebcamFeed[] = [
  // Middle East (conflict hotspots)
  { id: 'jerusalem', city: 'Jerusalem', country: 'Israel', region: 'middle-east', fallbackVideoId: 'zp6LNSoq000' },
  { id: 'middle-east', city: 'Middle East', country: 'Multi', region: 'middle-east', fallbackVideoId: 'AkqGOcpDvZU' },
  { id: 'mecca', city: 'Mecca', country: 'Saudi Arabia', region: 'middle-east', fallbackVideoId: 'eC4LfEVxvKg' },
  { id: 'istanbul', city: 'Istanbul', country: 'Turkey', region: 'middle-east', fallbackVideoId: 'bbVe5h7X3uw' },
  { id: 'medina', city: 'Medina', country: 'Saudi Arabia', region: 'middle-east', fallbackVideoId: 'naaOMgZbIHQ' },
  // Europe — the Ukraine feed rotates through Kyiv, Odesa, Kharkiv, Kramatorsk, Sloviansk, Donetsk and Dnipro
  { id: 'kyiv', city: 'Ukraine', country: 'Ukraine', region: 'europe', fallbackVideoId: 'e2gC37ILQmk' },
  { id: 'paris', city: 'Paris', country: 'France', region: 'europe', fallbackVideoId: '-xzg3wujOVM' },
  { id: 'st-petersburg', city: 'St. Petersburg', country: 'Russia', region: 'europe', fallbackVideoId: 'CjtIYbmVfck' },
  { id: 'london', city: 'London', country: 'UK', region: 'europe', fallbackVideoId: 'zMCea32gpmg' },
  // Americas
  { id: 'washington', city: 'Washington DC', country: 'USA', region: 'americas', fallbackVideoId: 'oDCAAfOSqvA' },
  { id: 'new-york', city: 'New York', country: 'USA', region: 'americas', fallbackVideoId: 'JQ_jwk_7OVE' },
  { id: 'los-angeles', city: 'Los Angeles', country: 'USA', region: 'americas', fallbackVideoId: 'EO_1LWqsCNE' },
  { id: 'miami', city: 'Miami', country: 'USA', region: 'americas', fallbackVideoId: 'nPGlLfGX6SA' },
  // Asia-Pacific — Taipei first (strait hotspot), then Shanghai, Tokyo, Seoul
  { id: 'taipei', city: 'Taipei', country: 'Taiwan', region: 'asia', fallbackVideoId: 'z_fY1pj1VBw' },
  { id: 'shanghai', city: 'Shanghai', country: 'China', region: 'asia', fallbackVideoId: 'Z-g8M1QGKbg' },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', region: 'asia', fallbackVideoId: '_k-5U7IeK8g' },
  { id: 'seoul', city: 'Seoul', country: 'South Korea', region: 'asia', fallbackVideoId: 'vk5BHoDxXf0' },
  { id: 'sydney', city: 'Sydney', country: 'Australia', region: 'asia', fallbackVideoId: '5uZa3-RMFos' },
  // Space
  { id: 'iss-earth', city: 'ISS Earth View', country: 'Space', region: 'space', fallbackVideoId: 'M3HKLzjvKPc' },
  { id: 'space-walk', city: 'Space', country: 'Space', region: 'space', fallbackVideoId: 'fO9e9jnhYK8' },
];

const MAX_GRID_CELLS = 4;

type ViewMode = 'grid' | 'single';
type RegionFilter = 'all' | WebcamRegion;

const ALL_REGIONS: RegionFilter[] = ['all', 'middle-east', 'europe', 'americas', 'asia', 'space'];

interface WebcamPrefs {
  regionFilter: RegionFilter;
  viewMode: ViewMode;
  activeFeedId: string;
}

function loadWebcamPrefs(forceSingleView: boolean): WebcamPrefs {
  const stored = loadFromStorage<Partial<WebcamPrefs>>(STORAGE_KEYS.webcamPrefs, {});
  const region = stored.regionFilter as RegionFilter;
  const regionFilter = ALL_REGIONS.includes(region) ? region : 'all';
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
  private regionFilter: RegionFilter = 'all';
  private activeFeed: WebcamFeed = WEBCAM_FEEDS[0]!;
  private toolbar: HTMLElement | null = null;
  private iframes: HTMLIFrameElement[] = [];
  private iframeTrackers = new Map<HTMLIFrameElement, WebcamIframeTracker>();
  // Feeds the user has explicitly started. The grid is a "wall" — multiple tiles play at once;
  // single view keeps one. Tiles coexist and are only torn down by scroll-away/hidden/idle/close.
  private activeIframeFeedIds = new Set<string>();
  private observer: IntersectionObserver | null = null;
  private isVisible = false;
  private idleStopped: { readonly feedIds: readonly string[]; readonly idleAfterMs: number } | null = null;
  private readonly boundVisibilityHandler = () => {
    if (document.hidden) {
      this.teardownPlayback();
      return;
    }
    if (!this.startAlwaysOnPlayback() && this.isVisible) this.render();
  };
  private alwaysOn = getLiveStreamsAlwaysOn();
  private unsubscribeStreamSettings: (() => void) | null = null;
  private unsubscribeIdle: (() => void) | null = null;
  // Play-all cascade: start the whole webcam wall, but never start a disabled or collapsed panel.
  private readonly boundPlayAllStarter = () => {
    if (this.canHostLiveMedia()) this.playAllFeeds();
  };

  // UI
  private fullscreenBtn: HTMLButtonElement | null = null;
  private isFullscreen = false;
  private readonly forceSingleView = !isDesktopRuntime() && isMobileDevice();
  private readonly EMBED_READY_TIMEOUT_MS = 15000;
  private boundEmbedMessageHandler: (e: MessageEvent) => void;

  constructor() {
    super({ id: 'live-webcams', title: t('panels.liveWebcams'), className: 'panel-wide', closable: true, collapsible: true, infoTooltip: t('components.liveWebcams.infoTooltip') });
    this.insertLiveCountBadge(WEBCAM_FEEDS.length);

    const prefs = loadWebcamPrefs(this.forceSingleView);
    this.regionFilter = prefs.regionFilter;
    this.viewMode = prefs.viewMode;
    this.activeFeed = WEBCAM_FEEDS.find(f => f.id === prefs.activeFeedId) ?? WEBCAM_FEEDS[0]!;

    this.createFullscreenButton();
    this.createToolbar();
    this.setupIntersectionObserver();
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
    this.unsubscribeIdle = subscribeLiveMediaIdle((idleAfterMs) => this.stopForIdle(idleAfterMs));
    subscribeStreamQualityChange(() => this.render());
    this.unsubscribeStreamSettings = subscribeLiveStreamsAlwaysOnChange((alwaysOn) => {
      this.alwaysOn = alwaysOn;
      // Leaving always-on keeps whatever is playing; the idle stop still applies.
      if (alwaysOn && this.isVisible && !document.hidden) {
        this.startAlwaysOnPlayback();
      }
    });
    this.boundEmbedMessageHandler = (e) => this.handleEmbedMessage(e);
    window.addEventListener('message', this.boundEmbedMessageHandler);
    this.render();
    registerLiveMediaStarter('live-webcams', this.boundPlayAllStarter);
    document.addEventListener('keydown', this.boundFullscreenEscHandler);
  }

  private createFullscreenButton(): void {
    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.className = 'live-mute-btn';
    this.fullscreenBtn.title = 'Fullscreen';
    setTrustedHtml(this.fullscreenBtn, trustedHtml('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', "legacy direct innerHTML migration"));
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('webcam-fullscreen', { entering: !this.isFullscreen });
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

  private static readonly ALL_GRID_IDS = ['jerusalem', 'middle-east', 'kyiv', 'washington'];

  private get gridFeeds(): WebcamFeed[] {
    if (this.regionFilter === 'all') {
      return LiveWebcamsPanel.ALL_GRID_IDS
        .map(id => WEBCAM_FEEDS.find(f => f.id === id)!)
        .filter(Boolean);
    }
    return this.filteredFeeds.slice(0, MAX_GRID_CELLS);
  }

  /** The feeds the current layout plays at once: the whole grid wall, or the single selected feed. */
  private get layoutFeeds(): WebcamFeed[] {
    return (this.viewMode === 'grid' && !this.forceSingleView) ? this.gridFeeds : [this.activeFeed];
  }

  private createToolbar(): void {
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'webcam-toolbar';

    const regionGroup = document.createElement('div');
    regionGroup.className = 'webcam-toolbar-group';

    const regions: { key: RegionFilter; label: string }[] = [
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
    setTrustedHtml(gridBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>', "legacy direct innerHTML migration"));
    gridBtn.title = 'Grid view';
    gridBtn.addEventListener('click', () => this.setViewMode('grid'));

    const singleBtn = document.createElement('button');
    singleBtn.className = `webcam-view-btn${this.viewMode === 'single' ? ' active' : ''}`;
    singleBtn.dataset.mode = 'single';
    setTrustedHtml(singleBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="18" height="14" rx="2"/><rect x="3" y="19" width="18" height="2" rx="1"/></svg>', "legacy direct innerHTML migration"));
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
    // Region change swaps the entire feed set — tear the old wall down, then rebuild it from the
    // new region's layout when the user already had video playing.
    const wasPlaying = this.activeIframeFeedIds.size > 0;
    this.clearActivePlayback();
    if (this.idleStopped) this.idleStopped = { ...this.idleStopped, feedIds: [] };
    const feeds = this.filteredFeeds;
    if (feeds.length > 0 && !feeds.includes(this.activeFeed)) {
      this.activeFeed = feeds[0]!;
    }
    this.savePrefs();
    if (wasPlaying) {
      for (const feed of this.layoutFeeds) this.activeIframeFeedIds.add(feed.id);
    }
    this.render();
  }

  private setViewMode(mode: ViewMode): void {
    if (this.forceSingleView && mode === 'grid') return;
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    // Switching layout resets the wall to the selected feed; the user rebuilds it by clicking tiles.
    const keepActive = this.activeIframeFeedIds.has(this.activeFeed.id);
    this.activeIframeFeedIds.clear();
    if (keepActive) this.activeIframeFeedIds.add(this.activeFeed.id);
    this.savePrefs();
    this.toolbar?.querySelectorAll('.webcam-view-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
    });
    // In always-on, let startAlwaysOnPlayback own the render so the wall isn't built then immediately rebuilt.
    if (!this.startAlwaysOnPlayback()) {
      this.render();
    }
  }

  private buildEmbedUrl(videoId: string): string {
    const quality = getStreamQuality();
    if (isDesktopRuntime()) {
      // Use local sidecar embed — YouTube rejects tauri:// parent origin with error 153.
      // The sidecar serves the embed from http://127.0.0.1:PORT which YouTube accepts.
      const params = new URLSearchParams({ videoId, autoplay: '1', mute: '1' });
      if (quality !== 'auto') params.set('vq', quality);
      params.set('parentOrigin', window.location.origin);
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

  private playFeed(feed: WebcamFeed, source: 'grid' | 'single' | 'settings'): void {
    if (source !== 'settings') {
      trackWebcamSelected(feed.id, feed.city, source);
    }
    this.activeFeed = feed;
    this.idleStopped = null;
    const alreadyActive = this.activeIframeFeedIds.has(feed.id);
    this.activeIframeFeedIds.add(feed.id);
    this.savePrefs();
    if (!this.isVisible || document.hidden) return;
    // Grid is a wall: swap just the clicked tile into a live iframe so sibling streams keep playing.
    if (this.viewMode === 'grid' && !this.forceSingleView && !alreadyActive && this.activateGridCell(feed)) {
      return;
    }
    this.render();
  }

  /** Swap a single grid preview tile into a live iframe in place, leaving sibling streams untouched. */
  private activateGridCell(feed: WebcamFeed): boolean {
    const grid = this.content.querySelector('.webcam-grid');
    if (!grid) return false;
    const preview = grid.querySelector<HTMLElement>(`.webcam-preview-tile[data-feed-id="${CSS.escape(feed.id)}"]`);
    const cell = preview?.closest('.webcam-cell') as HTMLElement | null;
    if (!cell) return false;
    setTrustedHtml(cell, trustedHtml('', "legacy direct innerHTML migration"));
    const iframe = this.createIframe(feed);
    cell.appendChild(iframe);
    this.iframes.push(iframe);
    this.trackIframe(iframe, feed, cell);
    const label = document.createElement('div');
    label.className = 'webcam-cell-label';
    setTrustedHtml(label, trustedHtml(`<span class="webcam-live-dot"></span><span class="webcam-city">${escapeHtml(feed.city.toUpperCase())}</span>`, "legacy direct innerHTML migration"));
    cell.appendChild(label);
    return true;
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

  /** Ensure the always-on feed(s) are in the active set. Returns true if it rendered (so callers don't double-render). */
  private startAlwaysOnPlayback(): boolean {
    if (!this.alwaysOn || document.hidden || !this.element.isConnected || !this.isVisible) return false;
    // An idle stop ends only through Resume or Play, so autoplay must not rebuild the wall on tab return or scroll-back.
    if (this.idleStopped) return false;
    // In grid view auto-start the whole wall; single view auto-starts only the selected feed.
    const feeds = this.layoutFeeds;
    let added = false;
    for (const feed of feeds) {
      if (!this.activeIframeFeedIds.has(feed.id)) {
        this.activeIframeFeedIds.add(feed.id);
        added = true;
      }
    }
    if (!added) return false;
    this.idleStopped = null;
    this.render();
    return true;
  }

  /**
   * Start the whole webcam wall (every grid tile, or the single feed in single view) regardless of
   * always-on. Drives the "play all" cascade. Off-screen feeds are queued and render on visibility.
   * After an idle stop it restores the feeds that were playing, or the whole layout when none of
   * them are in the current layout.
   *
   * This intentionally uses a full render() rather than the per-tile activateGridCell() swap that
   * playFeed() uses: the cascade is an all-at-once start. The grid triggers (a preview-tile click,
   * the idle notice's Resume) only exist when the grid is fully stopped (no tiles playing), so the
   * full render rebuilds from zero — no already-playing iframe is destroyed/reloaded. A future caller
   * that adds feeds incrementally before calling this should switch to the surgical swap to avoid
   * reload flashes.
   */
  private playAllFeeds(): void {
    const layoutFeeds = this.layoutFeeds;
    const idleStopped = this.idleStopped;
    this.idleStopped = null;
    const restoredFeeds = idleStopped ? layoutFeeds.filter((feed) => idleStopped.feedIds.includes(feed.id)) : [];
    let added = false;
    for (const feed of restoredFeeds.length > 0 ? restoredFeeds : layoutFeeds) {
      if (!this.activeIframeFeedIds.has(feed.id)) {
        this.activeIframeFeedIds.add(feed.id);
        added = true;
      }
    }
    if (!added && !idleStopped) return;
    if (this.isVisible && !document.hidden) this.render();
  }

  /** Stop and forget every active tile without rebuilding the shell. */
  private clearActivePlayback(): void {
    this.activeIframeFeedIds.clear();
    this.destroyIframes();
  }

  private teardownPlayback(): void {
    this.clearActivePlayback();
    // Don't rebuild DOM for a backgrounded tab; the visibility handler re-renders on return.
    if (this.isVisible && this.element.isConnected && !document.hidden) {
      this.render();
    }
  }

  private stopForIdle(idleAfterMs: number): void {
    if (this.isFullscreen || this.activeIframeFeedIds.size === 0) return;
    this.idleStopped = { feedIds: Array.from(this.activeIframeFeedIds), idleAfterMs };
    trackLiveMediaIdleStop('live-webcams', idleAfterMs);
    this.clearActivePlayback();
    if (this.element.isConnected) this.render();
  }

  private renderPreviewTile(container: HTMLElement, feed: WebcamFeed, source: 'grid' | 'single'): void {
    const preview = document.createElement('div');
    preview.className = 'webcam-preview-tile';
    preview.dataset.feedId = feed.id;

    const status = document.createElement('div');
    status.className = 'webcam-preview-status';
    const dot = document.createElement('span');
    dot.className = 'webcam-live-dot';
    const statusText = document.createElement('span');
    statusText.textContent = t('components.webcams.previewStatus') || 'Live preview';
    status.append(dot, statusText);

    const title = document.createElement('div');
    title.className = 'webcam-preview-title';
    title.textContent = feed.city;

    const meta = document.createElement('div');
    meta.className = 'webcam-preview-meta';
    meta.textContent = `${feed.country} · ${feed.region.replace('-', ' ')}`;

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'offline-retry webcam-preview-play';
    playBtn.textContent = t('components.webcams.play') || 'Play';
    // First play intent lights up everything (the wall + Live News), not just this tile.
    const playAll = () => {
      trackWebcamSelected(feed.id, feed.city, source);
      this.activeFeed = feed;
      this.savePrefs();
      playAllLiveMedia();
    };
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playAll();
    });

    preview.addEventListener('click', () => playAll());
    preview.append(status, title, meta, playBtn);
    container.appendChild(preview);
  }

  private retryIframe(oldIframe: HTMLIFrameElement): void {
    const tracker = this.iframeTrackers.get(oldIframe);
    if (!tracker) return;

    if (!oldIframe.parentNode) {
      this.clearIframeTimeout(oldIframe);
      return;
    }
    const freshIframe = this.createIframe(tracker.feed);
    try {
      oldIframe.replaceWith(freshIframe);
    } catch {
      // DOM was restructured between parentNode check and replaceWith (race with scroll/channel switch).
      // Fall back to appending the fresh iframe to the container.
      this.clearIframeTimeout(oldIframe);
      this.iframeTrackers.delete(oldIframe);
      oldIframe.src = 'about:blank';
      tracker.container.querySelector('.webcam-embed-fallback')?.remove();
      tracker.container.appendChild(freshIframe);
      const idx = this.iframes.indexOf(oldIframe);
      if (idx >= 0) this.iframes[idx] = freshIframe;
      else this.iframes.push(freshIframe);
      this.trackIframe(freshIframe, tracker.feed, tracker.container);
      return;
    }
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
    if (!isAllowedWebcamEmbedMessageOrigin(e.origin, iframe.src)) return;

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

    if (!this.isVisible) {
      // #6557: a paused state is authoritative content.
      this.setTrustedContent(trustedHtml(`<div class="webcam-placeholder">${escapeHtml(t('components.webcams.paused'))}</div>`, "legacy direct innerHTML migration"));
      return;
    }

    if (this.idleStopped) {
      const notice = createLiveMediaIdleNotice({
        panel: 'live-webcams',
        heading: t('panels.liveWebcams'),
        idleAfterMs: this.idleStopped.idleAfterMs,
      });
      notice.classList.add('webcam-idle-notice');
      this.setContentNodes(notice);
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

    setTrustedHtml(this.content, trustedHtml('', "legacy direct innerHTML migration"));
    this.content.className = 'panel-content webcam-content';

    const grid = document.createElement('div');
    grid.className = 'webcam-grid';

    const feeds = this.gridFeeds;

    feeds.forEach((feed) => {
      const cell = document.createElement('div');
      cell.className = 'webcam-cell';

      if (this.activeIframeFeedIds.has(feed.id)) {
        const iframe = this.createIframe(feed);
        cell.appendChild(iframe);
        this.iframes.push(iframe);
        this.trackIframe(iframe, feed, cell);

        const label = document.createElement('div');
        label.className = 'webcam-cell-label';
        setTrustedHtml(label, trustedHtml(`<span class="webcam-live-dot"></span><span class="webcam-city">${escapeHtml(feed.city.toUpperCase())}</span>`, "legacy direct innerHTML migration"));
        cell.appendChild(label);
      } else {
        this.renderPreviewTile(cell, feed, 'grid');
      }

      grid.appendChild(cell);
    });

    this.content.appendChild(grid);
  }

  private renderSingle(): void {
    setTrustedHtml(this.content, trustedHtml('', "legacy direct innerHTML migration"));
    this.content.className = 'panel-content webcam-content';

    const wrapper = document.createElement('div');
    wrapper.className = 'webcam-single';

    if (this.activeIframeFeedIds.has(this.activeFeed.id)) {
      const iframe = this.createIframe(this.activeFeed);
      wrapper.appendChild(iframe);
      this.iframes.push(iframe);
      this.trackIframe(iframe, this.activeFeed, wrapper);
    } else {
      this.renderPreviewTile(wrapper, this.activeFeed, 'single');
    }

    const switcher = document.createElement('div');
    switcher.className = 'webcam-switcher';

    if (!this.forceSingleView) {
      const backBtn = document.createElement('button');
      backBtn.className = 'webcam-feed-btn webcam-back-btn';
      setTrustedHtml(backBtn, trustedHtml('<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg> Grid', "legacy direct innerHTML migration"));
      backBtn.addEventListener('click', () => this.setViewMode('grid'));
      switcher.appendChild(backBtn);
    }

    this.filteredFeeds.forEach(feed => {
      const btn = document.createElement('button');
      btn.className = `webcam-feed-btn${feed.id === this.activeFeed.id ? ' active' : ''}`;
      btn.textContent = feed.city;
      btn.addEventListener('click', () => {
        if (feed.id === this.activeFeed.id) return;
        // Single view shows one feed at a time — switching keeps playing if a stream was active.
        const wasPlaying = this.activeIframeFeedIds.size > 0;
        this.activeIframeFeedIds.clear();
        this.activeFeed = feed;
        this.savePrefs();
        if ((this.alwaysOn || wasPlaying) && this.isVisible && !document.hidden) {
          this.playFeed(feed, 'single');
        } else {
          this.render();
        }
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
        if (this.isVisible && !wasVisible) {
          // startAlwaysOnPlayback renders the wall when always-on; otherwise render the previews once.
          if (!this.startAlwaysOnPlayback()) this.render();
        } else if (!this.isVisible && wasVisible) {
          this.teardownPlayback();
        }
      },
      { threshold: 0.1 }
    );
    this.observer.observe(this.element);
  }

  public refresh(): void {
    if (this.isVisible) {
      this.render();
    }
  }

  public stopLiveMediaForClose(): void {
    this.idleStopped = null;
    this.clearActivePlayback();
    if (this.isVisible && this.element.isConnected) {
      this.render();
    }
  }

  public resumeLiveMediaForShow(): void {
    if (!this.alwaysOn || document.hidden) return;
    this.isVisible = this.isVisible || this.isPanelVisible();
    this.startAlwaysOnPlayback();
  }

  public destroy(): void {
    // Disconnect the IntersectionObserver FIRST so a scroll-driven callback can't
    // re-render / re-create iframes (with leaked ready-timeouts) mid-teardown.
    this.observer?.disconnect();
    unregisterLiveMediaStarter('live-webcams', this.boundPlayAllStarter);
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    document.removeEventListener('keydown', this.boundFullscreenEscHandler);
    window.removeEventListener('message', this.boundEmbedMessageHandler);
    if (this.isFullscreen) this.setFullscreen(false);
    this.unsubscribeStreamSettings?.();
    this.unsubscribeStreamSettings = null;
    this.unsubscribeIdle?.();
    this.unsubscribeIdle = null;
    this.destroyIframes();
    super.destroy();
  }
}
