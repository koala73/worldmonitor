import { Panel } from './Panel';
import { getNationalDebtData, type NationalDebtEntry } from '@/services/economic';
import { escapeHtml } from '@/utils/sanitize';

type SortMode = 'total' | 'gdp-ratio' | 'growth';

const COUNTRY_FLAGS: Record<string, string> = {
  AFG: '🇦🇫', ALB: '🇦🇱', DZA: '🇩🇿', AGO: '🇦🇴', ARG: '🇦🇷', ARM: '🇦🇲', AUS: '🇦🇺', AUT: '🇦🇹',
  AZE: '🇦🇿', BHS: '🇧🇸', BHR: '🇧🇭', BGD: '🇧🇩', BLR: '🇧🇾', BEL: '🇧🇪', BLZ: '🇧🇿', BEN: '🇧🇯',
  BTN: '🇧🇹', BOL: '🇧🇴', BIH: '🇧🇦', BWA: '🇧🇼', BRA: '🇧🇷', BRN: '🇧🇳', BGR: '🇧🇬', BFA: '🇧🇫',
  BDI: '🇧🇮', CPV: '🇨🇻', KHM: '🇰🇭', CMR: '🇨🇲', CAN: '🇨🇦', CAF: '🇨🇫', TCD: '🇹🇩', CHL: '🇨🇱',
  CHN: '🇨🇳', COL: '🇨🇴', COM: '🇰🇲', COD: '🇨🇩', COG: '🇨🇬', CRI: '🇨🇷', CIV: '🇨🇮', HRV: '🇭🇷',
  CYP: '🇨🇾', CZE: '🇨🇿', DNK: '🇩🇰', DJI: '🇩🇯', DOM: '🇩🇴', ECU: '🇪🇨', EGY: '🇪🇬', SLV: '🇸🇻',
  GNQ: '🇬🇶', ERI: '🇪🇷', EST: '🇪🇪', SWZ: '🇸🇿', ETH: '🇪🇹', FJI: '🇫🇯', FIN: '🇫🇮', FRA: '🇫🇷',
  GAB: '🇬🇦', GMB: '🇬🇲', GEO: '🇬🇪', DEU: '🇩🇪', GHA: '🇬🇭', GRC: '🇬🇷', GTM: '🇬🇹', GIN: '🇬🇳',
  GNB: '🇬🇼', GUY: '🇬🇾', HTI: '🇭🇹', HND: '🇭🇳', HKG: '🇭🇰', HUN: '🇭🇺', ISL: '🇮🇸', IND: '🇮🇳',
  IDN: '🇮🇩', IRN: '🇮🇷', IRQ: '🇮🇶', IRL: '🇮🇪', ISR: '🇮🇱', ITA: '🇮🇹', JAM: '🇯🇲', JPN: '🇯🇵',
  JOR: '🇯🇴', KAZ: '🇰🇿', KEN: '🇰🇪', KOR: '🇰🇷', KWT: '🇰🇼', KGZ: '🇰🇬', LAO: '🇱🇦',
  LVA: '🇱🇻', LBN: '🇱🇧', LSO: '🇱🇸', LBR: '🇱🇷', LBY: '🇱🇾', LTU: '🇱🇹', LUX: '🇱🇺', MAC: '🇲🇴',
  MDG: '🇲🇬', MWI: '🇲🇼', MYS: '🇲🇾', MDV: '🇲🇻', MLI: '🇲🇱', MLT: '🇲🇹', MRT: '🇲🇷', MUS: '🇲🇺',
  MEX: '🇲🇽', MDA: '🇲🇩', MNG: '🇲🇳', MNE: '🇲🇪', MAR: '🇲🇦', MOZ: '🇲🇿', MMR: '🇲🇲', NAM: '🇳🇦',
  NPL: '🇳🇵', NLD: '🇳🇱', NZL: '🇳🇿', NIC: '🇳🇮', NER: '🇳🇪', NGA: '🇳🇬', MKD: '🇲🇰', NOR: '🇳🇴',
  OMN: '🇴🇲', PAK: '🇵🇰', PAN: '🇵🇦', PNG: '🇵🇬', PRY: '🇵🇾', PER: '🇵🇪', PHL: '🇵🇭', POL: '🇵🇱',
  PRT: '🇵🇹', QAT: '🇶🇦', ROU: '🇷🇴', RUS: '🇷🇺', RWA: '🇷🇼', SAU: '🇸🇦', SEN: '🇸🇳', SRB: '🇷🇸',
  SLE: '🇸🇱', SGP: '🇸🇬', SVK: '🇸🇰', SVN: '🇸🇮', SOM: '🇸🇴', ZAF: '🇿🇦', SSD: '🇸🇸', ESP: '🇪🇸',
  LKA: '🇱🇰', SDN: '🇸🇩', SUR: '🇸🇷', SWE: '🇸🇪', CHE: '🇨🇭', TWN: '🇹🇼', TJK: '🇹🇯',
  TZA: '🇹🇿', THA: '🇹🇭', TLS: '🇹🇱', TGO: '🇹🇬', TTO: '🇹🇹', TUN: '🇹🇳', TUR: '🇹🇷', TKM: '🇹🇲',
  UGA: '🇺🇬', UKR: '🇺🇦', ARE: '🇦🇪', GBR: '🇬🇧', USA: '🇺🇸', URY: '🇺🇾', UZB: '🇺🇿', VEN: '🇻🇪',
  VNM: '🇻🇳', YEM: '🇾🇪', ZMB: '🇿🇲', ZWE: '🇿🇼',
};

