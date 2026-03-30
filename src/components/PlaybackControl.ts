import { getSnapshots, type DashboardSnapshot } from '@/services/storage';
import { buildReplayNarrative } from '@/services/replay-narrative';
import { t } from '@/services/i18n';

export class PlaybackControl {
  private element: HTMLElement;
  private isPlaybackMode = false;
  private snapshots: DashboardSnapshot[] = [];
  private currentIndex = 0;
  private isPlaying = false;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private onSnapshotChange: ((snapshot: DashboardSnapshot | null) => void) | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'playback-control';
    this.element.innerHTML = `
      <button class="playback-toggle" title="${t('components.playback.toggleMode')}">
        <span class="playback-icon">⏪</span>
      </button>
      <div class="playback-panel hidden">
        <div class="playback-header">
          <span>${t('components.playback.historicalPlayback')}</span>
          <button class="playback-close">×</button>
        </div>
        <div class="playback-slider-container">
          <div class="playback-dots"></div>
          <input type="range" class="playback-slider" min="0" max="0" value="0">
          <div class="playback-time">${t('components.playback.live')}</div>
        </div>
        <div class="playback-narrative">
          <div class="playback-narrative-title">Replay idle</div>
          <div class="playback-narrative-summary">Move the timeline to replay saved watchlist and escalation state.</div>
          <div class="playback-narrative-bullets"></div>
        </div>
        <div class="playback-controls">
          <button class="playback-btn" data-action="start">⏮</button>
          <button class="playback-btn" data-action="prev">◀</button>
          <button class="playback-btn playback-play" data-action="play">Play</button>
          <button class="playback-btn playback-live active" data-action="live">${t('components.playback.live')}</button>
          <button class="playback-btn" data-action="next">▶</button>
          <button class="playback-btn" data-action="end">⏭</button>
        </div>
      </div>
    `;

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
        await this.loadSnapshots();
      } else {
        this.stopPlayback();
      }
    });

    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      this.goLive();
    });

    slider.addEventListener('input', () => {
      this.stopPlayback();
      this.currentIndex = Number.parseInt(slider.value, 10);
      this.loadSnapshot(this.currentIndex);
    });

    this.element.querySelectorAll<HTMLElement>('.playback-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action) this.handleAction(action);
      });
    });

    this.element.querySelector('.playback-dots')?.addEventListener('click', (event) => {
      const dot = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
      if (!dot) return;
      const index = Number.parseInt(dot.dataset.index || '', 10);
      if (!Number.isFinite(index)) return;
      this.stopPlayback();
      this.currentIndex = index;
      slider.value = String(index);
      this.loadSnapshot(index);
    });
  }

  private async loadSnapshots(): Promise<void> {
    this.snapshots = await getSnapshots();
    this.snapshots.sort((a, b) => a.timestamp - b.timestamp);

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.max = String(Math.max(0, this.snapshots.length - 1));
    slider.value = slider.max;
    this.currentIndex = Math.max(0, this.snapshots.length - 1);

    this.renderDots();
    this.updateTimeDisplay();
    this.renderNarrative();
  }

  private loadSnapshot(index: number): void {
    if (index < 0 || index >= this.snapshots.length) {
      this.goLive();
      return;
    }

    const snapshot = this.snapshots[index];
    if (!snapshot) {
      this.goLive();
      return;
    }

    this.isPlaybackMode = true;
    this.updateTimeDisplay();
    this.renderDots();
    this.renderNarrative();
    this.onSnapshotChange?.(snapshot);

    document.body.classList.add('playback-mode');
    this.element.querySelector('.playback-live')?.classList.remove('active');
  }

  private goLive(): void {
    this.stopPlayback();
    this.isPlaybackMode = false;
    this.currentIndex = Math.max(0, this.snapshots.length - 1);

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.value = slider.max;

    this.updateTimeDisplay();
    this.renderDots();
    this.renderNarrative();
    this.onSnapshotChange?.(null);

    document.body.classList.remove('playback-mode');
    this.element.querySelector('.playback-live')?.classList.add('active');
  }

  private handleAction(action: string): void {
    switch (action) {
      case 'start': {
        this.currentIndex = 0;
        break;
      }
      case 'prev': {
        this.currentIndex = Math.max(0, this.currentIndex - 1);
        break;
      }
      case 'next': {
        this.currentIndex = Math.min(this.snapshots.length - 1, this.currentIndex + 1);
        break;
      }
      case 'end': {
        this.currentIndex = Math.max(0, this.snapshots.length - 1);
        break;
      }
      case 'play': {
        this.togglePlayback();
        return;
      }
      case 'live': {
        this.goLive();
        return;
      }
    }

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.value = String(this.currentIndex);
    this.loadSnapshot(this.currentIndex);
  }

  private togglePlayback(): void {
    if (this.isPlaying) {
      this.stopPlayback();
      return;
    }
    if (this.snapshots.length === 0) return;
    if (this.currentIndex >= this.snapshots.length - 1) {
      this.currentIndex = 0;
    }

    this.isPlaying = true;
    this.updatePlayButton();

    const slider = this.element.querySelector('.playback-slider') as HTMLInputElement;
    slider.value = String(this.currentIndex);
    this.loadSnapshot(this.currentIndex);

    this.playbackTimer = setInterval(() => {
      if (this.currentIndex >= this.snapshots.length - 1) {
        this.stopPlayback();
        return;
      }
      this.currentIndex += 1;
      slider.value = String(this.currentIndex);
      this.loadSnapshot(this.currentIndex);
    }, 1200);
  }

  private stopPlayback(): void {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.isPlaying = false;
    this.updatePlayButton();
  }

  private updatePlayButton(): void {
    const playBtn = this.element.querySelector('.playback-play');
    if (playBtn) {
      playBtn.textContent = this.isPlaying ? 'Pause' : 'Play';
    }
  }

  private renderDots(): void {
    const dotsEl = this.element.querySelector('.playback-dots');
    if (!dotsEl) return;

    if (this.snapshots.length === 0) {
      dotsEl.innerHTML = '<span class="playback-dots-empty">No saved snapshots yet.</span>';
      return;
    }

    const step = Math.max(1, Math.ceil(this.snapshots.length / 18));
    const dotIndexes = this.snapshots
      .map((_, index) => index)
      .filter((index) => index === 0 || index === this.snapshots.length - 1 || index % step === 0);

    dotsEl.innerHTML = dotIndexes.map((index) => `
      <button
        class="playback-dot ${index === this.currentIndex ? 'active' : ''}"
        data-index="${index}"
        title="${new Date(this.snapshots[index]!.timestamp).toLocaleString()}"
      ></button>
    `).join('');
  }

  private renderNarrative(): void {
    const titleEl = this.element.querySelector('.playback-narrative-title');
    const summaryEl = this.element.querySelector('.playback-narrative-summary');
    const bulletsEl = this.element.querySelector('.playback-narrative-bullets');
    if (!titleEl || !summaryEl || !bulletsEl) return;

    if (!this.isPlaybackMode || this.snapshots.length === 0) {
      titleEl.textContent = 'Replay idle';
      summaryEl.textContent = 'Move the timeline to replay saved watchlist and escalation state.';
      bulletsEl.innerHTML = '';
      return;
    }

    const current = this.snapshots[this.currentIndex];
    const previous = this.currentIndex > 0 ? this.snapshots[this.currentIndex - 1] : null;
    const narrative = buildReplayNarrative(current?.watchlistSummary, previous?.watchlistSummary, current?.timestamp);

    titleEl.textContent = narrative.headline;
    summaryEl.textContent = narrative.summary;
    bulletsEl.innerHTML = narrative.bullets.map((bullet) => `<div class="playback-bullet">${bullet}</div>`).join('');
    (this.element.querySelector('.playback-narrative') as HTMLElement | null)?.setAttribute('data-severity', narrative.severity);
  }

  private updateTimeDisplay(): void {
    const display = this.element.querySelector('.playback-time')!;

    if (!this.isPlaybackMode || this.snapshots.length === 0) {
      display.textContent = t('components.playback.live');
      display.classList.remove('historical');
      return;
    }

    const snapshot = this.snapshots[this.currentIndex];
    if (snapshot) {
      const date = new Date(snapshot.timestamp);
      display.textContent = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      display.classList.add('historical');
    }
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
