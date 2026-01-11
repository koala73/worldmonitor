import type { PizzIntStatus, GdeltTensionPair } from '@/types';
import { escapeHtml } from '@/utils/sanitize';

const DEFCON_COLORS: Record<number, string> = {
  1: '#ff0040',
  2: '#ff4400',
  3: '#ffaa00',
  4: '#00aaff',
  5: '#2d8a6e',
};

export class PizzIntIndicator {
  private element: HTMLElement;
  private isExpanded = false;
  private status: PizzIntStatus | null = null;
  private tensions: GdeltTensionPair[] = [];

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'pizzint-indicator';
    this.element.innerHTML = `
      <button class="pizzint-toggle" title="Pentagon Pizza Index">
        <span class="pizzint-icon">🍕</span>
        <span class="pizzint-defcon">--</span>
        <span class="pizzint-score">--%</span>
      </button>
      <div class="pizzint-panel hidden">
        <div class="pizzint-header">
          <span class="pizzint-title">Pentagon Pizza Index</span>
          <button class="pizzint-close">×</button>
        </div>
        <div class="pizzint-status-bar">
          <div class="pizzint-defcon-label"></div>
        </div>
        <div class="pizzint-locations"></div>
        <div class="pizzint-tensions">
          <div class="pizzint-tensions-title">Geopolitical Tensions</div>
          <div class="pizzint-tensions-list"></div>
        </div>
        <div class="pizzint-footer">
          <span class="pizzint-source">Source: <a href="https://pizzint.watch" target="_blank" rel="noopener">PizzINT</a></span>
          <span class="pizzint-updated"></span>
        </div>
      </div>
    `;

