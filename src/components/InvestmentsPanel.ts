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

const SECTOR_LABELS: Record<GulfInvestmentSector, string> = {
  ports: 'Ports',
  pipelines: 'Pipelines',
  energy: 'Energy',
  datacenters: 'Data Centers',
  airports: 'Airports',
  railways: 'Railways',
  telecoms: 'Telecoms',
  water: 'Water',
  logistics: 'Logistics',
  mining: 'Mining',
  'real-estate': 'Real Estate',
  manufacturing: 'Manufacturing',
};

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
  if (usd === undefined) return 'Undisclosed';
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
      infoTooltip: 'Database of Saudi Arabia and UAE foreign direct investments in global critical infrastructure. Click a row to fly to the investment on the map.',
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
      const sector = SECTOR_LABELS[inv.sector] || inv.sector;
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
          placeholder="Search assets, countries, entities…"
          value="${escapeHtml(this.filters.search)}"
        />
        <select class="fdi-filter" data-filter="investingCountry">
          <option value="ALL">🌐 All Countries</option>
          <option value="SA" ${this.filters.investingCountry === 'SA' ? 'selected' : ''}>🇸🇦 Saudi Arabia</option>
          <option value="UAE" ${this.filters.investingCountry === 'UAE' ? 'selected' : ''}>🇦🇪 UAE</option>
        </select>
        <select class="fdi-filter" data-filter="sector">
          <option value="ALL">All Sectors</option>
          ${sectors.map(s => `<option value="${s}" ${this.filters.sector === s ? 'selected' : ''}>${escapeHtml(SECTOR_LABELS[s as GulfInvestmentSector] || s)}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="entity">
          <option value="ALL">All Entities</option>
          ${entities.map(e => `<option value="${escapeHtml(e)}" ${this.filters.entity === e ? 'selected' : ''}>${escapeHtml(e)}</option>`).join('')}
        </select>
        <select class="fdi-filter" data-filter="status">
          <option value="ALL">All Statuses</option>
          <option value="operational" ${this.filters.status === 'operational' ? 'selected' : ''}>Operational</option>
          <option value="under-construction" ${this.filters.status === 'under-construction' ? 'selected' : ''}>Under Construction</option>
          <option value="announced" ${this.filters.status === 'announced' ? 'selected' : ''}>Announced</option>
          <option value="rumoured" ${this.filters.status === 'rumoured' ? 'selected' : ''}>Rumoured</option>
          <option value="divested" ${this.filters.status === 'divested' ? 'selected' : ''}>Divested</option>
        </select>
      </div>
      <div class="fdi-table-wrap">
        <table class="fdi-table">
          <thead>
            <tr>
              <th class="fdi-sort" data-sort="assetName">Asset${sortArrow('assetName')}</th>
              <th class="fdi-sort" data-sort="targetCountry">Country${sortArrow('targetCountry')}</th>
              <th class="fdi-sort" data-sort="sector">Sector${sortArrow('sector')}</th>
              <th class="fdi-sort" data-sort="status">Status${sortArrow('status')}</th>
              <th class="fdi-sort" data-sort="investmentUSD">Investment${sortArrow('investmentUSD')}</th>
              <th class="fdi-sort" data-sort="yearAnnounced">Year${sortArrow('yearAnnounced')}</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="fdi-empty">No investments match filters</td></tr>'}</tbody>
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
