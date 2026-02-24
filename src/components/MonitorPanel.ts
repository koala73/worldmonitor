import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { Monitor, NewsItem } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { generateId, formatTime, getCSSColor } from '@/utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren, clearChildren } from '@/utils/dom-utils';

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;

  constructor(initialMonitors: Monitor[] = []) {
    super({ id: 'monitors', title: t('panels.monitors') });
    this.monitors = initialMonitors;
    this.renderInput();
  }

  private renderInput(): void {
    clearChildren(this.content);

    const input = h('input', {
      type: 'text',
      className: 'monitor-input',
      id: 'monitorKeywords',
      placeholder: t('components.monitor.placeholder'),
      onKeypress: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') this.addMonitor(); },
    });

    const inputContainer = h('div', { className: 'monitor-input-container' },
      input,
      h('button', { className: 'monitor-add-btn', id: 'addMonitorBtn', onClick: () => this.addMonitor() },
        t('components.monitor.add'),
      ),
    );

    const monitorsList = h('div', { id: 'monitorsList' });
    const monitorsResults = h('div', { id: 'monitorsResults' });

    this.content.appendChild(inputContainer);
    this.content.appendChild(monitorsList);
    this.content.appendChild(monitorsResults);

    this.renderMonitorsList();
  }

  private addMonitor(): void {
    const input = document.getElementById('monitorKeywords') as HTMLInputElement;
    const keywords = input.value.trim();

    if (!keywords) return;

    const monitor: Monitor = {
      id: generateId(),
      keywords: keywords.split(',').map((k) => k.trim().toLowerCase()),
      color: MONITOR_COLORS[this.monitors.length % MONITOR_COLORS.length] ?? getCSSColor('--status-live'),
    };

    this.monitors.push(monitor);
    input.value = '';
    this.renderMonitorsList();
    this.onMonitorsChange?.(this.monitors);
  }

  public removeMonitor(id: string): void {
    this.monitors = this.monitors.filter((m) => m.id !== id);
    this.renderMonitorsList();
    this.onMonitorsChange?.(this.monitors);
  }

  private renderMonitorsList(): void {
    const list = document.getElementById('monitorsList');
    if (!list) return;

    replaceChildren(list,
      ...this.monitors.map((m) =>
        h('span', { className: 'monitor-tag' },
          h('span', { className: 'monitor-tag-color', style: { background: m.color } }),
          m.keywords.join(', '),
          h('span', {
            className: 'monitor-tag-remove',
            onClick: () => this.removeMonitor(m.id),
          }, '×'),
        ),
      ),
    );
  }

  public renderResults(news: NewsItem[]): void {
    const results = document.getElementById('monitorsResults');
    if (!results) return;

    if (this.monitors.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          t('components.monitor.addKeywords'),
        ),
      );
      return;
    }

    const matchedItems: NewsItem[] = [];

    news.forEach((item) => {
      this.monitors.forEach((monitor) => {
        // Search both title and description for better coverage
        const searchText = `${item.title} ${(item as unknown as { description?: string }).description || ''}`.toLowerCase();
        const matched = monitor.keywords.some((kw) => {
          // Use word boundary matching to avoid false positives like "ai" in "train"
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          return regex.test(searchText);
        });
        if (matched) {
          matchedItems.push({ ...item, monitorColor: monitor.color });
        }
      });
    });

    // Dedupe by link
    const seen = new Set<string>();
    const unique = matchedItems.filter(item => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });

    if (unique.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          t('components.monitor.noMatches', { count: String(news.length) }),
        ),
      );
      return;
    }

    const countText = unique.length > 10
      ? t('components.monitor.showingMatches', { count: '10', total: String(unique.length) })
      : `${unique.length} ${unique.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;

    replaceChildren(results,
      h('div', { style: 'color: var(--text-dim); font-size: 10px; margin: 12px 0 8px;' }, countText),
      ...unique.slice(0, 10).map((item) =>
        h('div', {
          className: 'item',
          style: `border-left: 2px solid ${item.monitorColor || ''}; padding-left: 8px; margin-left: -8px;`,
        },
          h('div', { className: 'item-source' }, item.source),
          h('a', {
            className: 'item-title',
            href: sanitizeUrl(item.link),
            target: '_blank',
            rel: 'noopener',
          }, item.title),
          h('div', { className: 'item-time' }, formatTime(item.pubDate)),
        ),
      ),
    );
  }

  public onChanged(callback: (monitors: Monitor[]) => void): void {
    this.onMonitorsChange = callback;
  }

  public getMonitors(): Monitor[] {
    return [...this.monitors];
  }

  public setMonitors(monitors: Monitor[]): void {
    this.monitors = monitors;
    this.renderMonitorsList();
  }
}
