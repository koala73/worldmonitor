import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml } from '@/utils/sanitize';
import type { SafeHtml } from '@/utils/sanitize';

import { FX_STRESS_THRESHOLD_PCT } from '@/services/economic/fx-rates';
import type { FxEurSpotRow, FxPanelRows, FxRubQuoteRow, FxSourceId, FxStressRow, FxUsdSpotRow } from '@/services/economic/fx-rates';

/**
 * FX panel — issue #6199 (#6231).
 *
 * Three tabs over four seeded payloads that disagree on quote direction:
 *
 *  - **Stress** reads `economic:fx:yoy:v1` (45 currencies), which had no
 *    consumer anywhere in the repo before this panel. It is the differentiated
 *    half: nothing else in the product shows a currency collapse, and its
 *    coverage (ARS, TRY, EGP, NGN, PKR, UAH, LBP…) is exactly what BIS EER and
 *    the ECB reference rates both lack.
 *  - **Spot** reads `shared:fx-rates:v1` (USD-quoted) and
 *    `economic:ecb-fx-rates:v1` (EUR-base) as two separate lists.
 *  - **RUB** reads `economic:cbr-rates:v1` (Bank of Russia quote table) as a
 *    third, RUB-base list. It is deliberately its own tab, not extra rows in
 *    Spot: these are RUB per one unit of the listed currency, a third quote
 *    direction, and folding them into either existing list would quote the
 *    pairs the wrong way round (#6231).
 *
 * The three spot lists are never merged. `shared:fx-rates:v1` is USD per unit
 * of the listed currency, the ECB rates are units per euro, and the CBR rates
 * are RUB per unit — interleaving any two would quote half the table upside
 * down.
 */

export type FxTabId = 'stress' | 'spot' | 'rub';

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

/**
 * Delay before re-reading a source that came back empty. Long enough not to
 * hammer a struggling upstream, short enough that a transient blip does not
 * cost the user the six hours until the next scheduled refresh.
 */
const DEGRADED_RETRY_MS = 60_000;

/** The stress tab is the panel's reason to exist, so it is where we land. */
const DEFAULT_TAB: FxTabId = 'stress';

