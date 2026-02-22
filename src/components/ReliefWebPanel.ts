import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import type { ReliefWebReport, ReliefWebResponse } from '@/services/reliefweb';

const DISASTER_COLORS: Record<string, string> = {
  'Flood': '#0064ff',
  'Flash Flood': '#0064ff',
  'Earthquake': '#b45000',
  'Tropical Cyclone': '#6400c8',
  'Storm Surge': '#6400c8',
  'Cold Wave': '#4090c0',
  'Heat Wave': '#c89600',
  'Drought': '#c89600',
  'Epidemic': '#00b4a0',
  'Conflict': '#dc1414',
  'Fire': '#ff6600',
  'Volcano': '#8b0000',
  'Landslide': '#8b6914',
  'Tsunami': '#0040a0',
};

function getDisasterColor(type: string): string {
  if (!type) return '#00b4a0';
  for (const [key, color] of Object.entries(DISASTER_COLORS)) {
    if (type.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#00b4a0'; // teal default
}

export class ReliefWebPanel extends Panel {
  private data: ReliefWebResponse | null = null;
  private searchTerm = '';

  constructor() {
    super({
      id: 'reliefweb',
      title: t('components.reliefweb.title'),
      showCount: true,
      infoTooltip: t('components.reliefweb.infoTooltip'),
    });
  }

  public setData(data: ReliefWebResponse): void {
    this.data = data;

    if (!this.data.generatedAt) {
      this.showError(t('components.reliefweb.unavailable'));
      this.setDataBadge('unavailable');
      return;
    }

    this.setCount(this.data.reports.length);
    this.setDataBadge('live', new Date(this.data.generatedAt).toLocaleTimeString());
    this.render();
  }

  private render(): void {
    if (!this.data) return;

    let reports = this.data.reports;

    if (this.searchTerm) {
      const s = this.searchTerm.toLowerCase();
      reports = reports.filter(r =>
        r.title.toLowerCase().includes(s) ||
        r.country.toLowerCase().includes(s) ||
        r.disasterType.toLowerCase().includes(s) ||
        r.source.toLowerCase().includes(s)
      );
    }

    const html = `
      <div class="reliefweb-search">
        <input type="text" class="reliefweb-search-input" placeholder="${escapeHtml(t('components.reliefweb.searchPlaceholder'))}" value="${escapeHtml(this.searchTerm)}" />
      </div>
      <div class="reliefweb-list">
        ${reports.length === 0 ? `<div class="empty-state">${escapeHtml(t('components.reliefweb.noResults'))}</div>` : ''}
        ${reports.map(r => this.renderReport(r)).join('')}
      </div>
    `;

    this.setContent(html);
    this.bindEvents();
  }

  private renderReport(report: ReliefWebReport): string {
    const color = getDisasterColor(report.disasterType);
    const dateStr = report.date ? new Date(report.date).toLocaleDateString() : '';

    return `
      <a class="reliefweb-report" href="${escapeHtml(report.url)}" target="_blank" rel="noopener noreferrer">
        <span class="reliefweb-report-dot" style="background:${color}"></span>
        <div class="reliefweb-report-info">
          <div class="reliefweb-report-title">${escapeHtml(report.title)}</div>
          <div class="reliefweb-report-meta">
            <span class="reliefweb-report-country">${escapeHtml(report.country)}</span>
            ${report.disasterType ? `<span class="reliefweb-report-type" style="color:${color}">${escapeHtml(report.disasterType)}</span>` : ''}
            <span class="reliefweb-report-date">${escapeHtml(dateStr)}</span>
          </div>
        </div>
      </a>
    `;
  }

  private bindEvents(): void {
    const searchInput = this.content.querySelector<HTMLInputElement>('.reliefweb-search-input');
    if (searchInput) {
      let debounceTimer: ReturnType<typeof setTimeout>;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.searchTerm = searchInput.value.trim();
          this.render();
        }, 300);
      });
    }
  }
}
