import { Panel } from './Panel';
import { STORAGE_KEYS } from '@/config';
import { WEBCAM_GRID_PRIORITY, WEBCAM_SOURCES, type WebcamSlotId } from '@/config/live-video-sources';
import { isDesktopRuntime } from '@/services/runtime';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '../services/i18n';
import { track, trackWebcamSelected, trackWebcamRegionFiltered } from '@/services/analytics';
import { subscribeStreamQualityChange } from '@/services/ai-flow-settings';
import { isMobileDevice, loadFromStorage, saveToStorage } from '@/utils';
import { playAllLiveMedia, registerLiveMediaStarter, unregisterLiveMediaStarter } from '@/services/live-media-controller';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsAlwaysOnChange } from '@/services/live-stream-settings';
import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { sourceListsChannel, type LiveVideoSource } from '@/services/live-video/model';
import { withResolvedLiveVideos } from '@/services/live-video/resolved';
import { createFailureMemory, openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';
import { createLiveMediaIdleNotice, trackLiveMediaIdleStop } from './live-media-idle-notice';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


type WebcamRegion = 'middle-east' | 'europe' | 'asia' | 'americas' | 'space';

interface WebcamFeed {
  id: WebcamSlotId;
  city: string;
  country: string;
  region: WebcamRegion;
}

// The streams for each feed live in src/config/live-video-sources.ts. A feed with none is hidden.
const WEBCAM_FEEDS: WebcamFeed[] = [
  // Middle East (conflict hotspots)
  { id: 'jerusalem', city: 'Jerusalem', country: 'Israel', region: 'middle-east' },
  { id: 'middle-east', city: 'Middle East', country: 'Multi', region: 'middle-east' },
  { id: 'tel-aviv', city: 'Tel Aviv', country: 'Israel', region: 'middle-east' },
  { id: 'mecca', city: 'Mecca', country: 'Saudi Arabia', region: 'middle-east' },
  { id: 'istanbul', city: 'Istanbul', country: 'Turkey', region: 'middle-east' },
  { id: 'medina', city: 'Medina', country: 'Saudi Arabia', region: 'middle-east' },
  { id: 'beirut-mtv', city: 'Beirut', country: 'Lebanon', region: 'middle-east' },
  // Europe
  { id: 'kyiv', city: 'Ukraine', country: 'Ukraine', region: 'europe' },
  { id: 'paris', city: 'Paris', country: 'France', region: 'europe' },
  { id: 'st-petersburg', city: 'St. Petersburg', country: 'Russia', region: 'europe' },
  { id: 'london', city: 'London', country: 'UK', region: 'europe' },
  // Americas
  { id: 'washington', city: 'Washington DC', country: 'USA', region: 'americas' },
  { id: 'new-york', city: 'New York', country: 'USA', region: 'americas' },
  { id: 'los-angeles', city: 'Los Angeles', country: 'USA', region: 'americas' },
  { id: 'miami', city: 'Miami', country: 'USA', region: 'americas' },
  // Asia-Pacific — Taipei first (strait hotspot), then Shanghai, Tokyo, Seoul
  { id: 'taipei', city: 'Taipei', country: 'Taiwan', region: 'asia' },
  { id: 'shanghai', city: 'Shanghai', country: 'China', region: 'asia' },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', region: 'asia' },
  { id: 'seoul', city: 'Seoul', country: 'South Korea', region: 'asia' },
  { id: 'sydney', city: 'Sydney', country: 'Australia', region: 'asia' },
  // Space
  { id: 'iss-earth', city: 'ISS Earth View', country: 'Space', region: 'space' },
  { id: 'nasa-live', city: 'NASA TV', country: 'Space', region: 'space' },
  { id: 'space-x', city: 'SpaceX', country: 'Space', region: 'space' },
  { id: 'space-walk', city: 'Space', country: 'Space', region: 'space' },
];

const MAX_GRID_CELLS = 4;

type ViewMode = 'grid' | 'single';
type RegionFilter = 'all' | WebcamRegion;

const ALL_REGIONS: RegionFilter[] = ['all', 'middle-east', 'europe', 'americas', 'asia', 'space'];

function hasStreams(feed: WebcamFeed): boolean {
  return WEBCAM_SOURCES[feed.id].length > 0;
}

function sourcedFeeds(): WebcamFeed[] {
  return WEBCAM_FEEDS.filter(hasStreams);
}

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
  const feeds = sourcedFeeds();
  const regionFeeds = regionFilter === 'all' ? feeds
    : feeds.filter(f => f.region === regionFilter);
  const matchedFeed = regionFeeds.find(f => f.id === stored.activeFeedId);
  const activeFeedId = matchedFeed?.id ?? regionFeeds[0]?.id ?? feeds[0]?.id ?? WEBCAM_FEEDS[0]!.id;
  return { regionFilter, viewMode, activeFeedId };
}

