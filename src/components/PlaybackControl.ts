import { getSnapshotTimestamps, getSnapshotAt, isStorageAvailable, type DashboardSnapshot } from '@/services/storage';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { LatestRequestGuard } from '@/utils/latest-request-guard';


export class PlaybackControl {
  private element: HTMLElement;
  private isPlaybackMode = false;
  private timestamps: number[] = [];
  private currentIndex = 0;
  private onSnapshotChange: ((snapshot: DashboardSnapshot | null) => void) | null = null;
  private snapshotGuard = new LatestRequestGuard();
  private timestampGuard = new LatestRequestGuard();

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'playback-control';
    setTrustedHtml(this.element, trustedHtml(`
      <button class="playback-toggle" title="${t('components.playback.toggleMode')}" aria-label="${t('components.playback.toggleMode')}">
        <span class="playback-icon">⏪</span>
      </button>
      <div class="playback-panel hidden">
        <div class="playback-header">
          <span>${t('components.playback.historicalPlayback')}</span>
          <button class="playback-close" aria-label="${t('components.playback.close')}">×</button>
        </div>
        <p class="playback-notice" role="status" hidden></p>
        <div class="playback-slider-container">
          <input type="range" class="playback-slider" min="0" max="100" value="100" aria-label="${t('components.playback.historicalPlayback')}">
          <div class="playback-time">${t('components.playback.live')}</div>
        </div>
        <div class="playback-controls">
          <button class="playback-btn" data-action="start" aria-label="${t('components.playback.skipToStart')}">⏮</button>
          <button class="playback-btn" data-action="prev" aria-label="${t('components.playback.previous')}">◀</button>
          <button class="playback-btn playback-live" data-action="live">${t('components.playback.live')}</button>
          <button class="playback-btn" data-action="next" aria-label="${t('components.playback.next')}">▶</button>
          <button class="playback-btn" data-action="end" aria-label="${t('components.playback.skipToEnd')}">⏭</button>
        </div>
      </div>
    `, "legacy direct innerHTML migration"));

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const toggle = this.element.querySelector('.playback-toggle')!;
    const panel = this.element.querySelector('.playback-panel')!;
    const closeBtn = this.element.querySelector('.playback-close')!;
    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;

    toggle.addEventListener('click', async () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        await this.loadTimestamps();
      } else {
        this.timestampGuard.begin();
      }
    });

    closeBtn.addEventListener('click', () => {
      this.timestampGuard.begin();
      panel.classList.add('hidden');
      this.goLive();
    });

    slider.addEventListener('input', () => {
      const idx = parseInt(slider.value, 10);
      this.currentIndex = idx;
      this.loadSnapshot(idx);
    });

    this.element.querySelectorAll('.playback-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action;
        this.handleAction(action!);
      });
    });
  }

  private async loadTimestamps(): Promise<void> {
    const requestId = this.timestampGuard.begin();
    // Checked on every open: storage the browser blocks now may be allowed
    // later in the same session.
    const available = await isStorageAvailable().catch(() => true);
    const timestamps = available ? await getSnapshotTimestamps() : [];
    if (!this.timestampGuard.isCurrent(requestId) || !this.element?.isConnected) return;
    this.setStorageUnavailable(!available);
    this.timestamps = timestamps;
    this.timestamps.sort((a, b) => a - b);

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.max = String(Math.max(0, this.timestamps.length - 1));
    slider.value = slider.max;
    this.currentIndex = this.timestamps.length - 1;

    this.updateTimeDisplay();
  }

  /**
   * Explain a blocked database instead of showing an empty slider. Stepping
   * is disabled because there is nothing to step through; Live and close
   * stay usable.
   */
  private setStorageUnavailable(unavailable: boolean): void {
    const notice = this.element.querySelector<HTMLElement>('.playback-notice');
    if (notice) {
      // Translated at show time: the control is built during first paint,
      // when only the English shell dictionary may be loaded.
      notice.textContent = unavailable ? t('components.playback.storageUnavailable') : '';
      notice.hidden = !unavailable;
    }
    this.element
      .querySelectorAll<HTMLInputElement | HTMLButtonElement>('.playback-slider, .playback-btn:not(.playback-live)')
      .forEach((control) => { control.disabled = unavailable; });
  }

  private async loadSnapshot(index: number): Promise<void> {
    if (index < 0 || index >= this.timestamps.length) {
      this.goLive();
      return;
    }

    const timestamp = this.timestamps[index];
    if (!timestamp) {
      this.goLive();
      return;
    }

    const requestId = this.snapshotGuard.begin();
    this.isPlaybackMode = true;
    this.updateTimeDisplay();

    const snapshot = await getSnapshotAt(timestamp);
    if (!this.snapshotGuard.isCurrent(requestId) || !this.isPlaybackMode || !this.element?.isConnected) return;
    this.onSnapshotChange?.(snapshot);

    document.body.classList.add('playback-mode');
    this.element.querySelector('.playback-live')?.classList.remove('active');
  }

  private goLive(): void {
    this.snapshotGuard.begin();
    this.isPlaybackMode = false;
    this.currentIndex = this.timestamps.length - 1;

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.value = slider.max;

    this.updateTimeDisplay();
    this.onSnapshotChange?.(null);

    document.body.classList.remove('playback-mode');
    this.element.querySelector('.playback-live')?.classList.add('active');
  }

  private handleAction(action: string): void {
    switch (action) {
      case 'start':
        this.currentIndex = 0;
        break;
      case 'prev':
        this.currentIndex = Math.max(0, this.currentIndex - 1);
        break;
      case 'next':
        this.currentIndex = Math.min(this.timestamps.length - 1, this.currentIndex + 1);
        break;
      case 'end':
        this.currentIndex = this.timestamps.length - 1;
        break;
      case 'live':
        this.goLive();
        return;
    }

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.value = String(this.currentIndex);
    this.loadSnapshot(this.currentIndex);
  }

  private updateTimeDisplay(): void {
    const display = this.element.querySelector('.playback-time')!;

    if (!this.isPlaybackMode || this.timestamps.length === 0) {
      display.textContent = t('components.playback.live');
      display.classList.remove('historical');
      return;
    }

    const timestamp = this.timestamps[this.currentIndex];
    if (timestamp) {
      const date = new Date(timestamp);
      display.textContent = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      display.classList.add('historical');
    }
  }

  /**
   * Return to live data and close the panel — for the premium gate revoking
   * access while a snapshot is being replayed (#5632). Hiding the control is
   * not enough on its own: the "Live" button lives INSIDE the element being
   * hidden, so the dashboard would be stranded on historical data with no way
   * back.
   *
   * The `isPlaybackMode` guard is load-bearing. The gate evaluates to a
   * non-visible verdict at least once on every page load ('pending' while
   * Clerk hydrates), and an unguarded call would fire `onSnapshotChange(null)`
   * — and therefore a full `loadAllData()` — on each of them.
   */
  public exitPlayback(): void {
    if (!this.isPlaybackMode) return;
    this.element.querySelector('.playback-panel')?.classList.add('hidden');
    this.goLive();
  }

  public onSnapshot(callback: (snapshot: DashboardSnapshot | null) => void): void {
    this.onSnapshotChange = callback;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public isInPlaybackMode(): boolean {
    return this.isPlaybackMode;
  }
}