export class FxPanel extends Panel {
  private stress: FxStressRow[] = [];
  private usd: FxUsdSpotRow[] = [];
  private eur: FxEurSpotRow[] = [];
  private rub: FxRubQuoteRow[] = [];
  private degraded: FxSourceId[] = [];
  private tab: FxTabId = DEFAULT_TAB;
  /** True when the tab-fallback moved us, not the user. See render(). */
  private tabForced = false;
  private loaded = false;
  private inFlight = false;
  private degradedRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Three independent triggers reach this — the 6h scheduler, Panel's error
    // countdown, and the degraded retry — so overlapping calls are likelier
    // here than in a panel with only the scheduler. Released in a `finally`;
    // every call it makes is timeout-bounded, so the promise always settles and
    // the latch cannot stick.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const { getFxPanelData } = await import('@/services/economic');
      const data = await getFxPanelData();
      if (!this.element?.isConnected) return;
      this.updateFx(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    } finally {
      this.inFlight = false;
    }
  }

  private updateFx(data: FxPanelRows): void {
    this.stress = data.stress;
    this.usd = data.usd;
    this.eur = data.eur;
    this.rub = data.rub;
    this.degraded = data.degraded;
    this.loaded = true;
    this.render();
    this.scheduleDegradedRetry();
  }

  /**
   * Re-read after a partial outage.
   *
   * The all-empty case takes the error path, which brings its own retry. A
   * PARTIAL outage does not: the panel renders the surviving tables, the tab
   * guard may even switch away from the missing one, and nothing looks wrong —
   * so without this the dead source stays dead until the 6h tick. One delayed
   * retry, replaced (never stacked) on each load and cleared on destroy.
   */
  private scheduleDegradedRetry(): void {
    this.clearDegradedRetry();
    if (this.degraded.length === 0) return;
    this.degradedRetryTimer = setTimeout(() => {
      this.degradedRetryTimer = null;
      if (!this.element?.isConnected) return;
      void this.fetchData();
    }, DEGRADED_RETRY_MS);
  }

  private clearDegradedRetry(): void {
    if (this.degradedRetryTimer !== null) {
      clearTimeout(this.degradedRetryTimer);
      this.degradedRetryTimer = null;
    }
  }

  public destroy(): void {
    this.clearDegradedRetry();
    super.destroy();
  }

  private handleClick(e: Event): void {
    const tab = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
    if (!tab?.dataset.tab) return;
    this.tab = tab.dataset.tab as FxTabId;
    // An explicit choice — never override it on a later refresh.
    this.tabForced = false;
    this.render();
  }

  private hasStress(): boolean {
    return this.stress.length > 0;
  }

  private hasSpot(): boolean {
    return this.usd.length > 0 || this.eur.length > 0;
  }

  private hasRub(): boolean {
    return this.rub.length > 0;
  }

  private render(): void {
    if (!this.loaded) return;

    // Four independent sources all returning nothing is an outage, not an
    // empty feed — there is no world in which 45 currencies, 47 USD rates, 7
    // ECB pairs and 54 CBR pairs are all legitimately absent. `ensureHydrated`
    // swallows fetch, timeout and JSON errors into `undefined`, so a dead
    // bootstrap is indistinguishable from a miss at this layer; reporting "No
    // data" would state as fact something we cannot know, and would skip the
    // retry that recovers it. Surface it as a failure so the error state
    // schedules one.
    if (!this.hasStress() && !this.hasSpot() && !this.hasRub()) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    // Return to the default tab once its source recovers, but ONLY if we were
    // the ones who moved off it. A tab the user picked is their choice and must
    // survive a refresh; a tab we forced them onto during an outage should not
    // outlive the outage, or the retry restores the data and leaves them parked
    // somewhere they never chose.
    if (this.tabForced && this.tab !== DEFAULT_TAB && this.hasStress()) {
      this.tab = DEFAULT_TAB;
      this.tabForced = false;
    }

    // Never leave the panel on a tab with nothing behind it — a seeder outage
    // on one key would otherwise render an empty body while another tab has
    // data one click away that the reader has no reason to look for. The
    // fallbacks can follow each other (every guard except the last re-fires on
    // the new tab), so all-empty surfaces as the error branch above.
    if (this.tab === 'stress' && !this.hasStress()) { this.tab = 'spot'; this.tabForced = true; }
    if (this.tab === 'spot' && !this.hasSpot()) { this.tab = 'rub'; this.tabForced = true; }
    if (this.tab === 'rub' && !this.hasRub()) { this.tab = 'stress'; this.tabForced = true; }

    const body = this.tab === 'stress'
      ? this.renderStress()
      : this.tab === 'spot' ? this.renderSpot() : this.renderRub();
    this.setSafeContent(safeHtml`${this.renderTabs()}${body}${this.renderDegradedNotice()}`);
  }

  /**
   * Name the sources that came back with nothing.
   *
   * Without this a dead source is indistinguishable from one that was never
   * part of the panel — the tab simply is not there, and a reader has no reason
   * to suspect anything is missing. Only rendered on a PARTIAL outage; the
   * all-empty case took the error path before reaching here.
   */
  private renderDegradedNotice(): SafeHtml {
    if (this.degraded.length === 0) return safeHtml``;
    const names = this.degraded.map((id) => t(`components.fx.source.${id}`)).join(', ');
    return safeHtml`<div class="fx-degraded">${t('components.fx.degraded', { sources: names })}</div>`;
  }

  private renderTabs(): SafeHtml {
    const tabs: SafeHtml[] = [];
    if (this.hasStress()) {
      tabs.push(safeHtml`<button class="panel-tab ${this.tab === 'stress' ? 'active' : ''}" data-tab="stress">${t('components.fx.tabs.stress')}</button>`);
    }
    if (this.hasSpot()) {
      tabs.push(safeHtml`<button class="panel-tab ${this.tab === 'spot' ? 'active' : ''}" data-tab="spot">${t('components.fx.tabs.spot')}</button>`);
    }
    if (this.hasRub()) {
      tabs.push(safeHtml`<button class="panel-tab ${this.tab === 'rub' ? 'active' : ''}" data-tab="rub">${t('components.fx.tabs.rub')}</button>`);
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

    // Rows can disagree: each `asOf` is that currency's own newest Yahoo bar,
    // and the seeder skips a currency whose fetch failed rather than failing the
    // run. Showing only the newest would present the freshest row's date as the
    // whole table's freshness, hiding a currency frozen days earlier — so when
    // they differ, show the span.
    const dates = this.stress.map((r) => r.asOf).filter((d): d is string => d !== null);
    const oldest = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : null;
    const newest = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    const asOf = oldest === null || newest === null
      ? null
      : oldest === newest ? newest : `${oldest} → ${newest}`;
    const stressedCount = this.stress.filter((r) => r.stressed).length;

    return safeHtml`
      <div class="fx-scroll">
        <table class="fx-table">
          <thead>
            <tr>
              <th scope="col" class="fx-ccy">${t('components.fx.currency')}</th>
              <th scope="col">${t('components.fx.yoy')}</th>
              <th scope="col">${t('components.fx.drawdown')}</th>
              <th scope="col" class="fx-window">${t('components.fx.peakToTrough')}</th>
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
                <th scope="col" class="fx-ccy">${t('components.fx.currency')}</th>
                <th scope="col">${t('components.fx.perUsd')}</th>
                <th scope="col" class="fx-inverse">${t('components.fx.usdPerUnit')}</th>
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
                <th scope="col" class="fx-ccy">${t('components.fx.pair')}</th>
                <th scope="col">${t('components.fx.rate')}</th>
                <th scope="col">${t('components.fx.change1d')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="fx-footer">${t('components.fx.sourceEcb')}</div>`);
    }

    return joinSafeHtml(sections);
  }

  /**
   * The Bank of Russia quote table — issue #6231.
   *
   * This is a THIRD quote direction and the one a reader can silently misread:
   * the rate is RUB per ONE unit of the listed currency (so USD reads ~81,
   * JPY ~0.5), the direct inverse of both tables in Spot. The heading names
   * the direction outright — "Bank of Russia — RUB per 1 unit" — and the
   * `rubPerUnit` column carries the raw value. `change1d` is an absolute delta
   * in RUB-per-unit, not a percentage, matching the EUR-delta treatment.
   */
  private renderRub(): SafeHtml {
    const rows = joinSafeHtml(this.rub.map((r) => {
      const change = r.change1d === null
        ? safeHtml`<td class="fx-na">--</td>`
        : safeHtml`<td class="${changeClass(r.change1d)}">${formatDelta(r.change1d)}</td>`;
      return safeHtml`
        <tr>
          <td class="fx-ccy"><span class="fx-ccy-code">${r.currency}</span></td>
          <td>${formatRate(r.rubPerUnit)}</td>
          ${change}
        </tr>`;
    }));

    return safeHtml`
      <div class="fx-section-title">${t('components.fx.rubBase')}</div>
      <div class="fx-scroll">
        <table class="fx-table">
          <thead>
            <tr>
              <th scope="col" class="fx-ccy">${t('components.fx.currency')}</th>
              <th scope="col">${t('components.fx.rubPerUnit')}</th>
              <th scope="col">${t('components.fx.change1d')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="fx-footer">${t('components.fx.sourceCbr')}</div>`;
  }
}
