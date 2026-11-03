import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { Monitor, NewsItem } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { generateId, formatTime, getCSSColor } from '@/utils';
import { validateUrl } from '@/utils/sanitize';
import { h, replaceChildren } from '@/utils/dom-utils';

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;
  private readonly input = h('input', {
    type: 'text',
    className: 'monitor-input',
    id: 'monitorKeywords',
    placeholder: t('components.monitor.placeholder'),
    onKeypress: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') this.addMonitor(); },
  }) as HTMLInputElement;
  private readonly monitorsList = h('div', { id: 'monitorsList' });
  private readonly monitorsResults = h('div', { id: 'monitorsResults' });

  constructor(initialMonitors: Monitor[] = []) {
    super({ id: 'monitors', title: t('panels.monitors'), infoTooltip: t('components.monitors.infoTooltip') });
    this.monitors = initialMonitors;
    this.renderInput();
  }

  private renderInput(): void {
    const inputContainer = h('div', { className: 'monitor-input-container' },
      this.input,
      h('button', { className: 'monitor-add-btn', id: 'addMonitorBtn', onClick: () => this.addMonitor() },
        t('components.monitor.add'),
      ),
    );

    // Route through the sanctioned helper (#6557): the monitor UI is the
    // panel's authoritative content — atomic replace with error-state clear.
    this.setContentNodes(inputContainer, this.monitorsList, this.monitorsResults);

    this.renderMonitorsList();
  }

  private addMonitor(): void {
    const input = this.input;
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
    replaceChildren(this.monitorsList,
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
    const results = this.monitorsResults;

    if (this.monitors.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color: var(--text-dim); font-size: calc(10px * var(--wm-panel-effective-scale, 1)); margin-top: 12px;' },
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
        h('div', { style: 'color: var(--text-dim); font-size: calc(10px * var(--wm-panel-effective-scale, 1)); margin-top: 12px;' },
          t('components.monitor.noMatches', { count: String(news.length) }),
        ),
      );
      return;
    }

    const countText = unique.length > 10
      ? t('components.monitor.showingMatches', { count: '10', total: String(unique.length) })
      : `${unique.length} ${unique.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;

    replaceChildren(results,
      h('div', { style: 'color: var(--text-dim); font-size: calc(10px * var(--wm-panel-effective-scale, 1)); margin: 12px 0 8px;' }, countText),
      ...unique.slice(0, 10).map((item) =>
        h('div', {
          className: 'item',
          style: `border-left: 2px solid ${item.monitorColor || ''}; padding-left: 8px; margin-left: -8px;`,
        },
          h('div', { className: 'item-source' }, item.source),
          h('a', {
            className: 'item-title',
            href: validateUrl(item.link),
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