const COUNTRY_NAMES: Record<string, string> = {
  AFG: 'Afghanistan', ALB: 'Albania', DZA: 'Algeria', AGO: 'Angola', ARG: 'Argentina',
  ARM: 'Armenia', AUS: 'Australia', AUT: 'Austria', AZE: 'Azerbaijan', BHS: 'Bahamas',
  BHR: 'Bahrain', BGD: 'Bangladesh', BLR: 'Belarus', BEL: 'Belgium', BLZ: 'Belize',
  BEN: 'Benin', BTN: 'Bhutan', BOL: 'Bolivia', BIH: 'Bosnia & Herzegovina', BWA: 'Botswana',
  BRA: 'Brazil', BRN: 'Brunei', BGR: 'Bulgaria', BFA: 'Burkina Faso', BDI: 'Burundi',
  CPV: 'Cabo Verde', KHM: 'Cambodia', CMR: 'Cameroon', CAN: 'Canada', CAF: 'Central African Rep.',
  TCD: 'Chad', CHL: 'Chile', CHN: 'China', COL: 'Colombia', COM: 'Comoros',
  COD: 'Dem. Rep. Congo', COG: 'Congo', CRI: 'Costa Rica', CIV: "Cote d'Ivoire", HRV: 'Croatia',
  CYP: 'Cyprus', CZE: 'Czech Republic', DNK: 'Denmark', DJI: 'Djibouti', DOM: 'Dominican Rep.',
  ECU: 'Ecuador', EGY: 'Egypt', SLV: 'El Salvador', GNQ: 'Equatorial Guinea', ERI: 'Eritrea',
  EST: 'Estonia', SWZ: 'Eswatini', ETH: 'Ethiopia', FJI: 'Fiji', FIN: 'Finland',
  FRA: 'France', GAB: 'Gabon', GMB: 'Gambia', GEO: 'Georgia', DEU: 'Germany',
  GHA: 'Ghana', GRC: 'Greece', GTM: 'Guatemala', GIN: 'Guinea', GNB: 'Guinea-Bissau',
  GUY: 'Guyana', HTI: 'Haiti', HND: 'Honduras', HKG: 'Hong Kong SAR', HUN: 'Hungary',
  ISL: 'Iceland', IND: 'India', IDN: 'Indonesia', IRN: 'Iran', IRQ: 'Iraq',
  IRL: 'Ireland', ISR: 'Israel', ITA: 'Italy', JAM: 'Jamaica', JPN: 'Japan',
  JOR: 'Jordan', KAZ: 'Kazakhstan', KEN: 'Kenya', KOR: 'Korea (South)',
  KWT: 'Kuwait', KGZ: 'Kyrgyzstan', LAO: 'Laos', LVA: 'Latvia', LBN: 'Lebanon',
  LSO: 'Lesotho', LBR: 'Liberia', LBY: 'Libya', LTU: 'Lithuania', LUX: 'Luxembourg',
  MAC: 'Macao SAR', MDG: 'Madagascar', MWI: 'Malawi', MYS: 'Malaysia', MDV: 'Maldives',
  MLI: 'Mali', MLT: 'Malta', MRT: 'Mauritania', MUS: 'Mauritius', MEX: 'Mexico',
  MDA: 'Moldova', MNG: 'Mongolia', MNE: 'Montenegro', MAR: 'Morocco', MOZ: 'Mozambique',
  MMR: 'Myanmar', NAM: 'Namibia', NPL: 'Nepal', NLD: 'Netherlands', NZL: 'New Zealand',
  NIC: 'Nicaragua', NER: 'Niger', NGA: 'Nigeria', MKD: 'North Macedonia', NOR: 'Norway',
  OMN: 'Oman', PAK: 'Pakistan', PAN: 'Panama', PNG: 'Papua New Guinea', PRY: 'Paraguay',
  PER: 'Peru', PHL: 'Philippines', POL: 'Poland', PRT: 'Portugal', QAT: 'Qatar',
  ROU: 'Romania', RUS: 'Russia', RWA: 'Rwanda', SAU: 'Saudi Arabia', SEN: 'Senegal',
  SRB: 'Serbia', SLE: 'Sierra Leone', SGP: 'Singapore', SVK: 'Slovakia', SVN: 'Slovenia',
  SOM: 'Somalia', ZAF: 'South Africa', SSD: 'South Sudan', ESP: 'Spain', LKA: 'Sri Lanka',
  SDN: 'Sudan', SUR: 'Suriname', SWE: 'Sweden', CHE: 'Switzerland',
  TWN: 'Taiwan', TJK: 'Tajikistan', TZA: 'Tanzania', THA: 'Thailand', TLS: 'Timor-Leste',
  TGO: 'Togo', TTO: 'Trinidad & Tobago', TUN: 'Tunisia', TUR: 'Turkey', TKM: 'Turkmenistan',
  UGA: 'Uganda', UKR: 'Ukraine', ARE: 'United Arab Emirates', GBR: 'United Kingdom',
  USA: 'United States', URY: 'Uruguay', UZB: 'Uzbekistan', VEN: 'Venezuela',
  VNM: 'Vietnam', YEM: 'Yemen', ZMB: 'Zambia', ZWE: 'Zimbabwe',
};

