/**
 * REITPanel — REIT market quotes by sector with AI briefing and peer comparison.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ [AI Briefing Banner — collapsible]       │
 *   ├─────────────────────────────────────────┤
 *   │ [All][Retail][Industrial][Residential].. │  ← sector tabs
 *   │ Symbol  Name    Price  Chg  Yield  Exp  │
 *   │ O       Realty  $57    +1%  5.4%   34   │  ← click → peer overlay
 *   │ PLD     Prolog  $121   -1%  3.1%   22   │
 *   └─────────────────────────────────────────┘
 *
 * Mortgage REITs: market data only (no exposure score column).
 * AI briefing: collapsible, remembers state in localStorage, re-expands on new day.
 */

import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { formatPrice, formatChange, getChangeClass, loadFromStorage, saveToStorage } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import type { ReitQuote, SectorRotationSignal, ReitRegime } from '@/services/reits';

const SECTORS = [
  { id: '', label: 'All' },
  { id: 'retail', label: 'Retail' },
  { id: 'industrial', label: 'Industrial' },
  { id: 'residential', label: 'Residential' },
  { id: 'office', label: 'Office' },
  { id: 'healthcare', label: 'Healthcare' },
  { id: 'datacenter', label: 'Data Center' },
  { id: 'specialty', label: 'Specialty' },
  { id: 'mortgage', label: 'Mortgage' },
];

const SECTOR_COLORS: Record<string, string> = {
  retail: '#58a6ff', industrial: '#3fb950', residential: '#d2a8ff',
  office: '#d29922', healthcare: '#f85149', datacenter: '#79c0ff',
  specialty: '#e3b341', mortgage: '#8b949e',
};

const BRIEFING_STORAGE_KEY = 'reit-briefing-collapsed';
const BRIEFING_DATE_KEY = 'reit-briefing-date';

export class REITPanel extends Panel {
  private activeSector = '';
  private quotes: ReitQuote[] = [];
  private aiBriefing = '';
  private regime: ReitRegime = 'REIT_REGIME_NEUTRAL';
  public sectorRotation: SectorRotationSignal[] = [];
  private onPeerClick: ((symbol: string) => void) | null = null;

  constructor() {
    super({
      id: 'reits',
      title: t('panels.reits') || 'REIT Monitor',
      infoTooltip: t('components.reits.infoTooltip') || 'Real Estate Investment Trust market quotes with sector analysis, AI briefing, and disaster exposure scores',
    });
  }

  /** Set handler for peer comparison click */
  public setPeerClickHandler(handler: (symbol: string) => void): void {
    this.onPeerClick = handler;
  }

  /** Main render entry point */
  public renderQuotes(
    quotes: ReitQuote[],
    regime: ReitRegime,
    aiBriefing: string,
    sectorRotation: SectorRotationSignal[],
    stale?: boolean,
  ): void {
    this.quotes = quotes;
    this.regime = regime;
    this.aiBriefing = aiBriefing;
    this.sectorRotation = sectorRotation;

    if (quotes.length === 0) {
      this.showError(t('common.failedToLoad') || 'REIT data temporarily unavailable');
      return;
    }

    if (stale) {
      this.setDataBadge('cached', 'Showing cached data');
    } else {
      this.setDataBadge('live');
    }

    this.setCount(quotes.length);
    this.render();
  }

  private render(): void {
    const filtered = this.activeSector
      ? this.quotes.filter(q => q.sector === this.activeSector)
      : this.quotes;

    const isMortgage = this.activeSector === 'mortgage';
    const briefingHtml = this.renderBriefing();
    const tabsHtml = this.renderTabs();
    const tableHtml = this.renderTable(filtered, isMortgage);

    this.setContent(`${briefingHtml}${tabsHtml}${tableHtml}`);
    this.attachTabListeners();
    this.attachRowListeners();
    this.attachBriefingListeners();
  }

  private renderBriefing(): string {
    if (!this.aiBriefing) return '';

    const today = new Date().toISOString().slice(0, 10);
    const savedDate = loadFromStorage(BRIEFING_DATE_KEY, '');
    const collapsed = savedDate === today && loadFromStorage(BRIEFING_STORAGE_KEY, false);

    const regimeLabel = this.regime.replace('REIT_REGIME_', '');
    const regimeColor = {
      REIT_REGIME_FAVORABLE: '#3fb950',
      REIT_REGIME_CAUTIOUS: '#d29922',
      REIT_REGIME_STRESS: '#f85149',
      REIT_REGIME_NEUTRAL: '#8b949e',
    }[this.regime as string] || '#8b949e';

    return `
      <div class="reit-briefing ${collapsed ? 'collapsed' : ''}" data-reit-briefing>
        <div class="reit-briefing-header" data-reit-briefing-toggle>
          <span style="font-size:11px;font-weight:600;color:var(--text)">
            AI Morning Briefing
            <span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:${regimeColor}22;color:${regimeColor};margin-left:6px">
              ${escapeHtml(regimeLabel)}
            </span>
          </span>
          <button class="reit-briefing-close" data-reit-briefing-close aria-label="Toggle briefing" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:2px 6px">
            ${collapsed ? '▼' : '×'}
          </button>
        </div>
        <div class="reit-briefing-body" style="${collapsed ? 'display:none' : ''}">
          <div style="font-size:11px;color:var(--text-dim);line-height:1.5;padding:8px 0">
            ${escapeHtml(this.aiBriefing).replace(/\n\n/g, '</div><div style="font-size:11px;color:var(--text-dim);line-height:1.5;padding:4px 0">')}
          </div>
        </div>
      </div>
    `;
  }

