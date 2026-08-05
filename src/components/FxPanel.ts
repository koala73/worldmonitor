import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml } from '@/utils/sanitize';
import type { SafeHtml } from '@/utils/sanitize';

import { FX_STRESS_THRESHOLD_PCT } from '@/services/economic/fx-rates';
import type { FxEurSpotRow, FxPanelRows, FxStressRow, FxUsdSpotRow } from '@/services/economic/fx-rates';

/**
 * FX panel — issue #6199.
 *
 * Two tabs over three seeded payloads that disagree on quote direction:
 *
 *  - **Stress** reads `economic:fx:yoy:v1` (45 currencies), which had no
 *    consumer anywhere in the repo before this panel. It is the differentiated
 *    half: nothing else in the product shows a currency collapse, and its
 *    coverage (ARS, TRY, EGP, NGN, PKR, UAH, LBP…) is exactly what BIS EER and
 *    the ECB reference rates both lack.
 *  - **Spot** reads `shared:fx-rates:v1` (USD-quoted) and
 *    `economic:ecb-fx-rates:v1` (EUR-base) as two separate lists.
 *
 * The two spot lists are never merged. `shared:fx-rates:v1` is USD per unit of
 * the listed currency and the ECB rates are units per euro; interleaving them
 * would quote half the table upside down.
 */

export type FxTabId = 'stress' | 'spot';

/**
 * FX rates span six orders of magnitude — one Kuwaiti dinar is 3.25 USD and one
 * Lebanese pound is 0.0000112 USD — so a fixed decimal count renders either
 * noise or a column of zeroes. Scale the precision to the value.
 */
function formatRate(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString();
  if (abs >= 100) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  return value.toPrecision(4);
}

/**
 * Zero is signless and neutral. A drawdown is never positive by construction
 * (`scripts/seed-fx-yoy.mjs` seeds `worstDrawdown = 0` and only lowers it), so
 * a currency that merely appreciated publishes exactly 0 — and a green "+0.0%"
 * in a loss column reads as a gain that cannot happen.
 */
function formatPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/**
 * The ECB day-over-day figure is an absolute delta in rate units, not a
 * percentage — matches `MarketPanel.ts:531` so the two surfaces cannot print
 * different numbers for the same seeded field.
 */
function formatDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(4)}`;
}

function changeClass(value: number): string {
  if (value > 0) return 'change-positive';
  if (value < 0) return 'change-negative';
  return 'fx-flat';
}

export class FxPanel extends Panel {
  private stress: FxStressRow[] = [];
  private usd: FxUsdSpotRow[] = [];
  private eur: FxEurSpotRow[] = [];
  private tab: FxTabId = 'stress';
  private loaded = false;

  constructor() {
    super({
      id: 'fx',
      title: t('panels.fx'),
      defaultRowSpan: 2,
      infoTooltip: t('components.fx.infoTooltip'),
    });

    this.content.addEventListener('click', (e) => this.handleClick(e));
  }

  /**
   * Load and render. Driven by the refresh scheduler rather than pushed from
   * the market data loader: this panel is opt-in, so the common path is a user
   * turning it on mid-session, long after the loader's market cycle has run.
   *
   * Every network call this reaches is bounded — `ensureHydrated` uses a 10s
   * timeout and the ECB RPC a 12s one — because an unsettled promise inside a
   * `scheduleRefresh` callback latches that refresh lane permanently.
   */
  public async fetchData(): Promise<void> {
    try {
      const { getFxPanelData } = await import('@/services/economic');
      const data = await getFxPanelData();
      if (!this.element?.isConnected) return;
      this.updateFx(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    }
  }

  private updateFx(data: FxPanelRows): void {
    this.stress = data.stress;
    this.usd = data.usd;
    this.eur = data.eur;
    this.loaded = true;
    this.render();
  }

  private handleClick(e: Event): void {
    const tab = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
    if (!tab?.dataset.tab) return;
    this.tab = tab.dataset.tab as FxTabId;
    this.render();
  }

  private hasStress(): boolean {
    return this.stress.length > 0;
  }

  private hasSpot(): boolean {
    return this.usd.length > 0 || this.eur.length > 0;
  }

  private render(): void {
    if (!this.loaded) return;

    // Three independent sources all returning nothing is an outage, not an
    // empty feed — there is no world in which 45 currencies, 47 USD rates and
    // 7 ECB pairs are all legitimately absent. `ensureHydrated` swallows fetch,
    // timeout and JSON errors into `undefined`, so a dead bootstrap is
    // indistinguishable from a miss at this layer; reporting "No data" would
    // state as fact something we cannot know, and would skip the retry that
    // recovers it. Surface it as a failure so the error state schedules one.
    if (!this.hasStress() && !this.hasSpot()) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    // Never leave the panel on a tab with nothing behind it — a seeder outage
    // on one key would otherwise render an empty body while the other tab has
    // data one click away that the reader has no reason to look for.
    if (this.tab === 'stress' && !this.hasStress()) this.tab = 'spot';
    if (this.tab === 'spot' && !this.hasSpot()) this.tab = 'stress';

    const body = this.tab === 'stress' ? this.renderStress() : this.renderSpot();
    this.setSafeContent(safeHtml`${this.renderTabs()}${body}`);
  }

  private renderTabs(): SafeHtml {
    const tabs: SafeHtml[] = [];
    if (this.hasStress()) {
      tabs.push(safeHtml`<button class="panel-tab ${this.tab === 'stress' ? 'active' : ''}" data-tab="stress">${t('components.fx.tabs.stress')}</button>`);
    }
    if (this.hasSpot()) {
      tabs.push(safeHtml`<button class="panel-tab ${this.tab === 'spot' ? 'active' : ''}" data-tab="spot">${t('components.fx.tabs.spot')}</button>`);
    }
    return safeHtml`<div class="panel-tabs">${joinSafeHtml(tabs)}</div>`;
  }

  private renderStress(): SafeHtml {
    const rows = joinSafeHtml(this.stress.map((r) => {
      // A currency with 24 months of history but no 12-month anchor bar still
      // has a usable drawdown; show the gap rather than dropping the row.
      const yoy = r.yoyChange === null
        ? safeHtml`<td class="fx-na">--</td>`
        : safeHtml`<td class="${changeClass(r.yoyChange)}">${formatPct(r.yoyChange)}</td>`;

      // #6199 asks for "peak/trough with dates". The rates carry the actual
      // magnitude — ARS 0.00117 -> 0.00069 is the collapse the percentage only
      // summarises — so both halves render, rates above their dates. Quoted in
      // USD per unit, matching the seeded direction rather than inverting only
      // this column.
      const hasWindow = r.peakRate !== null && r.troughRate !== null
        && r.peakDate !== null && r.troughDate !== null;
      const window = hasWindow
        ? safeHtml`<td class="fx-window">
            <span class="fx-window-rates">${formatRate(r.peakRate as number)} → ${formatRate(r.troughRate as number)}</span>
            <span class="fx-window-dates">${r.peakDate} → ${r.troughDate}</span>
          </td>`
        : safeHtml`<td class="fx-na">--</td>`;

      return safeHtml`
        <tr class="${r.stressed ? 'fx-stressed' : ''}">
          <td class="fx-ccy">
            <span class="fx-ccy-code">${r.currency}</span>
            <span class="fx-ccy-country">${r.countryCode}</span>
          </td>
          ${yoy}
          <td class="${changeClass(r.drawdown24m)}">${formatPct(r.drawdown24m)}</td>
          ${window}
        </tr>`;
    }));

    const asOf = this.stress.reduce<string | null>(
      (newest, r) => (r.asOf && (newest === null || r.asOf > newest) ? r.asOf : newest),
      null,
    );
    const stressedCount = this.stress.filter((r) => r.stressed).length;

    return safeHtml`
      <div class="fx-scroll">
        <table class="fx-table">
          <thead>
            <tr>
              <th class="fx-ccy">${t('components.fx.currency')}</th>
              <th>${t('components.fx.yoy')}</th>
              <th>${t('components.fx.drawdown')}</th>
              <th class="fx-window">${t('components.fx.peakToTrough')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="fx-footer">
        ${t('components.fx.stressedCount', {
          stressed: stressedCount,
          total: this.stress.length,
          // Interpolated rather than written into 26 translations: the constant
          // is the single source of truth, so changing it cannot leave every
          // locale quoting a threshold the code no longer uses.
          threshold: `${FX_STRESS_THRESHOLD_PCT}%`,
        })}
        · ${t('components.fx.sourceYahoo')}${asOf ? ` · ${asOf}` : ''}
      </div>`;
  }

  private renderSpot(): SafeHtml {
    const sections: SafeHtml[] = [];

    if (this.usd.length > 0) {
      const rows = joinSafeHtml(this.usd.map((r) => safeHtml`
        <tr>
          <td class="fx-ccy"><span class="fx-ccy-code">${r.currency}</span></td>
          <td>${formatRate(r.unitsPerUsd)}</td>
          <td class="fx-inverse">${formatRate(r.usdPerUnit)}</td>
        </tr>`));

      sections.push(safeHtml`
        <div class="fx-section-title">${t('components.fx.usdBase')}</div>
        <div class="fx-scroll">
          <table class="fx-table">
            <thead>
              <tr>
                <th class="fx-ccy">${t('components.fx.currency')}</th>
                <th>${t('components.fx.perUsd')}</th>
                <th class="fx-inverse">${t('components.fx.usdPerUnit')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="fx-footer">${t('components.fx.sourceYahoo')}</div>`);
    }

    if (this.eur.length > 0) {
      const rows = joinSafeHtml(this.eur.map((r) => {
        const change = r.change1d === null
          ? safeHtml`<td class="fx-na">--</td>`
          : safeHtml`<td class="${changeClass(r.change1d)}">${formatDelta(r.change1d)}</td>`;
        return safeHtml`
          <tr>
            <td class="fx-ccy"><span class="fx-ccy-code">EUR/${r.currency}</span></td>
            <td>${formatRate(r.rate)}</td>
            ${change}
          </tr>`;
      }));

      sections.push(safeHtml`
        <div class="fx-section-title">${t('components.fx.eurBase')}</div>
        <div class="fx-scroll">
          <table class="fx-table">
            <thead>
              <tr>
                <th class="fx-ccy">${t('components.fx.pair')}</th>
                <th>${t('components.fx.rate')}</th>
                <th>${t('components.fx.change1d')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="fx-footer">${t('components.fx.sourceEcb')}</div>`);
    }

    return joinSafeHtml(sections);
  }
}
