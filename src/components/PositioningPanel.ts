import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { HyperliquidAssetFlow } from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';

let _client: MarketServiceClient | null = null;

async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_client) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

interface AssetView {
  symbol: string;
  display: string;
  group: string;
  funding: number | null;
  oiDelta1h: number | null;
  composite: number;
  warmup: boolean;
  stale: boolean;
}

interface FlowSnapshot {
  warmup: boolean;
  commodityAssets: AssetView[];
  cryptoAssets: AssetView[];
  fxAssets: AssetView[];
  unavailable: boolean;
}

const ELEVATED_THRESHOLD = 40;

// 12 samples back = 1 hour at 5min cadence. Matches the original
// MarketPanel.ts implementation. Using 2 samples would report a
// 5-minute delta mislabeled as "OI delta 1h".
function oiDelta1h(sparkOi: number[] | undefined): number | null {
  if (!Array.isArray(sparkOi) || sparkOi.length < 13) return null;
  const last = sparkOi[sparkOi.length - 1]!;
  const lookback = sparkOi[sparkOi.length - 13]!;
  if (!(lookback > 0) || !Number.isFinite(last)) return null;
  return (last - lookback) / lookback;
}

function parseFiniteNumber(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function mapAsset(a: HyperliquidAssetFlow | Record<string, unknown>, fromSeed: boolean): AssetView {
  const sparkOi = Array.isArray(a.sparkOi) ? (a.sparkOi as number[]).filter((v) => Number.isFinite(v)) : [];
  return {
    symbol: String(a.symbol ?? ''),
    display: String(a.display ?? ''),
    group: String(a.group ?? ''),
    funding: fromSeed
      ? (typeof a.funding === 'number' && Number.isFinite(a.funding) ? a.funding : null)
      : parseFiniteNumber(a.funding as string | number | undefined),
    oiDelta1h: oiDelta1h(sparkOi),
    composite: Number(a.composite || 0),
    warmup: Boolean(a.warmup),
    stale: Boolean(a.stale),
  };
}

function mapResponse(assets: Array<HyperliquidAssetFlow | Record<string, unknown>>, fromSeed: boolean): FlowSnapshot {
  const commodityAssets: AssetView[] = [];
  const cryptoAssets: AssetView[] = [];
  const fxAssets: AssetView[] = [];
  for (const a of assets) {
    const view = mapAsset(a, fromSeed);
    const group = view.group;
    if (group === 'fx') fxAssets.push(view);
    else if (group === 'crypto') cryptoAssets.push(view);
    else commodityAssets.push(view);
  }
  return { warmup: false, commodityAssets, cryptoAssets, fxAssets, unavailable: false };
}

function gaugeColor(score: number, funding: number | null): string {
  if (score < 15) return 'var(--text-dim)';
  const bearish = funding != null && funding < 0;
  if (bearish) {
    if (score >= 60) return '#e74c3c';
    if (score >= 40) return '#e67e22';
    return '#c0392b88';
  }
  if (score >= 60) return '#2ecc71';
  if (score >= 40) return '#27ae60';
  return '#2ecc7188';
}

function renderArcGauge(score: number, color: string, size = 56): string {
  const r = (size - 6) / 2;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const startAngle = Math.PI * 0.8;
  const endAngle = Math.PI * 2.2;
  const totalArc = endAngle - startAngle;
  const fillAngle = startAngle + (score / 100) * totalArc;

  const bgX1 = cx + r * Math.cos(startAngle);
  const bgY1 = cy + r * Math.sin(startAngle);
  const bgX2 = cx + r * Math.cos(endAngle);
  const bgY2 = cy + r * Math.sin(endAngle);

  const fX2 = cx + r * Math.cos(fillAngle);
  const fY2 = cy + r * Math.sin(fillAngle);
  const largeArc = (fillAngle - startAngle) > Math.PI ? 1 : 0;

  const opacity = score < 15 ? 0.4 : score < 40 ? 0.6 : 0.9;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pos-gauge">
    <path d="M ${bgX1} ${bgY1} A ${r} ${r} 0 1 1 ${bgX2} ${bgY2}" fill="none" stroke="var(--border-color, #333)" stroke-width="3" stroke-linecap="round"/>
    ${score > 0 ? `<path d="M ${bgX1} ${bgY1} A ${r} ${r} 0 ${largeArc} 1 ${fX2} ${fY2}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" opacity="${opacity}"/>` : ''}
    <text x="${cx}" y="${cy + 2}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="13" font-weight="600" opacity="${opacity}">${Math.round(score)}</text>
  </svg>`;
}

function renderAssetCard(asset: AssetView, clickTarget: string | null): string {
  const score = Math.round(asset.composite);
  const color = gaugeColor(score, asset.funding);
  const elevated = score >= ELEVATED_THRESHOLD;
  const fundingStr = asset.funding != null ? `${(asset.funding * 100).toFixed(3)}%` : '--';
  const fundingColor = asset.funding != null && asset.funding < 0 ? 'change-negative' : 'change-positive';
  const oiStr = asset.oiDelta1h != null ? `${asset.oiDelta1h >= 0 ? '+' : ''}${(asset.oiDelta1h * 100).toFixed(1)}%` : '--';
  const oiColor = asset.oiDelta1h != null && asset.oiDelta1h < 0 ? 'change-negative' : 'change-positive';
  const staleBadge = asset.stale ? ' <span class="pos-badge pos-badge--stale">stale</span>' : '';
  const warmupBadge = asset.warmup ? ' <span class="pos-badge pos-badge--warmup">warm</span>' : '';
  const elevatedClass = elevated ? ' pos-card--elevated' : '';
  const glowStyle = elevated ? ` style="--pos-glow-color: ${color}"` : '';
  const clickAttr = clickTarget ? ` data-pos-navigate="${escapeHtml(clickTarget)}"` : '';
  const cursorClass = clickTarget ? ' pos-card--clickable' : '';

  const title = `${asset.symbol} score ${score}/100` +
    (asset.funding != null ? ` | funding ${fundingStr}` : '') +
    (asset.oiDelta1h != null ? ` | OI delta ${oiStr}` : '') +
    (asset.warmup ? ' | warming up' : '') +
    (asset.stale ? ' | upstream stale' : '');

  return `<div class="pos-card${elevatedClass}${cursorClass}"${glowStyle}${clickAttr} title="${escapeHtml(title)}">
    <div class="pos-card__name">${escapeHtml(asset.display)}${staleBadge}${warmupBadge}</div>
    ${renderArcGauge(score, color)}
    <div class="pos-card__metrics">
      <span class="${fundingColor}" title="hourly funding">${escapeHtml(fundingStr)}</span>
      <span class="${oiColor}" title="OI delta 1h">${escapeHtml(oiStr)}</span>
    </div>
  </div>`;
}

// Keys must match the seeded symbol field from seed-hyperliquid-flow.mjs,
// NOT display names. Commodity perps use xyz: prefixed Hyperliquid names.
const CLICK_TARGETS: Record<string, string> = {
  BTC: 'crypto', ETH: 'crypto', SOL: 'crypto',
  PAXG: 'commodities',
  'xyz:CL': 'commodities', 'xyz:BRENTOIL': 'commodities',
  'xyz:GOLD': 'commodities', 'xyz:SILVER': 'commodities',
  'xyz:PLATINUM': 'commodities', 'xyz:PALLADIUM': 'commodities',
  'xyz:COPPER': 'commodities', 'xyz:NATGAS': 'commodities',
};

function resolveClickTarget(symbol: string): string | null {
  const panelId = CLICK_TARGETS[symbol];
  if (!panelId) return null;
  return document.querySelector(`[data-panel="${panelId}"]`) ? panelId : null;
}

function renderSection(header: string, assets: AssetView[]): string {
  if (assets.length === 0) return '';
  const sorted = [...assets].sort((a, b) => b.composite - a.composite);
  const cards = sorted.map((a) => renderAssetCard(a, resolveClickTarget(a.symbol))).join('');
  return `<div class="pos-section">
    <div class="pos-section__header">${escapeHtml(header)}</div>
    <div class="pos-grid">${cards}</div>
  </div>`;
}

export class PositioningPanel extends Panel {
  private _flow: FlowSnapshot | null = null;
  private _loading = false;

  constructor() {
    super({
      id: 'positioning-247',
      title: t('components.positioning247.title'),
      showCount: false,
      infoTooltip: t('components.positioning247.infoTooltip'),
    });

    this.content.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-pos-navigate]');
      if (card?.dataset.posNavigate) {
        const panelEl = document.querySelector<HTMLElement>(`[data-panel="${card.dataset.posNavigate}"]`);
        if (panelEl) {
          panelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          panelEl.classList.add('panel-highlight');
          setTimeout(() => panelEl.classList.remove('panel-highlight'), 1500);
        }
      }
    });
  }

  public async fetchData(): Promise<boolean> {
    if (this._loading) return false;
    this._loading = true;
    try {
      if (!this._flow) {
        const hydrated = getHydratedData('hyperliquidFlow') as Record<string, unknown> | undefined;
        if (hydrated && !hydrated.unavailable && Array.isArray(hydrated.assets) && hydrated.assets.length > 0) {
          this._flow = {
            ...mapResponse(hydrated.assets as Array<Record<string, unknown>>, true),
            warmup: Boolean(hydrated.warmup),
          };
          this._render();
        }
      }

      const client = await getMarketClient();
      const resp = await client.getHyperliquidFlow({});
      if (resp.unavailable || !resp.assets || resp.assets.length === 0) {
        if (!this._flow) {
          this._flow = { warmup: true, commodityAssets: [], cryptoAssets: [], fxAssets: [], unavailable: true };
        }
      } else {
        this._flow = {
          ...mapResponse(resp.assets as HyperliquidAssetFlow[], false),
          warmup: Boolean(resp.warmup),
        };
      }
      this._render();
      return true;
    } catch (err) {
      console.error('[PositioningPanel] RPC failed:', err instanceof Error ? err.message : err);
      if (!this._flow) {
        this._flow = { warmup: true, commodityAssets: [], cryptoAssets: [], fxAssets: [], unavailable: true };
      }
      this._render();
      return false;
    } finally {
      this._loading = false;
    }
  }

  private _render(): void {
    if (!this._flow) {
      this.showLoading();
      return;
    }
    if (this._flow.unavailable) {
      // Empty snapshots on fresh deploy / cold seed are normal warmup, not errors.
      // Show guidance that samples populate over the next few minutes.
      this.setContent(`<div class="pos-panel"><div class="pos-warmup">${escapeHtml(t('components.positioning247.warmup'))}</div></div>`);
      return;
    }

    const sections: string[] = [];

    if (this._flow.warmup) {
      sections.push(`<div class="pos-warmup">${escapeHtml(t('components.positioning247.warmup'))}</div>`);
    }

    sections.push(renderSection(t('components.positioning247.commodities'), this._flow.commodityAssets));
    sections.push(renderSection(t('components.positioning247.crypto'), this._flow.cryptoAssets));
    sections.push(renderSection(t('components.positioning247.fx'), this._flow.fxAssets));

    sections.push(`<div class="pos-footer">${escapeHtml(t('components.positioning247.footer'))}</div>`);

    this.setContent(`<div class="pos-panel">${sections.join('')}</div>`);
  }
}
