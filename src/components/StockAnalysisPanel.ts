import { Panel } from './Panel';
import type { StockAnalysisResult } from '@/services/stock-analysis';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import type { StockAnalysisHistory } from '@/services/stock-analysis-history';

function formatChange(change: number): string {
  const rounded = Number.isFinite(change) ? change.toFixed(2) : '0.00';
  return `${change >= 0 ? '+' : ''}${rounded}%`;
}

function formatPrice(price: number, currency: string): string {
  if (!Number.isFinite(price)) return 'N/A';
  return `${currency === 'USD' ? '$' : ''}${price.toFixed(2)}${currency && currency !== 'USD' ? ` ${currency}` : ''}`;
}

function stockSignalTone(signal: string): string {
  const normalized = signal.toLowerCase();
  if (normalized.includes('buy')) return '#8df0b2';
  if (normalized.includes('hold') || normalized.includes('watch')) return '#f4d06f';
  return '#ff8c8c';
}

function list(items: string[], tone: string): string {
  if (items.length === 0) return '';
  return `<ul style="margin:8px 0 0;padding-left:18px;color:${tone};font-size:12px;line-height:1.5">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

export class StockAnalysisPanel extends Panel {
  constructor() {
    super({ id: 'stock-analysis', title: 'Premium Stock Analysis' });
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
    const tone = stockSignalTone(item.signal);
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
      <section style="border:1px solid var(--border);background:rgba(255,255,255,0.03);padding:14px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong style="font-size:16px;letter-spacing:-0.02em">${escapeHtml(item.name || item.symbol)}</strong>
              <span style="font-size:11px;color:var(--text-dim);font-family:monospace;text-transform:uppercase">${escapeHtml(item.display || item.symbol)}</span>
              <span style="font-size:11px;padding:3px 6px;border:1px solid ${tone};color:${tone};font-family:monospace;text-transform:uppercase;letter-spacing:0.08em">${escapeHtml(item.signal)}</span>
            </div>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim);line-height:1.5">${escapeHtml(item.summary)}</div>
          </div>
          <div style="text-align:right;min-width:110px">
            <div style="font-size:18px;font-weight:700">${escapeHtml(formatPrice(item.currentPrice, item.currency))}</div>
            <div style="font-size:12px;color:${item.changePercent >= 0 ? '#8df0b2' : '#ff8c8c'}">${escapeHtml(formatChange(item.changePercent))}</div>
            <div style="margin-top:6px;font-size:11px;color:var(--text-dim)">Score ${escapeHtml(String(item.signalScore))} · ${escapeHtml(item.confidence)}</div>
          </div>
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
            ${list(item.bullishFactors.slice(0, 3), '#8df0b2')}
          </div>
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim)">Risk Factors</div>
            ${list(item.riskFactors.slice(0, 3), '#ffb0b0')}
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
      </section>
    `;
  }
}
