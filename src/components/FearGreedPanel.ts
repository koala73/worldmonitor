import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';

interface FearGreedData {
  compositeScore: number;
  compositeLabel: string;
  previousScore: number;
  seededAt: string;
  sentiment?: CategoryData;
  volatility?: CategoryData;
  positioning?: CategoryData;
  trend?: CategoryData;
  breadth?: CategoryData;
  momentum?: CategoryData;
  liquidity?: CategoryData;
  credit?: CategoryData;
  macro?: CategoryData;
  crossAsset?: CategoryData;
  vix: number;
  hySpread: number;
  yield10y: number;
  putCallRatio: number;
  pctAbove200d: number;
  cnnFearGreed: number;
  cnnLabel: string;
  aaiiBull: number;
  aaiiBear: number;
  fedRate: string;
  unavailable?: boolean;
}

interface CategoryData {
  score: number;
  weight: number;
  contribution: number;
  degraded?: boolean;
  inputsJson?: string;
}

function scoreColor(score: number): string {
  if (score <= 20) return '#e74c3c';
  if (score <= 40) return '#e67e22';
  if (score <= 60) return '#f1c40f';
  if (score <= 80) return '#2ecc71';
  return '#27ae60';
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null) return 'N/A';
  return v.toFixed(digits);
}

function getRegimeState(score: number): { state: string; stance: string; color: string } {
  if (score <= 20) return { state: 'Crisis / Risk-Off',    stance: 'CASH',        color: '#c0392b' };
  if (score <= 35) return { state: 'Stressed / Defensive', stance: 'DEFENSIVE',   color: '#e67e22' };
  if (score <= 50) return { state: 'Fragile / Hedged',     stance: 'HEDGED',      color: '#f1c40f' };
  if (score <= 65) return { state: 'Stable / Normal',      stance: 'NORMAL',      color: '#2ecc71' };
  return               { state: 'Strong / Risk-On',       stance: 'AGGRESSIVE',  color: '#27ae60' };
}

function getDivergenceWarnings(d: FearGreedData): string[] {
  const warnings: string[] = [];
  const mom = d.momentum?.score ?? 50;
  const sent = d.sentiment?.score ?? 50;
  const cnn = d.cnnFearGreed;
  const comp = d.compositeScore;
  const trend = d.trend?.score ?? 50;
  if (mom < 10)  warnings.push('Momentum at extreme low — broad equity selling pressure');
  if (sent < 15) warnings.push('Sentiment in extreme fear zone');
  if (cnn > 0 && Math.abs(comp - cnn) > 20) warnings.push(`CNN F&G ${Math.round(cnn)} diverges ${Math.abs(Math.round(comp - cnn))}pts from composite — sentiment/structural disconnect`);
  if (trend < 20) warnings.push('Trend in breakdown — price structure deteriorating');
  return warnings;
}

