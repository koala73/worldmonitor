// Energy Risk Overview Panel
//
// One consolidated executive surface composing five existing data sources:
//   1. Hormuz status (vessels/day + status from src/services/hormuz-tracker.ts)
//   2. EU Gas storage fill % (bootstrap-cached `euGasStorage` + RPC fallback)
//   3. Brent crude price + 1-day delta (BZ=F via fetchCommodityQuotes)
//   4. Active disruptions count (listEnergyDisruptions filtered to endAt === null)
//   5. Data freshness (now - youngest fetchedAt across the four upstream signals)
//
// Plus a "Day N of crisis" counter computed at render time from a configurable
// pinned start date. NOT an editorial issue counter — we don't ship weekly
// briefings yet — but the same surface area at the top of the energy variant
// grid that peer reference sites use as their first-fold consolidator.
//
// Degraded-mode contract: every tile renders independently. If one of the five
// fetches rejects, that tile shows "—" and a `data-degraded="true"` attribute
// for QA inspection; the others render normally. Promise.allSettled — never
// Promise.all. This is the single most important behavior of the panel: a
// stuck Hormuz tracker must not freeze the whole executive overview.

import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { fetchHormuzTracker, type HormuzTrackerData } from '@/services/hormuz-tracker';
import { getEuGasStorageData } from '@/services/economic';
import { fetchCommodityQuotes } from '@/services/market';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { buildOverviewState, type OverviewState } from './_energy-risk-overview-state';

const supplyChain = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const BRENT_SYMBOL = 'BZ=F';
const BRENT_META = [{ symbol: BRENT_SYMBOL, name: 'Brent Crude', display: 'BRENT' }];

// Default pinned crisis-start date for the running Hormuz situation. Overridable
// via VITE_HORMUZ_CRISIS_START_DATE so the date can be re-pinned without a
// redeploy when the editorial framing shifts.
const DEFAULT_CRISIS_START_DATE = '2026-02-23';
const CRISIS_START_DATE: string =
  (import.meta.env?.VITE_HORMUZ_CRISIS_START_DATE as string | undefined) ||
  DEFAULT_CRISIS_START_DATE;
const CRISIS_START_MS = Date.parse(`${CRISIS_START_DATE}T00:00:00Z`);

// Map Hormuz status enum → severity color. Values come from
// src/services/hormuz-tracker.ts:20: 'closed' | 'disrupted' | 'restricted' | 'open'.
// NOT 'normal'/'reduced'/'critical' — that triplet was a misread in earlier
// drafts and would silently render as undefined.
const HORMUZ_STATUS_COLOR: Record<HormuzTrackerData['status'], string> = {
  closed:     '#e74c3c', // red — passage closed
  disrupted:  '#e74c3c', // red — significant disruption
  restricted: '#f39c12', // amber — partial constraints
  open:       '#27ae60', // green — flowing normally
};
const HORMUZ_STATUS_LABEL: Record<HormuzTrackerData['status'], string> = {
  closed:     'Closed',
  disrupted:  'Disrupted',
  restricted: 'Restricted',
  open:       'Open',
};

// State shape lives in _energy-risk-overview-state.ts so it can be tested
// under node:test without pulling in Vite-only modules. The panel's
// `state` field is typed loosely (just OverviewState) — the per-tile
// renderers cast `value` based on the tile they're rendering. The only
// downside is the Hormuz tile loses its enum literal type from
// HormuzTrackerData['status']; renderers narrow it again at use site.

const EMPTY_STATE: OverviewState = {
  hormuz:            { status: 'pending' },
  euGas:             { status: 'pending' },
  brent:             { status: 'pending' },
  activeDisruptions: { status: 'pending' },
};