    this.injectStyles();
    this.setupEventListeners();
  }

  private injectStyles(): void {
    if (document.getElementById('pizzint-styles')) return;
    const style = document.createElement('style');
    style.id = 'pizzint-styles';
    style.textContent = `
      .pizzint-indicator {
        position: relative;
        z-index: 1000;
        font-family: 'JetBrains Mono', monospace;
      }
      .pizzint-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .pizzint-toggle:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.4);
      }
      .pizzint-icon { font-size: 14px; }
      .pizzint-defcon {
        font-size: 10px;
        font-weight: bold;
        padding: 2px 5px;
        border-radius: 3px;
        background: #444;
        color: #fff;
      }
      .pizzint-score {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.7);
      }
      .pizzint-panel {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 8px;
        width: 320px;
        background: rgba(0, 0, 0, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      }
      .pizzint-panel.hidden { display: none; }
      .pizzint-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .pizzint-title {
        font-size: 14px;
        font-weight: bold;
        color: #fff;
      }
      .pizzint-close {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .pizzint-close:hover { color: #fff; }
      .pizzint-status-bar {
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.05);
      }
      .pizzint-defcon-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: rgba(255, 255, 255, 0.9);
        text-align: center;
      }
      .pizzint-locations {
        padding: 8px 16px;
        max-height: 180px;
        overflow-y: auto;
      }
      .pizzint-location {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        font-size: 11px;
      }
      .pizzint-location:last-child { border-bottom: none; }
      .pizzint-location-name {
        color: rgba(255, 255, 255, 0.8);
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-right: 8px;
      }
      .pizzint-location-status {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: bold;
        text-transform: uppercase;
      }
      .pizzint-location-status.spike { background: #ff0040; color: #fff; }
      .pizzint-location-status.high { background: #ff4400; color: #fff; }
      .pizzint-location-status.elevated { background: #ffaa00; color: #000; }
      .pizzint-location-status.nominal { background: #00aaff; color: #fff; }
      .pizzint-location-status.quiet { background: #00ff88; color: #000; }
      .pizzint-location-status.closed { background: #444; color: #888; }
      .pizzint-tensions {
        padding: 12px 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      }
      .pizzint-tensions-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: rgba(255, 255, 255, 0.5);
        margin-bottom: 8px;
      }
      .pizzint-tension-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 0;
        font-size: 11px;
      }
      .pizzint-tension-label { color: rgba(255, 255, 255, 0.8); }
      .pizzint-tension-score {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pizzint-tension-value { color: #fff; font-weight: bold; }
      .pizzint-tension-trend { font-size: 10px; }
      .pizzint-tension-trend.rising { color: #ff4400; }
      .pizzint-tension-trend.falling { color: #00ff88; }
      .pizzint-tension-trend.stable { color: #888; }
      .pizzint-footer {
        display: flex;
        justify-content: space-between;
        padding: 8px 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
      }
      .pizzint-footer a {
        color: rgba(255, 255, 255, 0.6);
        text-decoration: none;
      }
      .pizzint-footer a:hover { color: #fff; }
    `;
    document.head.appendChild(style);
  }

  private setupEventListeners(): void {
    const toggle = this.element.querySelector('.pizzint-toggle')!;
    const panel = this.element.querySelector('.pizzint-panel')!;
    const closeBtn = this.element.querySelector('.pizzint-close')!;

    toggle.addEventListener('click', () => {
      this.isExpanded = !this.isExpanded;
      panel.classList.toggle('hidden', !this.isExpanded);
    });

    closeBtn.addEventListener('click', () => {
      this.isExpanded = false;
      panel.classList.add('hidden');
    });
  }

  public updateStatus(status: PizzIntStatus): void {
    this.status = status;
    this.render();
  }

  public updateTensions(tensions: GdeltTensionPair[]): void {
    this.tensions = tensions;
    this.renderTensions();
  }

  private render(): void {
    if (!this.status) return;

    const defconEl = this.element.querySelector('.pizzint-defcon') as HTMLElement;
    const scoreEl = this.element.querySelector('.pizzint-score') as HTMLElement;
    const labelEl = this.element.querySelector('.pizzint-defcon-label') as HTMLElement;
    const locationsEl = this.element.querySelector('.pizzint-locations') as HTMLElement;
    const updatedEl = this.element.querySelector('.pizzint-updated') as HTMLElement;

    const color = DEFCON_COLORS[this.status.defconLevel] || '#888';
    defconEl.textContent = `DEFCON ${this.status.defconLevel}`;
    defconEl.style.background = color;
    defconEl.style.color = this.status.defconLevel <= 3 ? '#000' : '#fff';

    scoreEl.textContent = `${this.status.aggregateActivity}%`;
    labelEl.textContent = this.status.defconLabel;
    labelEl.style.color = color;

    locationsEl.innerHTML = this.status.locations.map(loc => {
      const statusClass = this.getStatusClass(loc);
      const statusLabel = this.getStatusLabel(loc);
      return `
        <div class="pizzint-location">
          <span class="pizzint-location-name">${escapeHtml(loc.name)}</span>
          <span class="pizzint-location-status ${statusClass}">${statusLabel}</span>
        </div>
      `;
    }).join('');

    const timeAgo = this.formatTimeAgo(this.status.lastUpdate);
    updatedEl.textContent = `Updated ${timeAgo}`;
  }

  private renderTensions(): void {
    const listEl = this.element.querySelector('.pizzint-tensions-list') as HTMLElement;
    if (!listEl) return;

    listEl.innerHTML = this.tensions.map(t => {
      const trendIcon = t.trend === 'rising' ? '↑' : t.trend === 'falling' ? '↓' : '→';
      const changeText = t.changePercent > 0 ? `+${t.changePercent}%` : `${t.changePercent}%`;
      const trendClass = escapeHtml(t.trend);
      return `
        <div class="pizzint-tension-row">
          <span class="pizzint-tension-label">${escapeHtml(t.label)}</span>
          <span class="pizzint-tension-score">
            <span class="pizzint-tension-value">${t.score.toFixed(1)}</span>
            <span class="pizzint-tension-trend ${trendClass}">${trendIcon} ${changeText}</span>
          </span>
        </div>
      `;
    }).join('');
  }

  private getStatusClass(loc: { is_closed_now: boolean; is_spike: boolean; current_popularity: number }): string {
    if (loc.is_closed_now) return 'closed';
    if (loc.is_spike) return 'spike';
    if (loc.current_popularity >= 70) return 'high';
    if (loc.current_popularity >= 40) return 'elevated';
    if (loc.current_popularity >= 15) return 'nominal';
    return 'quiet';
  }

  private getStatusLabel(loc: { is_closed_now: boolean; is_spike: boolean; current_popularity: number }): string {
    if (loc.is_closed_now) return 'CLOSED';
    if (loc.is_spike) return `SPIKE ${loc.current_popularity}%`;
    if (loc.current_popularity >= 70) return `HIGH ${loc.current_popularity}%`;
    if (loc.current_popularity >= 40) return `ELEVATED ${loc.current_popularity}%`;
    if (loc.current_popularity >= 15) return `NOMINAL ${loc.current_popularity}%`;
    return `QUIET ${loc.current_popularity}%`;
  }

  private formatTimeAgo(date: Date): string {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public hide(): void {
    this.element.style.display = 'none';
  }

  public show(): void {
    this.element.style.display = '';
  }
}