  private renderTabs(): string {
    return `
      <div class="reit-tabs" style="display:flex;gap:0;overflow-x:auto;border-bottom:1px solid var(--border);margin-bottom:8px;-webkit-overflow-scrolling:touch">
        ${SECTORS.map(s => `
          <button class="reit-tab ${s.id === this.activeSector ? 'active' : ''}"
                  data-reit-sector="${s.id}"
                  style="font-size:11px;padding:6px 12px;color:${s.id === this.activeSector ? 'var(--accent)' : 'var(--text-dim)'};background:none;border:none;border-bottom:2px solid ${s.id === this.activeSector ? 'var(--accent)' : 'transparent'};cursor:pointer;white-space:nowrap;flex-shrink:0">
            ${s.label}
          </button>
        `).join('')}
      </div>
    `;
  }

  private renderTable(quotes: ReitQuote[], isMortgage: boolean): string {
    if (quotes.length === 0) {
      return '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">No REITs in this sector</div>';
    }

    const headerExp = isMortgage ? '' : '<th style="text-align:right;width:40px">Exp</th>';

    const rows = quotes.map(q => {
      const sectorColor = SECTOR_COLORS[q.sector] || '#8b949e';
      const expBadge = isMortgage ? '' : `
        <td style="text-align:right">
          <span style="font-size:10px;font-weight:600;color:${q.disasterExposureScore > 50 ? '#f85149' : q.disasterExposureScore > 25 ? '#d29922' : '#3fb950'}">${q.disasterExposureScore}</span>
        </td>`;
      const currency = q.market === 'china' ? '¥' : '$';

      return `
        <tr class="reit-row" data-reit-symbol="${escapeHtml(q.symbol)}" style="cursor:pointer">
          <td>
            <span style="font-weight:600;font-size:11px">${escapeHtml(q.symbol)}</span>
            <span style="display:inline-block;font-size:9px;padding:0 4px;border-radius:3px;background:${sectorColor}22;color:${sectorColor};margin-left:4px">${escapeHtml(q.sector)}</span>
          </td>
          <td style="color:var(--text-dim);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(q.name)}</td>
          <td style="text-align:right;font-size:11px">${currency}${q.price >= 1000 ? q.price.toLocaleString(undefined, { maximumFractionDigits: 0 }) : q.price.toFixed(2)}</td>
          <td style="text-align:right"><span class="${getChangeClass(q.change)}" style="font-size:11px">${formatChange(q.change)}</span></td>
          <td style="text-align:right;color:#d2a8ff;font-size:11px;font-weight:500">${q.dividendYield.toFixed(2)}%</td>
          <td style="text-align:right">${miniSparkline(q.sparkline, q.change)}</td>
          ${expBadge}
        </tr>
      `;
    }).join('');

    return `
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 0;color:var(--text-dim);font-weight:500">Symbol</th>
            <th style="text-align:left;color:var(--text-dim);font-weight:500">Name</th>
            <th style="text-align:right;color:var(--text-dim);font-weight:500">Price</th>
            <th style="text-align:right;color:var(--text-dim);font-weight:500">Chg</th>
            <th style="text-align:right;color:var(--text-dim);font-weight:500">Yield</th>
            <th style="text-align:right;width:50px;color:var(--text-dim);font-weight:500">52W</th>
            ${headerExp}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private attachTabListeners(): void {
    this.content.querySelectorAll<HTMLButtonElement>('.reit-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeSector = btn.dataset.reitSector || '';
        this.render();
      });
    });
  }

  private attachRowListeners(): void {
    this.content.querySelectorAll<HTMLTableRowElement>('.reit-row').forEach(row => {
      row.addEventListener('click', () => {
        const symbol = row.dataset.reitSymbol;
        if (symbol && this.onPeerClick) this.onPeerClick(symbol);
      });
    });
  }

  private attachBriefingListeners(): void {
    const toggle = this.content.querySelector('[data-reit-briefing-toggle]');
    const close = this.content.querySelector('[data-reit-briefing-close]');
    if (toggle) {
      toggle.addEventListener('click', () => this.toggleBriefing());
    }
    if (close) {
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleBriefing();
      });
    }
  }

  private toggleBriefing(): void {
    const today = new Date().toISOString().slice(0, 10);
    const current = loadFromStorage(BRIEFING_STORAGE_KEY, false);
    saveToStorage(BRIEFING_STORAGE_KEY, !current);
    saveToStorage(BRIEFING_DATE_KEY, today);
    this.render();
  }
}