function getFlag(iso3: string): string {
  return COUNTRY_FLAGS[iso3] ?? '🌐';
}

function getCountryName(iso3: string): string {
  return COUNTRY_NAMES[iso3] ?? iso3;
}

function formatDebt(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(1)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${Math.round(usd).toLocaleString()}`;
}

function getCurrentDebt(entry: NationalDebtEntry): number {
  if (!entry.perSecondRate || !entry.baselineTs) return entry.debtUsd ?? 0;
  const secondsElapsed = (Date.now() - Number(entry.baselineTs)) / 1000;
  return (entry.debtUsd ?? 0) + entry.perSecondRate * secondsElapsed;
}

function sortEntries(entries: NationalDebtEntry[], mode: SortMode): NationalDebtEntry[] {
  const sorted = [...entries];
  if (mode === 'total') {
    sorted.sort((a, b) => getCurrentDebt(b) - getCurrentDebt(a));
  } else if (mode === 'gdp-ratio') {
    sorted.sort((a, b) => (b.debtToGdp ?? 0) - (a.debtToGdp ?? 0));
  } else if (mode === 'growth') {
    sorted.sort((a, b) => (b.annualGrowth ?? 0) - (a.annualGrowth ?? 0));
  }
  return sorted;
}

const PAGE_SIZE = 20;

export class NationalDebtPanel extends Panel {
  private entries: NationalDebtEntry[] = [];
  private filteredEntries: NationalDebtEntry[] = [];
  private sortMode: SortMode = 'total';
  private searchQuery = '';
  private loading = false;
  private lastFetch = 0;
  private visibleCount = PAGE_SIZE;
  private tickerInterval: ReturnType<typeof setInterval> | null = null;
  private tickerElements = new Map<string, HTMLElement>();
  private lastTickerValues = new Map<string, string>();
  private readonly REFRESH_INTERVAL = 6 * 60 * 60 * 1000;

  constructor() {
    super({
      id: 'national-debt',
      title: 'National Debt Clock',
      showCount: true,
      infoTooltip: 'Live national debt estimates for 150+ countries. Data anchored at 2024-01-01 and accruing using IMF deficit projections.',
    });

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tab = target.closest('[data-sort]') as HTMLElement | null;
      if (tab?.dataset.sort) {
        this.sortMode = tab.dataset.sort as SortMode;
        this.visibleCount = PAGE_SIZE;
        this.applyFilters();
        this.render();
        this.restartTicker();
        return;
      }
      if (target.closest('.debt-load-more')) {
        this.visibleCount += PAGE_SIZE;
        this.render();
        this.restartTicker();
      }
    });

    this.content.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains('debt-search')) {
        this.searchQuery = target.value;
        this.visibleCount = PAGE_SIZE;
        this.applyFilters();
        this.render();
        this.restartTicker();
      }
    });
  }

  public async refresh(): Promise<void> {
    if (this.loading) return;
    if (Date.now() - this.lastFetch < this.REFRESH_INTERVAL && this.entries.length > 0) return;

    this.loading = true;
    this.showLoadingState();

    try {
      const data = await getNationalDebtData();
      if (!this.element?.isConnected) {
        // Race condition: bootstrap data resolved synchronously before lazyPanel inserted
        // the element into the DOM. Retry after the current paint cycle.
        this.loading = false;
        requestAnimationFrame(() => { void this.refresh(); });
        return;
      }
      this.entries = data.entries ?? [];
      this.lastFetch = Date.now();
      this.applyFilters();
      this.setCount(this.filteredEntries.length);
      this.render();
      this.startTicker();
    } catch (err) {
      if (!this.element?.isConnected) return;
      console.error('[NationalDebtPanel] Error fetching data:', err);
      this.showError('Failed to load national debt data');
    } finally {
      this.loading = false;
    }
  }

  private showLoadingState(): void {
    this.setContent(`
      <div style="display:flex;align-items:center;justify-content:center;height:80px;color:var(--text-dim);font-size:13px;">
        Loading debt data from IMF...
      </div>
    `);
  }

  private applyFilters(): void {
    const q = this.searchQuery.toLowerCase().trim();
    const base = q
      ? this.entries.filter(e =>
          e.iso3.toLowerCase().includes(q) ||
          getCountryName(e.iso3).toLowerCase().includes(q),
        )
      : this.entries;
    this.filteredEntries = sortEntries(base, this.sortMode);
  }

  private get deficitCount(): number {
    return this.entries.filter(e => e.perSecondRate > 0).length;
  }

  private get surplusCount(): number {
    return this.entries.filter(e => e.perSecondRate === 0).length;
  }

  private getGlobalDebt(): number {
    return this.entries.reduce((sum, e) => sum + getCurrentDebt(e), 0);
  }

  private render(): void {
    if (this.entries.length === 0) {
      this.showError('No data available');
      return;
    }

    const html = `
      <div class="debt-panel-container">
        <div class="debt-summary">
          <div class="debt-summary-card debt-summary-card-deficit debt-summary-card-world">
            <span class="debt-summary-label">World Debt</span>
            <span class="debt-summary-value debt-global-ticker">${escapeHtml(formatDebt(this.getGlobalDebt()))}</span>
          </div>
          <div class="debt-summary-card debt-summary-card-warning">
            <span class="debt-summary-label">In Deficit</span>
            <span class="debt-summary-value">${this.deficitCount}</span>
          </div>
          <div class="debt-summary-card debt-summary-card-surplus">
            <span class="debt-summary-label">Running Surplus</span>
            <span class="debt-summary-value">${this.surplusCount}</span>
          </div>
        </div>
        <div class="debt-controls">
          <div class="debt-sort-tabs">
            <button class="debt-tab${this.sortMode === 'total' ? ' active' : ''}" data-sort="total">Total Debt</button>
            <button class="debt-tab${this.sortMode === 'gdp-ratio' ? ' active' : ''}" data-sort="gdp-ratio">Debt/GDP</button>
            <button class="debt-tab${this.sortMode === 'growth' ? ' active' : ''}" data-sort="growth">1Y Growth</button>
          </div>
          <input class="debt-search" type="text" placeholder="Search country..." value="${escapeHtml(this.searchQuery)}">
        </div>
        <div class="debt-list">
          ${this.filteredEntries.slice(0, this.visibleCount).map((entry, idx) => this.renderRow(entry, idx + 1)).join('')}
        </div>
        ${this.visibleCount < this.filteredEntries.length ? `
        <button class="debt-load-more">
          Load ${Math.min(PAGE_SIZE, this.filteredEntries.length - this.visibleCount)} more
          <span class="debt-load-more-count">(${this.filteredEntries.length - this.visibleCount} remaining)</span>
        </button>` : ''}
        <div class="debt-footer">
          <span class="debt-source">Source: IMF WEO 2024 + US Treasury FiscalData</span>
          <span class="debt-updated">Updated: ${new Date(this.lastFetch).toLocaleDateString()}</span>
        </div>
      </div>
    `;

    this.setContent(html);
  }

  private renderRow(entry: NationalDebtEntry, rank: number): string {
    const currentDebt = getCurrentDebt(entry);
    const name = escapeHtml(getCountryName(entry.iso3));
    const flag = getFlag(entry.iso3);
    const debtStr = formatDebt(currentDebt);
    const ratioStr = Number.isFinite(entry.debtToGdp) && entry.debtToGdp > 0
      ? `${entry.debtToGdp.toFixed(1)}%`
      : '—';
    const growthStr = Number.isFinite(entry.annualGrowth) && entry.annualGrowth !== 0
      ? `${entry.annualGrowth > 0 ? '+' : ''}${entry.annualGrowth.toFixed(1)}%`
      : '—';
    const growthClass = entry.annualGrowth > 5 ? 'debt-growth-high' : entry.annualGrowth > 0 ? 'debt-growth-mid' : '';

    return `
      <div class="debt-row" data-iso3="${escapeHtml(entry.iso3)}">
        <div class="debt-rank">${rank}</div>
        <div class="debt-flag">${flag}</div>
        <div class="debt-info">
          <div class="debt-name">${name}</div>
          <div class="debt-meta">
            <span class="debt-ratio">${ratioStr} of GDP</span>
            <span class="debt-growth ${growthClass}">${growthStr} YoY</span>
          </div>
        </div>
        <div class="debt-ticker" data-iso3="${escapeHtml(entry.iso3)}">${escapeHtml(debtStr)}</div>
      </div>
    `;
  }

  private startTicker(): void {
    this.stopTicker();
    if (this.filteredEntries.length === 0) return;

    // Pre-cache element references to avoid per-tick DOM queries
    this.tickerElements.clear();
    this.lastTickerValues.clear();
    const globalEl = this.content.querySelector<HTMLElement>('.debt-global-ticker');
    if (globalEl) this.tickerElements.set('__global__', globalEl);
    const container = this.content.querySelector('.debt-list');
    if (container) {
      for (const entry of this.filteredEntries.slice(0, this.visibleCount)) {
        const el = container.querySelector<HTMLElement>(`.debt-ticker[data-iso3="${entry.iso3}"]`);
        if (el) this.tickerElements.set(entry.iso3, el);
      }
    }

    this.tickerInterval = setInterval(() => {
      const gEl = this.tickerElements.get('__global__');
      if (gEl) {
        const v = formatDebt(this.getGlobalDebt());
        if (this.lastTickerValues.get('__global__') !== v) {
          gEl.textContent = v;
          this.lastTickerValues.set('__global__', v);
        }
      }
      for (const entry of this.filteredEntries.slice(0, this.visibleCount)) {
        const el = this.tickerElements.get(entry.iso3);
        if (!el) continue;
        const v = formatDebt(getCurrentDebt(entry));
        if (this.lastTickerValues.get(entry.iso3) !== v) {
          el.textContent = v;
          this.lastTickerValues.set(entry.iso3, v);
        }
      }
    }, 1000);
  }

  private stopTicker(): void {
    if (this.tickerInterval !== null) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
    }
    this.tickerElements.clear();
    this.lastTickerValues.clear();
  }

  private restartTicker(): void {
    this.stopTicker();
    this.startTicker();
  }

  public destroy(): void {
    this.stopTicker();
    super.destroy();
  }
}
