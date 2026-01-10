interface FeedStatus {
  name: string;
  lastUpdate: Date | null;
  status: 'ok' | 'warning' | 'error';
  itemCount: number;
  errorMessage?: string;
}

interface ApiStatus {
  name: string;
  status: 'ok' | 'warning' | 'error';
  latency?: number;
}

export class StatusPanel {
  private element: HTMLElement;
  private isOpen = false;
  private feeds: Map<string, FeedStatus> = new Map();
  private apis: Map<string, ApiStatus> = new Map();

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'status-panel-container';
    this.element.innerHTML = `
      <button class="status-panel-toggle" title="System Status">
        <span class="status-icon">◉</span>
      </button>
      <div class="status-panel hidden">
        <div class="status-panel-header">
          <span>System Health</span>
          <button class="status-panel-close">×</button>
        </div>
        <div class="status-panel-content">
          <div class="status-section">
            <div class="status-section-title">Data Feeds</div>
            <div class="feeds-list"></div>
          </div>
          <div class="status-section">
            <div class="status-section-title">API Status</div>
            <div class="apis-list"></div>
          </div>
          <div class="status-section">
            <div class="status-section-title">Storage</div>
            <div class="storage-info"></div>
          </div>
        </div>
        <div class="status-panel-footer">
          <span class="last-check">Updated just now</span>
        </div>
      </div>
    `;

    this.setupEventListeners();
    this.initDefaultStatuses();
  }

  private setupEventListeners(): void {
    const toggle = this.element.querySelector('.status-panel-toggle')!;
    const panel = this.element.querySelector('.status-panel')!;
    const closeBtn = this.element.querySelector('.status-panel-close')!;

    toggle.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      panel.classList.toggle('hidden', !this.isOpen);
      if (this.isOpen) this.updateDisplay();
    });

    closeBtn.addEventListener('click', () => {
      this.isOpen = false;
      panel.classList.add('hidden');
    });
  }

  private initDefaultStatuses(): void {
    // Names must match what App.ts sends: category.charAt(0).toUpperCase() + category.slice(1)
    const feedNames = [
      'Politics', 'Middleeast', 'Tech', 'Ai', 'Finance',
      'Gov', 'Intel', 'Layoffs', 'Congress', 'Thinktanks',
      'Polymarket', 'Weather', 'NetBlocks', 'Grid'
    ];
    feedNames.forEach(name => {
      this.feeds.set(name, { name, lastUpdate: null, status: 'warning', itemCount: 0 });
    });

    const apiNames = ['RSS2JSON', 'Alpha Vantage', 'CoinGecko', 'Polymarket', 'USGS', 'FRED'];
    apiNames.forEach(name => {
      this.apis.set(name, { name, status: 'warning' });
    });
  }

  public updateFeed(name: string, status: Partial<FeedStatus>): void {
    const existing = this.feeds.get(name) || { name, lastUpdate: null, status: 'ok' as const, itemCount: 0 };
    this.feeds.set(name, { ...existing, ...status, lastUpdate: new Date() });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  public updateApi(name: string, status: Partial<ApiStatus>): void {
    const existing = this.apis.get(name) || { name, status: 'ok' as const };
    this.apis.set(name, { ...existing, ...status });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  private updateStatusIcon(): void {
    const icon = this.element.querySelector('.status-icon')!;
    const hasError = [...this.feeds.values()].some(f => f.status === 'error') ||
                     [...this.apis.values()].some(a => a.status === 'error');
    const hasWarning = [...this.feeds.values()].some(f => f.status === 'warning') ||
                       [...this.apis.values()].some(a => a.status === 'warning');

    icon.className = 'status-icon';
    if (hasError) {
      icon.classList.add('error');
      icon.textContent = '◉';
    } else if (hasWarning) {
      icon.classList.add('warning');
      icon.textContent = '◉';
    } else {
      icon.classList.add('ok');
      icon.textContent = '◉';
    }
  }

  private updateDisplay(): void {
    const feedsList = this.element.querySelector('.feeds-list')!;
    const apisList = this.element.querySelector('.apis-list')!;
    const storageInfo = this.element.querySelector('.storage-info')!;
    const lastCheck = this.element.querySelector('.last-check')!;

    feedsList.innerHTML = [...this.feeds.values()].map(feed => `
      <div class="status-row">
        <span class="status-dot ${feed.status}"></span>
        <span class="status-name">${feed.name}</span>
        <span class="status-detail">${feed.itemCount} items</span>
        <span class="status-time">${feed.lastUpdate ? this.formatTime(feed.lastUpdate) : 'Never'}</span>
      </div>
    `).join('');

    apisList.innerHTML = [...this.apis.values()].map(api => `
      <div class="status-row">
        <span class="status-dot ${api.status}"></span>
        <span class="status-name">${api.name}</span>
        ${api.latency ? `<span class="status-detail">${api.latency}ms</span>` : ''}
      </div>
    `).join('');

    this.updateStorageInfo(storageInfo);
    lastCheck.textContent = `Updated ${this.formatTime(new Date())}`;
  }

  private async updateStorageInfo(container: Element): Promise<void> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(2) : '0';
        const quota = estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'N/A';
        container.innerHTML = `
          <div class="status-row">
            <span class="status-name">IndexedDB</span>
            <span class="status-detail">${used} MB / ${quota} MB</span>
          </div>
        `;
      } else {
        container.innerHTML = `<div class="status-row">Storage info unavailable</div>`;
      }
    } catch {
      container.innerHTML = `<div class="status-row">Storage info unavailable</div>`;
    }
  }

  private formatTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
