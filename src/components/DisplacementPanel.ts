import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { UnhcrSummary, CountryDisplacement } from '@/types';
import { formatPopulation } from '@/services/unhcr';
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
      infoTooltip: `<strong>UNHCR Displacement Data</strong>
        Global refugee, asylum seeker, and IDP counts from UNHCR.
        <ul>
          <li><strong>Origins</strong>: Countries people flee FROM</li>
          <li><strong>Hosts</strong>: Countries hosting refugees</li>
          <li>Crisis badges: >1M | High: >500K displaced</li>
        </ul>
        Data updates yearly. CC BY 4.0 license.`,
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
      <style>
        .disp-panel-content { font-size: 12px; }
        .disp-stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
        .disp-stat-box { background: var(--overlay-subtle); border: 1px solid var(--border); border-radius: 4px; padding: 8px 6px; text-align: center; }
        .disp-stat-value { display: block; font-size: 16px; font-weight: 700; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
        .disp-stat-label { display: block; font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
        .disp-stat-refugees .disp-stat-value { color: var(--threat-critical); }
        .disp-stat-asylum .disp-stat-value { color: var(--threat-high); }
        .disp-stat-idps .disp-stat-value { color: var(--threat-medium); }
        .disp-stat-total .disp-stat-value { color: var(--accent); }
        .disp-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
        .disp-tab { background: transparent; border: 1px solid var(--border-strong); color: var(--text-dim); padding: 4px 14px; font-size: 11px; cursor: pointer; border-radius: 3px; transition: all 0.15s; }
        .disp-tab:hover { border-color: var(--text-faint); color: var(--text-secondary); }
        .disp-tab-active { background: color-mix(in srgb, var(--threat-critical) 10%, transparent); border-color: var(--threat-critical); color: var(--threat-critical); }
        .disp-table { width: 100%; border-collapse: collapse; }
        .disp-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: 10px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
        .disp-table th:nth-child(3) { text-align: right; }
        .disp-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
        .disp-row { cursor: pointer; }
        .disp-row:hover { background: var(--surface-hover); }
        .disp-name { white-space: nowrap; }
        .disp-status { width: 70px; }
        .disp-badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 3px; letter-spacing: 0.5px; }
        .disp-crisis { background: color-mix(in srgb, var(--semantic-critical) 20%, transparent); color: var(--semantic-critical); }
        .disp-high { background: color-mix(in srgb, var(--semantic-high) 15%, transparent); color: var(--semantic-high); }
        .disp-elevated { background: color-mix(in srgb, var(--semantic-elevated) 12%, transparent); color: var(--semantic-elevated); }
        .disp-count { text-align: right; font-variant-numeric: tabular-nums; }
      </style>
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
