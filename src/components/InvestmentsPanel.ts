import { Panel } from './Panel';
import { GULF_INVESTMENTS } from '@/config/gulf-fdi';
import type {
  GulfInvestment,
  GulfInvestmentSector,
  GulfInvestorCountry,
  GulfInvestingEntity,
  GulfInvestmentStatus,
} from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

interface InvestmentFilters {
  investingCountry: GulfInvestorCountry | 'ALL';
  sector: GulfInvestmentSector | 'ALL';
  entity: GulfInvestingEntity | 'ALL';
  status: GulfInvestmentStatus | 'ALL';
  search: string;
}

function getSectorLabel(sector: GulfInvestmentSector): string {
  const labels: Record<GulfInvestmentSector, string> = {
    ports: t('components.investments.sectors.ports'),
    pipelines: t('components.investments.sectors.pipelines'),
    energy: t('components.investments.sectors.energy'),
    datacenters: t('components.investments.sectors.datacenters'),
    airports: t('components.investments.sectors.airports'),
    railways: t('components.investments.sectors.railways'),
    telecoms: t('components.investments.sectors.telecoms'),
    water: t('components.investments.sectors.water'),
    logistics: t('components.investments.sectors.logistics'),
    mining: t('components.investments.sectors.mining'),
    'real-estate': t('components.investments.sectors.realEstate'),
    manufacturing: t('components.investments.sectors.manufacturing'),
  };
  return labels[sector] || sector;
}

const STATUS_COLORS: Record<GulfInvestmentStatus, string> = {
  'operational':         '#22c55e',
  'under-construction':  '#f59e0b',
  'announced':           '#60a5fa',
  'rumoured':            '#a78bfa',
  'cancelled':           '#ef4444',
  'divested':            '#6b7280',
};

const FLAG: Record<string, string> = {
  SA:  '🇸🇦',
  UAE: '🇦🇪',
};

