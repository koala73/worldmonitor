import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

interface WeekData {
  date: string;
  bullish: number;
  bearish: number;
  neutral: number;
  spread: number;
}

interface AAIIData {
  seededAt: string;
  fallback?: boolean;
  source: string;
  latest: WeekData;
  previous: WeekData | null;
  avg8w: { bullish: number; bearish: number; neutral: number; spread: number } | null;
  historicalAvg: { bullish: number; bearish: number; neutral: number };
  extremes: { spreadBelow20: number; bullishAbove50: number; bearishAbove50: number };
  weeks: WeekData[];
}

function spreadColor(spread: number): string {
  if (spread <= -20) return '#e74c3c';
  if (spread <= -10) return '#e67e22';
  if (spread < 0) return '#f39c12';
  if (spread < 10) return '#95a5a6';
  if (spread < 20) return '#27ae60';
  return '#2ecc71';
}

function sentimentLabel(spread: number): string {
  if (spread <= -20) return 'Extreme Bearish';
  if (spread <= -10) return 'Bearish';
  if (spread < 0) return 'Mildly Bearish';
  if (spread < 10) return 'Neutral';
  if (spread < 20) return 'Bullish';
  return 'Extreme Bullish';
}

function renderBar(pct: number, color: string, label: string, value: string): string {
  return `<div style="margin:4px 0">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:2px">
      <span>${escapeHtml(label)}</span>
      <span style="color:${color};font-weight:600">${escapeHtml(value)}</span>
    </div>
    <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px">
      <div style="width:${Math.min(pct, 100)}%;height:100%;background:${color};border-radius:3px;transition:width 0.3s"></div>
    </div>
  </div>`;
}

function renderSpreadBar(spread: number): string {
  const color = spreadColor(spread);
  const clamped = Math.max(-60, Math.min(60, spread));
  const center = 50;
  const barWidth = Math.abs(clamped) / 60 * 50;
  const leftPct = clamped >= 0 ? center : center - barWidth;

  return `<div style="margin:8px 0">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:3px">
      <span>Bull-Bear Spread</span>
      <span style="color:${color};font-weight:700">${clamped >= 0 ? '+' : ''}${spread.toFixed(1)}%</span>
    </div>
    <div style="position:relative;height:10px;background:rgba(255,255,255,0.06);border-radius:4px">
      <div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(255,255,255,0.2)"></div>
      <div style="position:absolute;top:0;bottom:0;left:${leftPct.toFixed(1)}%;width:${barWidth.toFixed(1)}%;background:${color};border-radius:3px;transition:all 0.3s"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:2px">
      <span>Bearish</span>
      <span>Bullish</span>
    </div>
  </div>`;
}

