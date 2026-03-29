import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getApiBaseUrl } from '@/services/runtime';

interface GdeltEvent {
  title: string;
  url: string;
  source: string;
  tone: number;
  country: string;
  timestamp: number;
}

interface GdeltIntelResponse {
  events: GdeltEvent[];
  updatedAt: number;
}

const COUNTRY_FLAGS: Record<string, string> = {
  'United States': '🇺🇸',
  'Russia': '🇷🇺',
  'China': '🇨🇳',
};

function toneBadge(tone: number): string {
  if (tone < -5) return '<span class="gdelt-badge gdelt-badge--alarming">Alarming</span>';
  if (tone <= -2) return '<span class="gdelt-badge gdelt-badge--tense">Tense</span>';
  return '<span class="gdelt-badge gdelt-badge--neutral">Neutral</span>';
}

function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class GdeltIntelPanel extends Panel {
  private data: GdeltIntelResponse | null = null;
  private loading = true;
  private error: string | null = null;

  constructor() {
    super({
      id: 'gdelt-intel',
      title: 'Live Intelligence',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Global news intelligence from GDELT — 65 languages, 100+ countries, updated every 15 minutes. Sorted by tone severity. Fully open, no API key required.',
    });
    void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    this.loading = true;
    this.showLoading();

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/gdelt-intel`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as GdeltIntelResponse;
      this.data = json;
      this.error = null;
    } catch (error) {
      if (this.isAbortError(error)) return;
      this.error = error instanceof Error ? error.message : 'Failed to fetch';
    }

    this.loading = false;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading();
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error ?? 'No data');
      return;
    }

    const events = this.data.events.slice(0, 20);
    this.setCount(events.length);

    if (events.length === 0) {
      this.setContent('<div class="panel-loading-text">No events available.</div>');
      return;
    }

    const items = events.map(ev => {
      const flag = COUNTRY_FLAGS[ev.country] ?? '';
      const safeHref = sanitizeUrl(ev.url);
      const linkAttr = safeHref ? `href="${safeHref}" target="_blank" rel="noopener noreferrer"` : '';
      const titleEl = safeHref
        ? `<a class="gdelt-title" ${linkAttr}>${escapeHtml(ev.title)}</a>`
        : `<span class="gdelt-title">${escapeHtml(ev.title)}</span>`;

      return `
        <div class="gdelt-item">
          <div class="gdelt-item-header">
            ${titleEl}
          </div>
          <div class="gdelt-item-meta">
            <span class="gdelt-source">${escapeHtml(ev.source)}</span>
            ${flag ? `<span class="gdelt-flag">${flag}</span>` : ''}
            ${toneBadge(ev.tone)}
            <span class="gdelt-time">${relativeTime(ev.timestamp)}</span>
          </div>
        </div>
      `;
    }).join('');

    this.setContent(`<div class="gdelt-list">${items}</div>`);
  }
}
