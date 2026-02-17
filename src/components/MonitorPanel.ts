import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { Monitor, NewsItem } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { generateId, formatTime, getCSSColor } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;

  constructor(initialMonitors: Monitor[] = []) {
    super({ id: 'monitors', title: t('panels.monitors') });
    this.monitors = initialMonitors;
    this.renderInput();
  }

  private renderInput(): void {
    this.content.innerHTML = '';
    const inputContainer = document.createElement('div');
    inputContainer.className = 'monitor-input-container';
    inputContainer.innerHTML = `
      <input type="text" class="monitor-input" id="monitorKeywords" placeholder="${t('components.monitor.placeholder')}">
      <button class="monitor-add-btn" id="addMonitorBtn">${t('components.monitor.add')}</button>
    `;

    this.content.appendChild(inputContainer);

    const monitorsList = document.createElement('div');
    monitorsList.id = 'monitorsList';
    this.content.appendChild(monitorsList);

    const monitorsResults = document.createElement('div');
    monitorsResults.id = 'monitorsResults';
    this.content.appendChild(monitorsResults);

    inputContainer.querySelector('#addMonitorBtn')?.addEventListener('click', () => {
      this.addMonitor();
    });

    const input = inputContainer.querySelector('#monitorKeywords') as HTMLInputElement;
    input?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.addMonitor();
    });

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

    list.innerHTML = this.monitors
      .map(
        (m) => `
      <span class="monitor-tag">
        <span class="monitor-tag-color" style="background: ${escapeHtml(m.color)}"></span>
        ${m.keywords.map(k => escapeHtml(k)).join(', ')}
        <span class="monitor-tag-remove" data-id="${escapeHtml(m.id)}">×</span>
      </span>
    `
      )
      .join('');

    list.querySelectorAll('.monitor-tag-remove').forEach((el) => {
      el.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this.removeMonitor(id);
      });
    });
  }

  public renderResults(news: NewsItem[]): void {
    const results = document.getElementById('monitorsResults');
    if (!results) return;

    if (this.monitors.length === 0) {
      results.innerHTML =
        `<div style="color: var(--text-dim); font-size: 10px; margin-top: 12px;">${t('components.monitor.addKeywords')}</div>`;
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
      results.innerHTML =
        `<div style="color: var(--text-dim); font-size: 10px; margin-top: 12px;">${t('components.monitor.noMatches', { count: String(news.length) })}</div>`;
      return;
    }

    const countText = unique.length > 10
      ? t('components.monitor.showingMatches', { count: '10', total: String(unique.length) })
      : `${unique.length} ${unique.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;

    results.innerHTML = `
      <div style="color: var(--text-dim); font-size: 10px; margin: 12px 0 8px;">${countText}</div>
      ${unique
        .slice(0, 10)
        .map(
          (item) => `
        <div class="item" style="border-left: 2px solid ${escapeHtml(item.monitorColor || '')}; padding-left: 8px; margin-left: -8px;">
          <div class="item-source">${escapeHtml(item.source)}</div>
          <a class="item-title" href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
          <div class="item-time">${formatTime(item.pubDate)}</div>
        </div>
      `
        )
        .join('')}`;
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