function formatUSD(usd?: number): string {
  if (usd === undefined) return t('components.investments.undisclosed');
  if (usd >= 100000) return `$${(usd / 1000).toFixed(0)}B`;
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}B`;
  return `$${usd.toLocaleString()}M`;
}

export class InvestmentsPanel extends Panel {
  private filters: InvestmentFilters = {
    investingCountry: 'ALL',
    sector: 'ALL',
    entity: 'ALL',
    status: 'ALL',
    search: '',
  };
  private sortKey: keyof GulfInvestment = 'assetName';
  private sortAsc = true;
  private filtersExpanded = false;
  private onInvestmentClick?: (inv: GulfInvestment) => void;

  constructor(onInvestmentClick?: (inv: GulfInvestment) => void) {
    super({
      id: 'gcc-investments',
      title: t('panels.gccInvestments'),
      showCount: true,
      infoTooltip: t('components.investments.infoTooltip'),
    });
    this.onInvestmentClick = onInvestmentClick;
    this.setupEventDelegation();
    this.render();
  }

  private getFiltered(): GulfInvestment[] {
    const { investingCountry, sector, entity, status, search } = this.filters;
    const q = search.toLowerCase();

    return GULF_INVESTMENTS
      .filter(inv => {
        if (investingCountry !== 'ALL' && inv.investingCountry !== investingCountry) return false;
        if (sector !== 'ALL' && inv.sector !== sector) return false;
        if (entity !== 'ALL' && inv.investingEntity !== entity) return false;
        if (status !== 'ALL' && inv.status !== status) return false;
        if (q && !inv.assetName.toLowerCase().includes(q)
               && !inv.targetCountry.toLowerCase().includes(q)
               && !inv.description.toLowerCase().includes(q)
               && !inv.investingEntity.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const key = this.sortKey;
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.sortAsc ? cmp : -cmp;
      });
  }

  private render(): void {
    const filtered = this.getFiltered();

    const entities = Array.from(new Set(GULF_INVESTMENTS.map(i => i.investingEntity))).sort();
    const sectors = Array.from(new Set(GULF_INVESTMENTS.map(i => i.sector))).sort();

    const sortCls = (key: keyof GulfInvestment) =>
      this.sortKey === key ? 'fdi-sort fdi-sort-active' : 'fdi-sort';
    const sortLabel = (key: keyof GulfInvestment, label: string) =>
      this.sortKey === key ? `${label} ${this.sortAsc ? '↑' : '↓'}` : label;

    const hasActiveFilter = this.filters.investingCountry !== 'ALL'
      || this.filters.sector !== 'ALL'
      || this.filters.entity !== 'ALL'
      || this.filters.status !== 'ALL';

    const rows = filtered.map(inv => {
      const statusColor = STATUS_COLORS[inv.status] || '#6b7280';
      const flag = FLAG[inv.investingCountry] || '';
      const sectorLabel = getSectorLabel(inv.sector);
      const year = inv.yearAnnounced ?? inv.yearOperational ?? '—';
      return `
        <div class="fdi-row" data-id="${escapeHtml(inv.id)}">
          <div class="fdi-row-line1">
            <span class="fdi-flag">${flag}</span>
            <span class="fdi-asset-name">${escapeHtml(inv.assetName)}</span>
            <span class="fdi-entity-sub">${escapeHtml(inv.investingEntity)}</span>
            <span class="fdi-usd">${escapeHtml(formatUSD(inv.investmentUSD))}</span>
          </div>
          <div class="fdi-row-line2">
            <span class="fdi-country">${escapeHtml(inv.targetCountry)}</span>
            <span class="fdi-sector-badge">${escapeHtml(sectorLabel)}</span>
            <span class="fdi-status-label"><span class="fdi-status-dot" style="background:${statusColor}"></span>${escapeHtml(inv.status)}</span>
            <span class="fdi-year">${year}</span>
          </div>
        </div>`;
    }).join('');

    const toggleCls = this.filtersExpanded || hasActiveFilter ? 'fdi-filter-toggle fdi-filters-active' : 'fdi-filter-toggle';
    const filtersCls = this.filtersExpanded ? 'fdi-filters fdi-filters-open' : 'fdi-filters';

    const sel = (f: string) => this.filters.status === f ? ' selected' : '';
    const html = `
      <div class="fdi-search-row">
        <input class="fdi-search" type="text"
          placeholder="${t('components.investments.searchPlaceholder')}"
          value="${escapeHtml(this.filters.search)}"/>
        <button class="${toggleCls}" data-action="toggle-filters" title="Filters">⚙</button>
      </div>
      <div class="${filtersCls}">
        <select class="fdi-filter" data-filter="investingCountry">
          <option value="ALL">🌐 ${t('components.investments.allCountries')}</option>
          <option value="SA"${this.filters.investingCountry === 'SA' ? ' selected' : ''}>🇸🇦 ${t('components.investments.saudiArabia')}</option>
          <option value="UAE"${this.filters.investingCountry === 'UAE' ? ' selected' : ''}>🇦🇪 ${t('components.investments.uae')}</option>
        </select>
        <select class="fdi-filter" data-filter="sector">
          <option value="ALL">${t('components.investments.allSectors')}</option>
          ${sectors.map(s => `<option value="${s}"${this.filters.sector === s ? ' selected' : ''}>${escapeHtml(getSectorLabel(s as GulfInvestmentSector))}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="entity">
          <option value="ALL">${t('components.investments.allEntities')}</option>
          ${entities.map(e => `<option value="${escapeHtml(e)}"${this.filters.entity === e ? ' selected' : ''}>${escapeHtml(e)}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="status">
          <option value="ALL">${t('components.investments.allStatuses')}</option>
          <option value="operational"${sel('operational')}>${t('components.investments.operational')}</option>
          <option value="under-construction"${sel('under-construction')}>${t('components.investments.underConstruction')}</option>
          <option value="announced"${sel('announced')}>${t('components.investments.announced')}</option>
          <option value="rumoured"${sel('rumoured')}>${t('components.investments.rumoured')}</option>
          <option value="divested"${sel('divested')}>${t('components.investments.divested')}</option>
        </select>
        <div class="fdi-sort-pills">
          <button class="${sortCls('assetName')}" data-sort="assetName">${sortLabel('assetName', t('components.investments.asset'))}</button>
          <button class="${sortCls('investmentUSD')}" data-sort="investmentUSD">${sortLabel('investmentUSD', t('components.investments.investment'))}</button>
          <button class="${sortCls('targetCountry')}" data-sort="targetCountry">${sortLabel('targetCountry', t('components.investments.country'))}</button>
          <button class="${sortCls('yearAnnounced')}" data-sort="yearAnnounced">${sortLabel('yearAnnounced', t('components.investments.year'))}</button>
        </div>
      </div>
      <div class="fdi-list">
        ${rows || `<div class="fdi-empty">${t('components.investments.noMatch')}</div>`}
      </div>`;

    this.setContent(html);
    if (this.countEl) this.countEl.textContent = String(filtered.length);
  }

  private setupEventDelegation(): void {
    this.content.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('fdi-search')) {
        this.filters.search = (target as HTMLInputElement).value;
        this.render();
      }
    });

    this.content.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest('.fdi-filter') as HTMLSelectElement | null;
      if (sel) {
        const key = sel.dataset.filter as keyof InvestmentFilters;
        (this.filters as unknown as Record<string, string>)[key] = sel.value;
        this.render();
      }
    });

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const toggleBtn = target.closest('[data-action="toggle-filters"]') as HTMLElement | null;
      if (toggleBtn) {
        this.filtersExpanded = !this.filtersExpanded;
        this.render();
        return;
      }

      const sortBtn = target.closest('.fdi-sort') as HTMLElement | null;
      if (sortBtn) {
        const key = sortBtn.dataset.sort as keyof GulfInvestment;
        if (this.sortKey === key) {
          this.sortAsc = !this.sortAsc;
        } else {
          this.sortKey = key;
          this.sortAsc = true;
        }
        this.render();
        return;
      }

      const row = target.closest('.fdi-row') as HTMLElement | null;
      if (row) {
        const inv = GULF_INVESTMENTS.find(i => i.id === row.dataset.id);
        if (inv && this.onInvestmentClick) {
          this.onInvestmentClick(inv);
        }
      }
    });
  }
}
