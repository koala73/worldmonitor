import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { StockAnalysisResult } from '@/services/stock-analysis';
import type { AnalystConsensus, PriceTarget, UpgradeDowngrade } from '@/generated/client/worldmonitor/market/v1/service_client';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import type { StockAnalysisHistory } from '@/services/stock-analysis-history';
import { sparkline } from '@/utils/sparkline';

function formatChange(change: number): string {
  const rounded = Number.isFinite(change) ? change.toFixed(2) : '0.00';
  return `${change >= 0 ? '+' : ''}${rounded}%`;
}

function formatPrice(price: number, currency: string): string {
  if (!Number.isFinite(price)) return 'N/A';
  return `${currency === 'USD' ? '$' : ''}${price.toFixed(2)}${currency && currency !== 'USD' ? ` ${currency}` : ''}`;
}

function stockSignalClass(signal: string): string {
  const normalized = signal.toLowerCase();
  if (normalized.includes('buy')) return 'badge-bullish';
  if (normalized.includes('hold') || normalized.includes('watch')) return 'badge-neutral';
  return 'badge-bearish';
}

function list(items: string[], cssClass: string): string {
  if (items.length === 0) return '';
  return `<ul class="${cssClass}" style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.5">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

export class StockAnalysisPanel extends Panel {
  constructor() {
    super({ id: 'stock-analysis', title: 'Premium Stock Analysis', infoTooltip: t('components.stockAnalysis.infoTooltip'), premium: 'locked' });
  }

  public renderAnalyses(items: StockAnalysisResult[], historyBySymbol: StockAnalysisHistory = {}, source: 'live' | 'cached' = 'live'): void {
    if (items.length === 0) {
      this.setDataBadge('unavailable');
      this.showRetrying('No premium stock analyses available yet.');
      return;
    }

    this.setDataBadge(source, `${items.length} symbols`);

    const html = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-dim);line-height:1.5">
          Analyst-grade equity reports powered by the shared market watchlist. The panel tracks the first ${items.length} eligible tickers.
        </div>
        ${items.map((item) => this.renderCard(item, historyBySymbol[item.symbol] || [])).join('')}
      </div>
    `;

    this.setContent(html);
  }

  private renderCard(item: StockAnalysisResult, history: StockAnalysisResult[]): string {
    const tone = stockSignalClass(item.signal);
    const priorRuns = history.filter((entry) => entry.generatedAt !== item.generatedAt).slice(0, 3);
    const previous = priorRuns[0];
    const signalDelta = previous ? item.signalScore - previous.signalScore : null;
    const headlines = item.headlines.slice(0, 2).map((headline) => {
      const href = sanitizeUrl(headline.link);
      const title = escapeHtml(headline.title);
      const source = escapeHtml(headline.source || 'Source');
      return `<a href="${href}" target="_blank" rel="noreferrer" style="display:block;color:var(--text);text-decoration:none;padding:8px 10px;border:1px solid var(--border);background:rgba(255,255,255,0.02)"><div style="font-size:12px;line-height:1.45">${title}</div><div style="margin-top:4px;font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">${source}</div></a>`;
    }).join('');

    return `
      <section class="signal-card" style="padding:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong style="font-size:16px;letter-spacing:-0.02em">${escapeHtml(item.name || item.symbol)}</strong>
              <span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);text-transform:uppercase">${escapeHtml(item.display || item.symbol)}</span>
              <span class="signal-badge ${tone}" style="font-family:var(--font-mono)">${escapeHtml(item.signal)}</span>
            </div>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim);line-height:1.5">${escapeHtml(item.summary)}</div>
          </div>
          <div style="text-align:right;min-width:110px">
            <div style="font-size:18px;font-weight:700">${escapeHtml(formatPrice(item.currentPrice, item.currency))}</div>
            <div style="font-size:12px;color:${item.changePercent >= 0 ? 'var(--semantic-normal)' : 'var(--semantic-critical)'}">${escapeHtml(formatChange(item.changePercent))}</div>
            <div style="margin-top:6px;font-size:11px;color:var(--text-dim)">Score ${escapeHtml(String(item.signalScore))} · ${escapeHtml(item.confidence)}</div>
          </div>
          ${history.length >= 2 ? (() => {
            const scores = history.slice(0, 6).reverse().map(e => e.signalScore);
            const last = scores[scores.length - 1] ?? 0;
            const prev = scores[scores.length - 2] ?? last;
            return sparkline(scores, last >= prev ? 'var(--semantic-normal)' : 'var(--semantic-critical)', 60, 20, 'display:block;margin-top:4px;align-self:flex-end');
          })() : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;font-size:11px">
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Trend</div><div style="margin-top:4px">${escapeHtml(item.trendStatus)}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">MA5 Bias</div><div style="margin-top:4px">${escapeHtml(formatChange(item.biasMa5))}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">RSI 12</div><div style="margin-top:4px">${escapeHtml(item.rsi12.toFixed(1))}</div></div>
          <div style="border:1px solid var(--border);padding:8px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Volume</div><div style="margin-top:4px">${escapeHtml(item.volumeStatus)}</div></div>
        </div>
        <div style="font-size:12px;line-height:1.55;color:var(--text)"><strong style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Action</strong><div style="margin-top:4px">${escapeHtml(item.action)}</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Bullish Factors</div>
            ${list(item.bullishFactors.slice(0, 3), 'badge-bullish')}
          </div>
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Risk Factors</div>
            ${list(item.riskFactors.slice(0, 3), 'badge-bearish')}
          </div>
        </div>
        <div style="font-size:12px;line-height:1.55;color:var(--text-dim)">
          <strong style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Why Now</strong>
          <div style="margin-top:4px">${escapeHtml(item.whyNow)}</div>
        </div>
        ${previous ? `
          <div style="font-size:12px;line-height:1.55;color:var(--text-dim)">
            <strong style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Signal Drift</strong>
            <div style="margin-top:4px">
              Previous run was ${escapeHtml(previous.signal)} at score ${escapeHtml(String(previous.signalScore))}.
              Current drift is ${escapeHtml(`${signalDelta && signalDelta > 0 ? '+' : ''}${(signalDelta || 0).toFixed(1)}`)}.
            </div>
          </div>
        ` : ''}
        ${priorRuns.length > 0 ? `
          <div style="display:grid;gap:6px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Recent History</div>
            ${priorRuns.map((entry) => `
              <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);background:rgba(255,255,255,0.02);font-size:11px">
                <span>${escapeHtml(entry.signal)} · score ${escapeHtml(String(entry.signalScore))}</span>
                <span style="color:var(--text-dim)">${escapeHtml(new Date(entry.generatedAt).toLocaleString())}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${headlines ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${headlines}</div>` : ''}
        ${this.renderAnalystConsensus(item)}
      </section>
    `;
  }

  private renderAnalystConsensus(item: StockAnalysisResult): string {
    const consensus = item.analystConsensus;
    const pt = item.priceTarget;
    const upgrades = item.recentUpgrades;
    const hasConsensus = consensus && consensus.total > 0;
    const hasMean = typeof pt?.mean === 'number' && pt.mean > 0;
    const hasMedian = typeof pt?.median === 'number' && pt.median > 0;
    const hasPriceTarget = !!pt && pt.numberOfAnalysts > 0 && (hasMean || hasMedian);
    const hasUpgrades = upgrades && upgrades.length > 0;

    if (!hasConsensus && !hasPriceTarget && !hasUpgrades) return '';

    return `
      <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:10px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);margin-bottom:8px">Analyst Consensus</div>
        ${hasConsensus ? this.renderRatingBar(consensus) : ''}
        ${hasPriceTarget ? this.renderPriceTarget(pt, item.currentPrice, item.currency) : ''}
        ${hasUpgrades ? this.renderRecentUpgrades(upgrades) : ''}
      </div>
    `;
  }

  private renderRatingBar(c: AnalystConsensus): string {
    const total = c.total || 1;
    const pct = (v: number) => ((v / total) * 100).toFixed(1);
    const segments = [
      { label: 'Strong Buy', count: c.strongBuy, color: '#16a34a', pct: pct(c.strongBuy) },
      { label: 'Buy', count: c.buy, color: '#4ade80', pct: pct(c.buy) },
      { label: 'Hold', count: c.hold, color: '#facc15', pct: pct(c.hold) },
      { label: 'Sell', count: c.sell, color: '#f87171', pct: pct(c.sell) },
      { label: 'Strong Sell', count: c.strongSell, color: '#dc2626', pct: pct(c.strongSell) },
    ].filter((s) => s.count > 0);

    const bar = segments.map((s) =>
      `<div style="flex:${s.count};background:${s.color};height:8px;min-width:2px" title="${escapeHtml(s.label)}: ${s.count} (${s.pct}%)"></div>`
    ).join('');

    const legend = segments.map((s) =>
      `<span style="display:inline-flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:2px;background:${s.color};display:inline-block"></span>${s.count}</span>`
    ).join('<span style="color:var(--border);margin:0 4px">|</span>');

    return `
      <div style="margin-bottom:8px">
        <div style="display:flex;gap:1px;border-radius:4px;overflow:hidden;margin-bottom:4px">${bar}</div>
        <div style="font-size:10px;color:var(--text-dim);display:flex;align-items:center;flex-wrap:wrap;gap:2px">${legend}<span style="margin-left:6px;color:var(--text-dim)">(${total} analysts)</span></div>
      </div>
    `;
  }

  private renderPriceTarget(pt: PriceTarget, currentPrice: number, currency: string): string {
    const currSymbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : (currency || '$');
    const isSymbolPrefix = currSymbol.length === 1;
    const fmt = (v: number) => isSymbolPrefix ? `${currSymbol}${v.toFixed(2)}` : `${v.toFixed(2)} ${currSymbol}`;

    const hasVal = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const low = hasVal(pt.low) ? pt.low : undefined;
    const high = hasVal(pt.high) ? pt.high : undefined;
    const mean = hasVal(pt.mean) ? pt.mean : undefined;
    const median = hasVal(pt.median) ? pt.median : undefined;
    const displayMedian = median ?? mean;

    if (!displayMedian) return '';

    const cells: string[] = [];
    if (low !== undefined) {
      cells.push(`<div style="border:1px solid var(--border);padding:6px 8px;flex:1;min-width:90px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Low</div><div style="margin-top:2px">${escapeHtml(fmt(low))}</div></div>`);
    }
    cells.push(`<div style="border:1px solid var(--border);padding:6px 8px;flex:1;min-width:90px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Median</div><div style="margin-top:2px">${escapeHtml(fmt(displayMedian))}</div></div>`);
    if (high !== undefined) {
      cells.push(`<div style="border:1px solid var(--border);padding:6px 8px;flex:1;min-width:90px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">High</div><div style="margin-top:2px">${escapeHtml(fmt(high))}</div></div>`);
    }
    cells.push(`<div style="border:1px solid var(--border);padding:6px 8px;flex:1;min-width:90px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">Analysts</div><div style="margin-top:2px">${escapeHtml(String(pt.numberOfAnalysts))}</div></div>`);

    if (currentPrice > 0) {
      const upsidePct = ((displayMedian - currentPrice) / currentPrice) * 100;
      const upsideColor = upsidePct >= 0 ? 'var(--semantic-normal)' : 'var(--semantic-critical)';
      const upsideStr = `${upsidePct >= 0 ? '+' : ''}${upsidePct.toFixed(1)}%`;
      cells.push(`<div style="border:1px solid var(--border);padding:6px 8px;flex:1;min-width:90px"><div style="color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em">vs Current</div><div style="margin-top:2px;color:${upsideColor}">${escapeHtml(upsideStr)}</div></div>`);
    }

    return `<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:11px;margin-bottom:8px">${cells.join('')}</div>`;
  }

  private renderRecentUpgrades(upgrades: UpgradeDowngrade[]): string {
    const rows = upgrades.slice(0, 3).map((u) => {
      const actionColor = u.action === 'up' || u.action === 'init' ? 'var(--semantic-normal)' : u.action === 'down' ? 'var(--semantic-critical)' : 'var(--text-dim)';
      const actionLabel = u.action === 'up' ? 'Upgrade' : u.action === 'down' ? 'Downgrade' : u.action === 'init' ? 'Initiated' : escapeHtml(u.action);
      const gradeChange = u.fromGrade ? `${escapeHtml(u.fromGrade)} → ${escapeHtml(u.toGrade)}` : escapeHtml(u.toGrade);

      return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);background:rgba(255,255,255,0.02);font-size:11px">
          <span style="font-weight:500">${escapeHtml(u.firm)}</span>
          <span style="color:${actionColor};white-space:nowrap">${actionLabel}</span>
          <span style="color:var(--text-dim);white-space:nowrap">${gradeChange}</span>
        </div>
      `;
    }).join('');

    return `
      <div style="display:grid;gap:4px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Recent Actions</div>
        ${rows}
      </div>
    `;
  }
}