function renderGauge(score: number, label: string, delta: number | null, color: string): string {
  const cx = 100, cy = 100, R = 88, r = 60;

  function coord(deg: number, radius: number): string {
    const a = (deg * Math.PI) / 180;
    return `${(cx + radius * Math.cos(a)).toFixed(2)},${(cy - radius * Math.sin(a)).toFixed(2)}`;
  }

  const zones = [
    { a1: 180, a2: 144, fill: '#c0392b' },
    { a1: 144, a2: 108, fill: '#e67e22' },
    { a1: 108, a2:  72, fill: '#f1c40f' },
    { a1:  72, a2:  36, fill: '#2ecc71' },
    { a1:  36, a2:   0, fill: '#27ae60' },
  ];

  const segs = zones.map(z =>
    `<path d="M${coord(z.a1,R)} A${R},${R} 0 0,0 ${coord(z.a2,R)} L${coord(z.a2,r)} A${r},${r} 0 0,1 ${coord(z.a1,r)} Z" fill="${z.fill}" opacity="0.88"/>`
  ).join('');

  const na = ((180 - score * 1.8) * Math.PI) / 180;
  const nx = (cx + 75 * Math.cos(na)).toFixed(1);
  const ny = (cy - 75 * Math.sin(na)).toFixed(1);

  const dStr = delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs prev` : '';
  const dFill = delta != null ? (delta >= 0 ? '#2ecc71' : '#e74c3c') : '';
  const deltaLine = dStr
    ? `<text x="${cx}" y="111" text-anchor="middle" font-size="9" fill="${dFill}" font-family="system-ui,-apple-system,sans-serif">${dStr}</text>`
    : '';

  return `<svg viewBox="0 0 200 115" width="200" height="115" style="display:block;margin:0 auto">
    ${segs}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="${color}"/>
    <circle cx="${cx}" cy="${cy}" r="3" fill="rgba(8,8,8,0.9)"/>
    <text x="${cx}" y="81" text-anchor="middle" font-size="26" font-weight="700" fill="${color}" font-family="system-ui,-apple-system,sans-serif">${Math.round(score)}</text>
    <text x="${cx}" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="${color}" letter-spacing="0.07em" font-family="system-ui,-apple-system,sans-serif">${label}</text>
    ${deltaLine}
  </svg>`;
}

function mapSeedPayload(raw: Record<string, unknown>): FearGreedData | null {
  const comp = raw.composite as Record<string, unknown> | undefined;
  if (!comp?.score) return null;
  const cats = (raw.categories ?? {}) as Record<string, Record<string, unknown>>;
  const hdr = (raw.headerMetrics ?? {}) as Record<string, Record<string, unknown> | null>;
  const mapCat = (c: Record<string, unknown> | undefined): CategoryData | undefined => c ? {
    score: Number(c.score ?? 50),
    weight: Number(c.weight ?? 0),
    contribution: Number(c.contribution ?? 0),
    degraded: Boolean(c.degraded),
    inputsJson: JSON.stringify(c.inputs ?? {}),
  } : undefined;
  return {
    compositeScore: Number(comp.score),
    compositeLabel: String(comp.label ?? ''),
    previousScore: Number(comp.previous ?? 0),
    seededAt: String(raw.timestamp ?? ''),
    sentiment: mapCat(cats.sentiment),
    volatility: mapCat(cats.volatility),
    positioning: mapCat(cats.positioning),
    trend: mapCat(cats.trend),
    breadth: mapCat(cats.breadth),
    momentum: mapCat(cats.momentum),
    liquidity: mapCat(cats.liquidity),
    credit: mapCat(cats.credit),
    macro: mapCat(cats.macro),
    crossAsset: mapCat(cats.crossAsset),
    vix: Number(hdr?.vix?.value ?? 0),
    hySpread: Number(hdr?.hySpread?.value ?? 0),
    yield10y: Number(hdr?.yield10y?.value ?? 0),
    putCallRatio: Number(hdr?.putCall?.value ?? 0),
    pctAbove200d: Number(hdr?.pctAbove200d?.value ?? 0),
    cnnFearGreed: Number(hdr?.cnnFearGreed?.value ?? 0),
    cnnLabel: String(hdr?.cnnFearGreed?.label ?? ''),
    aaiiBull: Number(hdr?.aaiBull?.value ?? 0),
    aaiiBear: Number(hdr?.aaiBear?.value ?? 0),
    fedRate: String(hdr?.fedRate?.value ?? ''),
    unavailable: false,
  };
}

const CAT_NAMES = ['sentiment','volatility','positioning','trend','breadth','momentum','liquidity','credit','macro','crossAsset'] as const;

const CAT_DISPLAY: Record<string, string> = {
  sentiment: 'Sentiment',
  volatility: 'Volatility',
  positioning: 'Positioning',
  trend: 'Trend',
  breadth: 'Breadth',
  momentum: 'Momentum',
  liquidity: 'Liquidity',
  credit: 'Credit',
  macro: 'Macro',
  crossAsset: 'Cross-Asset',
};

export class FearGreedPanel extends Panel {
  private data: FearGreedData | null = null;

  constructor() {
    super({ id: 'fear-greed', title: t('panels.fearGreed'), showCount: false, infoTooltip: 'Composite sentiment index: 10 weighted categories (volatility, positioning, breadth, momentum, liquidity, credit, macro, cross-asset, sentiment, trend).' });
  }

  public async fetchData(): Promise<boolean> {
    const hydrated = getHydratedData('fearGreedIndex') as Record<string, unknown> | undefined;
    const hasBootstrap = hydrated && !hydrated.unavailable;
    if (hasBootstrap) {
      const mapped = mapSeedPayload(hydrated);
      if (mapped && mapped.compositeScore > 0) {
        this.data = mapped;
        this.renderPanel();
        // Always refresh from RPC to pick up complete data (bootstrap may have partial fields)
        void this.refreshFromRpc();
        return true;
      }
    }

    this.showLoading();
    return this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<boolean> {
    try {
      const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getFearGreedIndex({});
      if (resp.unavailable) {
        if (!this.data) this.showError(t('common.noDataShort'), () => void this.fetchData());
        return false;
      }
      this.data = resp as FearGreedData;
      this.renderPanel();
      return true;
    } catch (e) {
      if (!this.data) this.showError(e instanceof Error ? e.message : t('common.failedToLoad'), () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.showError(t('common.noDataShort'), () => void this.fetchData());
      return;
    }

    const d = this.data;
    const score = d.compositeScore;
    const label = escapeHtml(d.compositeLabel);
    const prev = d.previousScore;
    const delta = prev > 0 ? score - prev : null;
    const color = scoreColor(score);
    const regime = getRegimeState(score);
    const warnings = getDivergenceWarnings(d);

    const catRows = CAT_NAMES.map(name => {
      const c = d[name] as CategoryData | undefined;
      if (!c) return '';
      const s = Math.round(c.score ?? 50);
      const w = Math.round((c.weight ?? 0) * 100);
      const contrib = (c.contribution ?? 0).toFixed(1);
      const deg = c.degraded ? ' <span style="color:#e67e22;font-size:10px">degraded</span>' : '';
      const barColor = scoreColor(s);
      const displayName = CAT_DISPLAY[name] ?? name;
      return `
        <div style="margin:4px 0">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim)">
            <span>${escapeHtml(displayName)}${deg}</span>
            <span style="color:${barColor};font-weight:600">${s}</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin:2px 0">
            <div style="width:${s}%;height:100%;background:${barColor};border-radius:2px;transition:width 0.3s"></div>
          </div>
          <div style="font-size:10px;color:var(--text-dim)">${w}% weight &middot; +${contrib} pts</div>
        </div>`;
    }).join('');

    const hdrMetric = (lbl: string, val: string) =>
      `<div style="text-align:center;padding:6px 4px">
        <div style="font-size:18px;font-weight:600;color:var(--text)">${escapeHtml(val)}</div>
        <div style="font-size:10px;color:var(--text-dim);margin-top:2px">${escapeHtml(lbl)}</div>
      </div>`;

    const hdr = [
      hdrMetric('VIX', d.vix > 0 ? fmt(d.vix, 2) : 'N/A'),
      hdrMetric('HY Spread', d.hySpread > 0 ? `${fmt(d.hySpread, 2)}%` : 'N/A'),
      hdrMetric('10Y Yield', d.yield10y > 0 ? `${fmt(d.yield10y, 2)}%` : 'N/A'),
      hdrMetric('P/C Ratio', d.putCallRatio > 0 ? fmt(d.putCallRatio, 2) : 'N/A'),
      hdrMetric('% > 200d', d.pctAbove200d ? `${fmt(d.pctAbove200d, 1)}%` : 'N/A'),
      hdrMetric('CNN F&G', d.cnnFearGreed ? `${Math.round(d.cnnFearGreed)}` : 'N/A'),
      hdrMetric('AAII Bull', d.aaiiBull ? `${fmt(d.aaiiBull, 1)}%` : 'N/A'),
      hdrMetric('AAII Bear', d.aaiiBear ? `${fmt(d.aaiiBear, 1)}%` : 'N/A'),
      hdrMetric('Fed Rate', d.fedRate || 'N/A'),
    ].join('');

    const warningsHtml = warnings.length > 0
      ? `<div style="margin-bottom:10px">
          ${warnings.map(w => `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:4px;border-radius:4px;border:1px solid #e67e22;background:rgba(230,126,34,0.08);font-size:10px;color:#e67e22">&#9888; ${escapeHtml(w)}</div>`).join('')}
        </div>`
      : '';

    const html = `
      <div style="padding:12px 14px">
        <div style="text-align:center;margin-bottom:12px">
          <div style="text-align:center;font-size:11px;font-weight:600;color:${regime.color};letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px">${escapeHtml(regime.state)}</div>
          ${renderGauge(score, label, delta, color)}
          <div style="text-align:center;margin-top:6px;margin-bottom:8px">
            <span style="display:inline-block;padding:3px 12px;border-radius:999px;font-size:10px;font-weight:700;color:#fff;background:${regime.color};letter-spacing:0.08em">${escapeHtml(regime.stance)}</span>
          </div>
        </div>
        ${warningsHtml}
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:rgba(255,255,255,0.04);border-radius:8px;padding:4px;margin-bottom:12px">
          ${hdr}
        </div>
        <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Category Breakdown</div>
        ${catRows}
      </div>`;

    this.setContent(html);
  }
}
