import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { UnhcrSummary, CountryDisplacement } from '@/services/displacement';
import { formatPopulation } from '@/services/displacement';
import { t } from '@/services/i18n';

type DisplacementTab = 'origins' | 'hosts';

export class DisplacementPanel extends Panel {
  private data: UnhcrSummary | null = null;
  private activeTab: DisplacementTab = 'origins';
  private onCountryClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'displacement',
      title: t('panels.displacement'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.displacement.infoTooltip'),
    });
    this.showLoading(t('common.loadingDisplacement'));
  }

  public setCountryClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onCountryClick = handler;
  }

  public setData(data: UnhcrSummary): void {
    this.data = data;
    this.setCount(data.countries.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (!this.data) return;

    const g = this.data.globalTotals;

    const stats = [
      { label: t('components.displacement.refugees'), value: formatPopulation(g.refugees), cls: 'disp-stat-refugees' },
      { label: t('components.displacement.asylumSeekers'), value: formatPopulation(g.asylumSeekers), cls: 'disp-stat-asylum' },
      { label: t('components.displacement.idps'), value: formatPopulation(g.idps), cls: 'disp-stat-idps' },
      { label: t('components.displacement.total'), value: formatPopulation(g.total), cls: 'disp-stat-total' },
    ];

    const statsHtml = stats.map(s =>
      `<div class="disp-stat-box ${s.cls}">
        <span class="disp-stat-value">${s.value}</span>
        <span class="disp-stat-label">${s.label}</span>
      </div>`
    ).join('');

    const tabsHtml = `
      <div class="disp-tabs">
        <button class="disp-tab ${this.activeTab === 'origins' ? 'disp-tab-active' : ''}" data-tab="origins">${t('components.displacement.origins')}</button>
        <button class="disp-tab ${this.activeTab === 'hosts' ? 'disp-tab-active' : ''}" data-tab="hosts">${t('components.displacement.hosts')}</button>
      </div>
    `;

    let countries: CountryDisplacement[];
    if (this.activeTab === 'origins') {
      countries = [...this.data.countries]
        .filter(c => c.refugees + c.asylumSeekers > 0)
        .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
    } else {
      countries = [...this.data.countries]
        .filter(c => (c.hostTotal || 0) > 0)
        .sort((a, b) => (b.hostTotal || 0) - (a.hostTotal || 0));
    }

    const displayed = countries.slice(0, 30);
    let tableHtml: string;

    if (displayed.length === 0) {
      tableHtml = `<div class="panel-empty">${t('common.noDataShort')}</div>`;
    } else {
      const rows = displayed.map(c => {
        const hostTotal = c.hostTotal || 0;
        const count = this.activeTab === 'origins' ? c.refugees + c.asylumSeekers : hostTotal;
        const total = this.activeTab === 'origins' ? c.totalDisplaced : hostTotal;
        const badgeCls = total >= 1_000_000 ? 'disp-crisis'
          : total >= 500_000 ? 'disp-high'
            : total >= 100_000 ? 'disp-elevated'
              : '';
        const badgeLabel = total >= 1_000_000 ? t('components.displacement.badges.crisis')
          : total >= 500_000 ? t('components.displacement.badges.high')
            : total >= 100_000 ? t('components.displacement.badges.elevated')
              : '';
        const badgeHtml = badgeLabel
          ? `<span class="disp-badge ${badgeCls}">${badgeLabel}</span>`
          : '';

        return `<tr class="disp-row" data-lat="${c.lat || ''}" data-lon="${c.lon || ''}">
          <td class="disp-name">${escapeHtml(c.name)}</td>
          <td class="disp-status">${badgeHtml}</td>
          <td class="disp-count">${formatPopulation(count)}</td>
        </tr>`;
      }).join('');

      tableHtml = `
        <table class="disp-table">
          <thead>
            <tr>
              <th>${t('components.displacement.country')}</th>
              <th>${t('components.displacement.status')}</th>
              <th>${t('components.displacement.count')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    this.setContent(`
      <div class="disp-panel-content">
        <div class="disp-stats-grid">${statsHtml}</div>
        ${tabsHtml}
        ${tableHtml}
      </div>
    `);

    this.content.querySelectorAll('.disp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as DisplacementTab;
        this.renderContent();
      });
    });

    this.content.querySelectorAll('.disp-row').forEach(el => {
      el.addEventListener('click', () => {
        const lat = Number((el as HTMLElement).dataset.lat);
        const lon = Number((el as HTMLElement).dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onCountryClick?.(lat, lon);
      });
    });
  }
}