function renderSparkChart(weeks: WeekData[]): string {
  if (weeks.length < 2) return '';
  const data = [...weeks].reverse();
  const W = 280, H = 60, PAD = 4;
  const spreads = data.map(w => w.spread);
  const maxAbs = Math.max(Math.abs(Math.min(...spreads)), Math.abs(Math.max(...spreads)), 20);
  const stepX = (W - PAD * 2) / (data.length - 1);
  const midY = H / 2;
  const scaleY = (midY - PAD) / maxAbs;

  const points = data.map((w, i) => {
    const x = (PAD + i * stepX).toFixed(1);
    const y = (midY - w.spread * scaleY).toFixed(1);
    return `${x},${y}`;
  });
  const polyline = points.join(' ');

  const bars = data.map((w, i) => {
    const x = PAD + i * stepX - 1;
    const barH = Math.abs(w.spread) * scaleY;
    const y = w.spread >= 0 ? midY - barH : midY;
    const fill = w.spread >= 0 ? 'rgba(39,174,96,0.25)' : 'rgba(231,76,60,0.25)';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="2" height="${barH.toFixed(1)}" fill="${fill}" rx="0.5"/>`;
  }).join('');

  const zeroLine = `<line x1="${PAD}" y1="${midY}" x2="${W - PAD}" y2="${midY}" stroke="rgba(255,255,255,0.15)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
  const contrarian = midY + 20 * scaleY;
  const contrarianLine = `<line x1="${PAD}" y1="${contrarian.toFixed(1)}" x2="${W - PAD}" y2="${contrarian.toFixed(1)}" stroke="rgba(231,76,60,0.3)" stroke-width="0.5" stroke-dasharray="2,4"/>`;
  const contrarianLabel = `<text x="${W - PAD}" y="${(contrarian - 2).toFixed(1)}" text-anchor="end" font-size="7" fill="rgba(231,76,60,0.5)" font-family="system-ui,sans-serif">-20 buy signal</text>`;

  return `<div style="margin:8px 0">
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">52-Week Spread History</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">
      ${bars}
      ${zeroLine}
      ${contrarianLine}
      ${contrarianLabel}
      <polyline points="${polyline}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>
  </div>`;
}

export class AAIISentimentPanel extends Panel {
  private data: AAIIData | null = null;

  constructor() {
    super({
      id: 'aaii-sentiment',
      title: 'AAII Investor Sentiment',
      showCount: false,
      infoTooltip: 'Weekly AAII survey: individual investors report 6-month market outlook as bullish, neutral, or bearish. Spread below -20 is a historical contrarian buy signal.',
    });
  }

  public async fetchData(): Promise<boolean> {
    // SSR hydration is one-shot: getHydratedData deletes the key after the
    // first read. Only the initial page-load call will hit this path — all
    // subsequent hourly refreshes fall through to the bootstrap API below.
    const hydrated = getHydratedData('aaiiSentiment') as AAIIData | undefined;
    if (hydrated?.latest) {
      this.data = hydrated;
      this.renderPanel();
      return true;
    }
    // Refresh path: fetch directly from the bootstrap API so the weekly
    // dataset keeps flowing after the first paint.
    try {
      const resp = await fetch(toApiUrl('/api/bootstrap?keys=aaiiSentiment'), {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const { data } = (await resp.json()) as { data: { aaiiSentiment?: AAIIData } };
        if (data.aaiiSentiment?.latest) {
          this.data = data.aaiiSentiment;
          this.renderPanel();
          return true;
        }
      }
    } catch { /* fallback below */ }
    // Retry after ~5 minutes so the panel recovers on its own if the seed
    // arrives late (AAII cadence is weekly but the cron can be delayed).
    this.showError('AAII sentiment data unavailable', () => { void this.fetchData(); }, 300);
    return false;
  }

  private renderPanel(): void {
    if (!this.data?.latest) {
      this.showError(t('common.noDataShort'), () => void this.fetchData());
      return;
    }

    const d = this.data;
    const { latest, previous, avg8w, historicalAvg, extremes, weeks } = d;
    const color = spreadColor(latest.spread);
    const label = sentimentLabel(latest.spread);

    const prevSpread = previous?.spread;
    const spreadDelta = prevSpread != null ? latest.spread - prevSpread : null;
    const deltaStr = spreadDelta != null
      ? `<span style="color:${spreadDelta >= 0 ? '#2ecc71' : '#e74c3c'};font-size:10px;margin-left:4px">${spreadDelta >= 0 ? '+' : ''}${spreadDelta.toFixed(1)} vs prev</span>`
      : '';

    const contrarianSignal = latest.spread <= -20
      ? `<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin:8px 0;border-radius:4px;border:1px solid #2ecc71;background:rgba(46,204,113,0.08);font-size:10px;color:#2ecc71">
          &#9432; Contrarian buy signal active: spread at ${latest.spread.toFixed(1)}% (threshold: -20%)
        </div>`
      : latest.bearish >= 50
        ? `<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin:8px 0;border-radius:4px;border:1px solid #e67e22;background:rgba(230,126,34,0.08);font-size:10px;color:#e67e22">
            &#9888; Extreme bearish reading: ${latest.bearish.toFixed(1)}% bearish (avg: ${historicalAvg.bearish}%)
          </div>`
        : '';

    const avgSection = avg8w ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">8-Week Moving Average</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;text-align:center">
          <div><div style="font-size:14px;font-weight:600;color:#2ecc71">${avg8w.bullish}%</div><div style="font-size:9px;color:var(--text-dim)">Bull</div></div>
          <div><div style="font-size:14px;font-weight:600;color:#95a5a6">${avg8w.neutral}%</div><div style="font-size:9px;color:var(--text-dim)">Neutral</div></div>
          <div><div style="font-size:14px;font-weight:600;color:#e74c3c">${avg8w.bearish}%</div><div style="font-size:9px;color:var(--text-dim)">Bear</div></div>
        </div>
      </div>` : '';

    const extremeSection = (extremes.spreadBelow20 > 0 || extremes.bearishAbove50 > 0)
      ? `<div style="margin-top:6px;font-size:10px;color:var(--text-dim)">
          52w extremes: ${extremes.spreadBelow20} contrarian signals, ${extremes.bearishAbove50} extreme bear, ${extremes.bullishAbove50} extreme bull
        </div>` : '';

    const fallbackBadge = d.fallback
      ? '<span style="display:inline-block;padding:1px 5px;border-radius:3px;background:rgba(230,126,34,0.15);color:#e67e22;font-size:9px;margin-left:4px">(fallback data)</span>'
      : '';
    const dateStr = latest.date ? `<div style="font-size:9px;color:var(--text-dim);text-align:right;margin-top:4px">Survey: ${escapeHtml(latest.date)}${d.source !== 'xls' ? ` (${escapeHtml(d.source)})` : ''}${fallbackBadge}</div>` : '';

    const html = `
      <div style="padding:12px 14px">
        <div style="text-align:center;margin-bottom:8px">
          <div style="font-size:11px;font-weight:600;color:${color};letter-spacing:0.06em;text-transform:uppercase">${escapeHtml(label)}</div>
          ${deltaStr ? `<div style="margin-top:2px">${deltaStr}</div>` : ''}
        </div>

        ${contrarianSignal}

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;margin-bottom:8px">
          <div>
            <div style="font-size:22px;font-weight:700;color:#2ecc71">${latest.bullish.toFixed(1)}%</div>
            <div style="font-size:10px;color:var(--text-dim)">Bullish</div>
            <div style="font-size:9px;color:var(--text-dim)">avg ${historicalAvg.bullish}%</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#95a5a6">${latest.neutral.toFixed(1)}%</div>
            <div style="font-size:10px;color:var(--text-dim)">Neutral</div>
            <div style="font-size:9px;color:var(--text-dim)">avg ${historicalAvg.neutral}%</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#e74c3c">${latest.bearish.toFixed(1)}%</div>
            <div style="font-size:10px;color:var(--text-dim)">Bearish</div>
            <div style="font-size:9px;color:var(--text-dim)">avg ${historicalAvg.bearish}%</div>
          </div>
        </div>

        ${renderBar(latest.bullish, '#2ecc71', 'Bullish', `${latest.bullish.toFixed(1)}%`)}
        ${renderBar(latest.neutral, '#95a5a6', 'Neutral', `${latest.neutral.toFixed(1)}%`)}
        ${renderBar(latest.bearish, '#e74c3c', 'Bearish', `${latest.bearish.toFixed(1)}%`)}

        ${renderSpreadBar(latest.spread)}

        ${renderSparkChart(weeks)}

        ${avgSection}
        ${extremeSection}
        ${dateStr}
      </div>`;

    this.setContent(html);
  }
}