function saveWebcamPrefs(prefs: WebcamPrefs): void {
  saveToStorage(STORAGE_KEYS.webcamPrefs, prefs);
}

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class LiveWebcamsPanel extends Panel {
  private viewMode: ViewMode = 'grid';
  private regionFilter: RegionFilter = 'all';
  private activeFeed: WebcamFeed = WEBCAM_FEEDS[0]!;
  private toolbar: HTMLElement | null = null;
  // One verified live session per playing tile, keyed by feed id.
  private tileSessions = new Map<string, LiveVideoSession>();
  // Bumped whenever every tile is torn down (render, idle stop, close); a tile still waiting for the resolved
  // channel map from an older generation never opens its session.
  private mountGeneration = 0;
  // When each feed was last found offline. A recently offline feed is not picked to replace another.
  private readonly failureMemory = createFailureMemory();
  // Grid slots whose feed went offline, each mapped to the feed playing in its place. Held until the user
  // picks a region or view again or closes the panel, so every render and Resume keeps the swap.
  private substitutes = new Map<string, WebcamFeed>();
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

  constructor() {
    super({ id: 'live-webcams', title: t('panels.liveWebcams'), className: 'panel-wide', closable: true, collapsible: true, infoTooltip: t('components.liveWebcams.infoTooltip') });
    this.insertLiveCountBadge(sourcedFeeds().length);

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
    const feeds = sourcedFeeds();
    if (this.regionFilter === 'all') return feeds;
    return feeds.filter(f => f.region === this.regionFilter);
  }

  /** Feeds the grid may show, in order: the priority list for all regions, else the region's feeds. */
  private get gridPool(): WebcamFeed[] {
    if (this.regionFilter !== 'all') return this.filteredFeeds;
    return WEBCAM_GRID_PRIORITY
      .map(id => WEBCAM_FEEDS.find(f => f.id === id))
      .filter((feed): feed is WebcamFeed => feed !== undefined && hasStreams(feed));
  }

  /** The first four pool feeds, each one that went offline replaced by the feed swapped in for it. */
  private get gridFeeds(): WebcamFeed[] {
    return this.gridPool.slice(0, MAX_GRID_CELLS).map(feed => this.substitutes.get(feed.id) ?? feed);
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
    this.substitutes.clear();
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
    this.substitutes.clear();
    this.savePrefs();
    this.toolbar?.querySelectorAll('.webcam-view-btn').forEach(btn => {
      (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
    });
    // In always-on, let startAlwaysOnPlayback own the render so the wall isn't built then immediately rebuilt.
    if (!this.startAlwaysOnPlayback()) {
      this.render();
    }
  }

  /** Plays one feed in a tile (a grid cell or the single view) through a verified live session. */
  private mountTile(container: HTMLElement, feed: WebcamFeed): void {
    container.dataset.feedId = feed.id;
    const label = document.createElement('div');
    label.className = 'webcam-cell-label';
    container.appendChild(label);
    const source: LiveVideoSource = { slot: `webcams/${feed.id}`, entries: WEBCAM_SOURCES[feed.id], origin: 'builtin' };
    if (!sourceListsChannel(source)) {
      this.openTile(container, feed, label, source);
      return;
    }
    // A tile that lists a channel first asks for that channel's resolved live video (at most 1.5 s).
    label.replaceChildren(span('webcam-city', feed.city.toUpperCase()), span('webcam-tile-status', t('components.webcams.connecting')));
    const generation = this.mountGeneration;
    void withResolvedLiveVideos(source).then((resolved) => {
      // render(), an idle stop or destroy() since then rebuilt or cleared the tiles. render() builds new cells with
      // the same feedId, so only the generation and isConnected tell this detached cell from the live one.
      if (generation !== this.mountGeneration || !container.isConnected || container.dataset.feedId !== feed.id) return;
      this.openTile(container, feed, label, resolved);
    });
  }

  private openTile(container: HTMLElement, feed: WebcamFeed, label: HTMLElement, source: LiveVideoSource): void {
    const session = openLiveVideo(container, {
      source,
      autoplay: true,
      muted: true,
      presentation: { title: `${feed.city} live webcam`, className: 'webcam-iframe', controls: false },
      onState: (state) => this.onTileState(container, feed, label, state),
    });
    // The first state arrives synchronously, and an offline one may already have swapped the tile.
    if (container.dataset.feedId === feed.id) this.tileSessions.set(feed.id, session);
    else session.destroy();
  }

  private onTileState(container: HTMLElement, feed: WebcamFeed, label: HTMLElement, state: LiveVideoState): void {
    if (container.dataset.feedId !== feed.id) return;
    container.querySelector('.webcam-embed-fallback')?.remove();
    const parts: HTMLElement[] = [];
    // The live dot is a claim: only a verified live stream earns it.
    if (state.phase === 'live') parts.push(span('webcam-live-dot'));
    parts.push(span('webcam-city', feed.city.toUpperCase()));
    if (state.phase === 'connecting') parts.push(span('webcam-tile-status', t('components.webcams.connecting')));
    if (state.phase === 'unverified') parts.push(span('webcam-tile-status', t('components.webcams.unverified')));
    label.replaceChildren(...parts);

    if (state.phase === 'live') this.failureMemory.clear(feed.id);
    if (state.phase === 'offline') this.handleTileOffline(container, feed, state.watchUrl);
  }

  /** In the grid, swap an offline tile for the next spare feed; otherwise show an offline card. */
  private handleTileOffline(container: HTMLElement, feed: WebcamFeed, watchUrl: string | null): void {
    this.failureMemory.markOffline(feed.id);
    const spare = container.classList.contains('webcam-cell') ? this.spareFeed() : null;
    if (!spare) {
      this.renderOfflineCard(container, feed, watchUrl);
      return;
    }
    this.tileSessions.get(feed.id)?.destroy();
    this.tileSessions.delete(feed.id);
    // A replacement that goes offline in turn hands its slot to the next spare.
    const slotId = Array.from(this.substitutes).find(([, shown]) => shown.id === feed.id)?.[0] ?? feed.id;
    this.substitutes.set(slotId, spare);
    // Keep the idle-stop snapshot honest: Resume restores what was actually on screen.
    if (this.activeIframeFeedIds.delete(feed.id)) this.activeIframeFeedIds.add(spare.id);
    container.replaceChildren();
    this.mountTile(container, spare);
    this.renderOfflineNote();
  }

  /** The next pool feed that is not on the grid, not swapped out, and not recently offline. */
  private spareFeed(): WebcamFeed | null {
    const shown = new Set(this.gridFeeds.map(feed => feed.id));
    return this.gridPool.find(feed => !shown.has(feed.id) && !this.substitutes.has(feed.id) && !this.failureMemory.isKnownOffline(feed.id)) ?? null;
  }

  /** Names the feeds the grid swapped out because they went offline. */
  private renderOfflineNote(): void {
    const grid = this.content.querySelector('.webcam-grid');
    if (!grid) return;
    const swappedOut = this.gridPool.slice(0, MAX_GRID_CELLS).filter(feed => this.substitutes.has(feed.id));
    let note = this.content.querySelector<HTMLElement>('.webcam-offline-note');
    if (swappedOut.length === 0) {
      note?.remove();
      return;
    }
    if (!note) {
      note = document.createElement('div');
      note.className = 'webcam-offline-note';
      grid.after(note);
    }
    note.textContent = swappedOut.map(feed => t('components.webcams.offline', { city: feed.city })).join(' · ');
  }

  private renderOfflineCard(container: HTMLElement, feed: WebcamFeed, watchUrl: string | null): void {
    const overlay = document.createElement('div');
    overlay.className = 'webcam-embed-fallback';
    overlay.addEventListener('click', (e) => e.stopPropagation());

    const message = document.createElement('div');
    message.className = 'webcam-embed-fallback-text';
    message.textContent = t('components.webcams.offline', { city: feed.city });

    const actions = document.createElement('div');
    actions.className = 'webcam-embed-fallback-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'offline-retry webcam-embed-retry';
    retryBtn.textContent = t('common.retry') || 'Retry';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.failureMemory.clear(feed.id);
      this.tileSessions.get(feed.id)?.retry();
    });
    actions.appendChild(retryBtn);

    if (watchUrl) {
      const openBtn = document.createElement('a');
      openBtn.className = 'offline-retry webcam-embed-open';
      openBtn.href = watchUrl;
      openBtn.target = '_blank';
      openBtn.rel = 'noopener noreferrer';
      openBtn.textContent = t('components.liveNews.openOnYouTube') || 'Open on YouTube';
      openBtn.addEventListener('click', (e) => e.stopPropagation());
      actions.appendChild(openBtn);
    }

    overlay.append(message, actions);
    container.appendChild(overlay);
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
    // Grid is a wall: swap just the clicked tile into a live player so sibling streams keep playing.
    if (this.viewMode === 'grid' && !this.forceSingleView && !alreadyActive && this.activateGridCell(feed)) {
      return;
    }
    this.render();
  }

  /** Swap a single grid preview tile into a live player in place, leaving sibling streams untouched. */
  private activateGridCell(feed: WebcamFeed): boolean {
    const cell = this.content.querySelector<HTMLElement>(`.webcam-grid .webcam-cell[data-feed-id="${CSS.escape(feed.id)}"]`);
    if (!cell?.querySelector('.webcam-preview-tile')) return false;
    cell.replaceChildren();
    this.mountTile(cell, feed);
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
   * full render rebuilds from zero — no already-playing player is destroyed/reloaded. A future caller
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
    this.destroySessions();
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

    // No live dot before play: nothing has been verified live yet.
    const status = document.createElement('div');
    status.className = 'webcam-preview-status';
    status.textContent = t('components.webcams.previewStatus') || 'Ready to play';

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

  private render(): void {
    this.destroySessions();

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

  private renderNoFeeds(): void {
    const placeholder = document.createElement('div');
    placeholder.className = 'webcam-placeholder';
    placeholder.textContent = t('components.webcams.noFeeds');
    this.setContentNodes(placeholder);
  }

  private renderGrid(): void {
    if (this.forceSingleView) {
      this.viewMode = 'single';
      this.renderSingle();
      return;
    }

    this.content.className = 'panel-content webcam-content';
    const feeds = this.gridFeeds;
    if (feeds.length === 0) {
      this.renderNoFeeds();
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'webcam-grid';

    feeds.forEach((feed) => {
      const cell = document.createElement('div');
      cell.className = 'webcam-cell';
      cell.dataset.feedId = feed.id;

      if (this.activeIframeFeedIds.has(feed.id)) {
        this.mountTile(cell, feed);
      } else {
        this.renderPreviewTile(cell, feed, 'grid');
      }

      grid.appendChild(cell);
    });

    this.setContentNodes(grid);
    this.renderOfflineNote();
  }

  private renderSingle(): void {
    this.content.className = 'panel-content webcam-content';
    const feeds = this.filteredFeeds;
    if (feeds.length === 0) {
      this.renderNoFeeds();
      return;
    }
    if (!feeds.includes(this.activeFeed)) this.activeFeed = feeds[0]!;

    const wrapper = document.createElement('div');
    wrapper.className = 'webcam-single';

    if (this.activeIframeFeedIds.has(this.activeFeed.id)) {
      this.mountTile(wrapper, this.activeFeed);
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

    feeds.forEach(feed => {
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

    this.setContentNodes(wrapper, switcher);
  }

  private destroySessions(): void {
    this.mountGeneration += 1;
    for (const session of this.tileSessions.values()) session.destroy();
    this.tileSessions.clear();
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
    this.substitutes.clear();
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
    // re-render / re-create players mid-teardown.
    this.observer?.disconnect();
    unregisterLiveMediaStarter('live-webcams', this.boundPlayAllStarter);
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    document.removeEventListener('keydown', this.boundFullscreenEscHandler);
    if (this.isFullscreen) this.setFullscreen(false);
    this.unsubscribeStreamSettings?.();
    this.unsubscribeStreamSettings = null;
    this.unsubscribeIdle?.();
    this.unsubscribeIdle = null;
    this.destroySessions();
    super.destroy();
  }
}
