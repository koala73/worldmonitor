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
  private onInvestmentClick?: (inv: GulfInvestment) => void;

  constructor(onInvestmentClick?: (inv: GulfInvestment) => void) {
    super({
      id: 'gcc-investments',
      title: t('panels.gccInvestments'),
      showCount: true,
      infoTooltip: t('components.investments.infoTooltip'),
    });
    this.onInvestmentClick = onInvestmentClick;
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

    // Build unique entity list for dropdown
    const entities = Array.from(new Set(GULF_INVESTMENTS.map(i => i.investingEntity))).sort();
    const sectors = Array.from(new Set(GULF_INVESTMENTS.map(i => i.sector))).sort();

    const sortArrow = (key: keyof GulfInvestment) =>
      this.sortKey === key ? (this.sortAsc ? ' ↑' : ' ↓') : '';

    const rows = filtered.map(inv => {
      const statusColor = STATUS_COLORS[inv.status] || '#6b7280';
      const flag = FLAG[inv.investingCountry] || '';
      const sector = getSectorLabel(inv.sector);
      return `
        <tr class="fdi-row" data-id="${escapeHtml(inv.id)}" style="cursor:pointer">
          <td class="fdi-asset">
            <span class="fdi-flag">${flag}</span>
            <strong>${escapeHtml(inv.assetName)}</strong>
            <div class="fdi-entity-sub">${escapeHtml(inv.investingEntity)}</div>
          </td>
          <td>${escapeHtml(inv.targetCountry)}</td>
          <td><span class="fdi-sector-badge">${escapeHtml(sector)}</span></td>
          <td><span class="fdi-status-dot" style="background:${statusColor}"></span>${escapeHtml(inv.status)}</td>
          <td class="fdi-usd">${escapeHtml(formatUSD(inv.investmentUSD))}</td>
          <td>${inv.yearAnnounced ?? inv.yearOperational ?? '—'}</td>
        </tr>`;
    }).join('');

    const html = `
      <div class="fdi-toolbar">
        <input
          class="fdi-search"
          type="text"
          placeholder="${t('components.investments.searchPlaceholder')}"
          value="${escapeHtml(this.filters.search)}"
        />
        <select class="fdi-filter" data-filter="investingCountry">
          <option value="ALL">🌐 ${t('components.investments.allCountries')}</option>
          <option value="SA" ${this.filters.investingCountry === 'SA' ? 'selected' : ''}>🇸🇦 ${t('components.investments.saudiArabia')}</option>
          <option value="UAE" ${this.filters.investingCountry === 'UAE' ? 'selected' : ''}>🇦🇪 ${t('components.investments.uae')}</option>
        </select>
        <select class="fdi-filter" data-filter="sector">
          <option value="ALL">${t('components.investments.allSectors')}</option>
          ${sectors.map(s => `<option value="${s}" ${this.filters.sector === s ? 'selected' : ''}>${escapeHtml(getSectorLabel(s as GulfInvestmentSector))}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="entity">
          <option value="ALL">${t('components.investments.allEntities')}</option>
          ${entities.map(e => `<option value="${escapeHtml(e)}" ${this.filters.entity === e ? 'selected' : ''}>${escapeHtml(e)}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="status">
          <option value="ALL">${t('components.investments.allStatuses')}</option>
          <option value="operational" ${this.filters.status === 'operational' ? 'selected' : ''}>${t('components.investments.operational')}</option>
          <option value="under-construction" ${this.filters.status === 'under-construction' ? 'selected' : ''}>${t('components.investments.underConstruction')}</option>
          <option value="announced" ${this.filters.status === 'announced' ? 'selected' : ''}>${t('components.investments.announced')}</option>
          <option value="rumoured" ${this.filters.status === 'rumoured' ? 'selected' : ''}>${t('components.investments.rumoured')}</option>
          <option value="divested" ${this.filters.status === 'divested' ? 'selected' : ''}>${t('components.investments.divested')}</option>
        </select>
      </div>
      <div class="fdi-table-wrap">
        <table class="fdi-table">
          <thead>
            <tr>
              <th class="fdi-sort" data-sort="assetName">${t('components.investments.asset')}${sortArrow('assetName')}</th>
              <th class="fdi-sort" data-sort="targetCountry">${t('components.investments.country')}${sortArrow('targetCountry')}</th>
              <th class="fdi-sort" data-sort="sector">${t('components.investments.sector')}${sortArrow('sector')}</th>
              <th class="fdi-sort" data-sort="status">${t('components.investments.status')}${sortArrow('status')}</th>
              <th class="fdi-sort" data-sort="investmentUSD">${t('components.investments.investment')}${sortArrow('investmentUSD')}</th>
              <th class="fdi-sort" data-sort="yearAnnounced">${t('components.investments.year')}${sortArrow('yearAnnounced')}</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="6" class="fdi-empty">${t('components.investments.noMatch')}</td></tr>`}</tbody>
        </table>
      </div>`;

    this.setContent(html);
    if (this.countEl) this.countEl.textContent = String(filtered.length);

    this.attachListeners();
  }

  private attachListeners(): void {
    const content = this.content;

    // Search input
    const searchEl = content.querySelector<HTMLInputElement>('.fdi-search');
    searchEl?.addEventListener('input', () => {
      this.filters.search = searchEl.value;
      this.render();
    });

    // Filter dropdowns
    content.querySelectorAll<HTMLSelectElement>('.fdi-filter').forEach(sel => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.filter as keyof InvestmentFilters;
        (this.filters as unknown as Record<string, string>)[key] = sel.value;
        this.render();
      });
    });

    // Sort headers
    content.querySelectorAll<HTMLElement>('.fdi-sort').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort as keyof GulfInvestment;
        if (this.sortKey === key) {
          this.sortAsc = !this.sortAsc;
        } else {
          this.sortKey = key;
          this.sortAsc = true;
        }
        this.render();
      });
    });

    // Row click → fly to map
    content.querySelectorAll<HTMLElement>('.fdi-row').forEach(row => {
      row.addEventListener('click', () => {
        const inv = GULF_INVESTMENTS.find(i => i.id === row.dataset.id);
        if (inv && this.onInvestmentClick) {
          this.onInvestmentClick(inv);
        }
      });
    });
  }
}