export class EnergyRiskOverviewPanel extends Panel {
  private state: OverviewState = EMPTY_STATE;
  private freshnessTickHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({
      id: 'energy-risk-overview',
      title: 'Global Energy Risk Overview',
      defaultRowSpan: 1,
      infoTooltip:
        'Consolidated executive view: Strait of Hormuz vessel status, EU gas ' +
        'storage fill, Brent crude price + 1-day change, active disruption ' +
        'count, data freshness, and a configurable crisis-day counter. Each ' +
        'tile renders independently; one source failing does not block the ' +
        'others.',
    });
  }

  public destroy(): void {
    if (this.freshnessTickHandle !== null) {
      clearInterval(this.freshnessTickHandle);
      this.freshnessTickHandle = null;
    }
    super.destroy?.();
  }

  public async fetchData(): Promise<void> {
    const [hormuz, euGas, brent, disruptions] = await Promise.allSettled([
      fetchHormuzTracker(),
      getEuGasStorageData(),
      fetchCommodityQuotes(BRENT_META),
      // ongoingOnly=true: the panel only ever shows the count of active
      // disruptions, so let the server filter rather than ship the full
      // historical 52-event payload to be filtered client-side. This was
      // a Greptile P2 finding (over-fetch); buildOverviewState's count
      // calculation handles either response (the redundant client-side
      // filter remains as defense-in-depth in the state builder).
      supplyChain.listEnergyDisruptions({ assetId: '', assetType: '', ongoingOnly: true }),
    ]);
    this.state = buildOverviewState(hormuz, euGas, brent, disruptions, Date.now());

    if (!this.element?.isConnected) return;
    this.render();

    // Once we have data, kick a 60s freshness re-render so the "X minutes ago"
    // string ticks live. No new RPCs — this only updates the freshness label.
    if (this.freshnessTickHandle === null) {
      this.freshnessTickHandle = setInterval(() => {
        if (this.element?.isConnected) this.render();
      }, 60_000);
    }
  }

  private render(): void {
    injectRiskOverviewStylesOnce();
    const html = `
      <div class="ero-grid">
        ${this.renderHormuzTile()}
        ${this.renderEuGasTile()}
        ${this.renderBrentTile()}
        ${this.renderActiveDisruptionsTile()}
        ${this.renderFreshnessTile()}
        ${this.renderCrisisDayTile()}
      </div>
    `;
    this.setContent(html);
  }

  private renderHormuzTile(): string {
    const t = this.state.hormuz;
    if (t.status !== 'fulfilled' || !t.value) {
      return tileHtml('Hormuz', '—', '#7f8c8d', 'data-degraded="true"');
    }
    // After extracting state-builder into a Vite-free module, the Hormuz
    // tile's value.status is typed as plain string (not the enum literal
    // union). Cast at use site so the lookup tables index correctly.
    const status = t.value.status as HormuzTrackerData['status'];
    const color = HORMUZ_STATUS_COLOR[status] ?? '#7f8c8d';
    const label = HORMUZ_STATUS_LABEL[status] ?? t.value.status;
    return tileHtml('Hormuz', label, color);
  }

  private renderEuGasTile(): string {
    const t = this.state.euGas;
    if (t.status !== 'fulfilled' || !t.value) {
      return tileHtml('EU Gas', '—', '#7f8c8d', 'data-degraded="true"');
    }
    const fill = t.value.fillPct.toFixed(0);
    // Below 30% during refill season is critical; below 50% is amber.
    const color = t.value.fillPct < 30 ? '#e74c3c' : t.value.fillPct < 50 ? '#f39c12' : '#27ae60';
    return tileHtml('EU Gas', `${fill}%`, color);
  }

  private renderBrentTile(): string {
    const t = this.state.brent;
    if (t.status !== 'fulfilled' || !t.value) {
      return tileHtml('Brent', '—', '#7f8c8d', 'data-degraded="true"');
    }
    const price = `$${t.value.price.toFixed(2)}`;
    const change = t.value.change;
    const sign = change >= 0 ? '+' : '';
    const deltaText = `${sign}${change.toFixed(2)}%`;
    // Oil price up = bad for energy importers (the dominant Atlas reader).
    // Up = red. Down = green. Inverted from a usual market panel.
    const color = change >= 0 ? '#e74c3c' : '#27ae60';
    return tileHtml('Brent', price, color, '', deltaText);
  }

  private renderActiveDisruptionsTile(): string {
    const t = this.state.activeDisruptions;
    if (t.status !== 'fulfilled' || !t.value) {
      return tileHtml('Active disruptions', '—', '#7f8c8d', 'data-degraded="true"');
    }
    const n = t.value.count;
    const color = n === 0 ? '#27ae60' : n < 5 ? '#f39c12' : '#e74c3c';
    return tileHtml('Active disruptions', String(n), color);
  }

  private renderFreshnessTile(): string {
    // Youngest fetchedAt across all 4 upstream signals.
    const tiles = [this.state.hormuz, this.state.euGas, this.state.brent, this.state.activeDisruptions];
    const fetchedAts = tiles
      .map(t => t.fetchedAt)
      .filter((v): v is number => typeof v === 'number');
    if (fetchedAts.length === 0) {
      return tileHtml('Updated', '—', '#7f8c8d', 'data-degraded="true"');
    }
    const youngest = Math.max(...fetchedAts);
    const ageMin = Math.floor((Date.now() - youngest) / 60_000);
    const label = ageMin <= 0 ? 'just now' : ageMin === 1 ? '1 min ago' : `${ageMin} min ago`;
    return tileHtml('Updated', label, '#7f8c8d');
  }

  private renderCrisisDayTile(): string {
    if (!Number.isFinite(CRISIS_START_MS)) {
      // Mis-configured env (Date.parse returned NaN). Fail loudly via "—"
      // rather than rendering "Day NaN" or "Day -50".
      return tileHtml('Hormuz crisis', '—', '#7f8c8d', 'data-degraded="true"');
    }
    const days = Math.floor((Date.now() - CRISIS_START_MS) / 86_400_000);
    if (days < 0) {
      // Future-dated start: still render but with a sentinel value.
      return tileHtml('Hormuz crisis', 'pending', '#7f8c8d');
    }
    return tileHtml('Hormuz crisis', `Day ${days}`, '#7f8c8d');
  }
}

function tileHtml(label: string, value: string, color: string, attrs = '', sub = ''): string {
  const subHtml = sub ? `<div class="ero-tile__sub" style="color:${color}">${escapeHtml(sub)}</div>` : '';
  return `
    <div class="ero-tile" ${attrs}>
      <div class="ero-tile__label">${escapeHtml(label)}</div>
      <div class="ero-tile__value" style="color:${color}">${escapeHtml(value)}</div>
      ${subHtml}
    </div>
  `;
}

// CSS is injected once into <head> rather than emitted into the panel body.
// Pre-fix, the freshness setInterval re-rendered every 60s and called
// setContent(html + <style>...) — the style tag was torn out and re-inserted
// on every tick. Now the panel HTML is style-free; the rules live in head.
let _riskOverviewStylesInjected = false;
function injectRiskOverviewStylesOnce(): void {
  if (_riskOverviewStylesInjected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-ero-styles', '');
  style.textContent = RISK_OVERVIEW_CSS;
  document.head.appendChild(style);
  _riskOverviewStylesInjected = true;
}

const RISK_OVERVIEW_CSS = `
  .ero-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
    padding: 8px;
  }
  .ero-tile {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 10px 12px;
    min-height: 64px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .ero-tile__label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.55);
    margin-bottom: 4px;
  }
  .ero-tile__value {
    font-size: 18px;
    font-weight: 600;
    line-height: 1.1;
  }
  .ero-tile__sub {
    font-size: 12px;
    margin-top: 2px;
  }
`;
