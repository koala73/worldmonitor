import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

let _client: MarketServiceClient | null = null;
async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_client) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

interface EarningsEntry {
  symbol: string;
  company: string;
  date: string;
  hour: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  hasActuals: boolean;
  surpriseDirection: string;
}

function fmtEps(v: number | null): string {
  if (v == null) return '';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function fmtRevenue(v: number | null): string {
  if (v == null || v <= 0) return '';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  return `$${v}`;
}

function surprisePct(actual: number | null, estimate: number | null): string {
  if (actual == null || estimate == null || estimate === 0) return '';
  const pct = ((actual - estimate) / Math.abs(estimate)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function dateLabel(dateStr: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const formatted = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (days === 0) return `TODAY · ${formatted}`;
  if (days === 1) return `TOMORROW · ${formatted}`;
  return formatted.toUpperCase().replace(',', ' ·');
}

function renderEntry(e: EarningsEntry): string {
  const hourLabel = e.hour === 'bmo' ? 'BMO' : e.hour === 'amc' ? 'AMC' : e.hour ? e.hour.toUpperCase() : '';
  const hourStyle = e.hour === 'bmo'
    ? 'background:rgba(46,204,113,0.15);color:#2ecc71'
    : e.hour === 'amc'
      ? 'background:rgba(52,152,219,0.15);color:#3498db'
      : 'background:rgba(255,255,255,0.08);color:var(--text-dim)';

  const revEstFmt = fmtRevenue(e.revenueEstimate);
  const revActFmt = fmtRevenue(e.revenueActual);
  const epsEstFmt = fmtEps(e.epsEstimate);
  const epsActFmt = fmtEps(e.epsActual);

  // EPS section: show actual+badge if reported, else estimate
  let epsHtml = '';
  if (e.hasActuals && epsActFmt) {
    const badgeStyle = e.surpriseDirection === 'beat'
      ? 'background:rgba(46,204,113,0.2);color:#2ecc71'
      : e.surpriseDirection === 'miss'
        ? 'background:rgba(231,76,60,0.2);color:#e74c3c'
        : 'background:rgba(255,255,255,0.08);color:var(--text-dim)';
    const badgeLabel = e.surpriseDirection === 'beat' ? 'BEAT' : e.surpriseDirection === 'miss' ? 'MISS' : 'IN LINE';
    const pct = surprisePct(e.epsActual, e.epsEstimate);
    epsHtml = `
      <span style="font-size:11px;font-weight:600;color:var(--text)">EPS ${escapeHtml(epsActFmt)}</span>
      <span style="font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;${badgeStyle}">${escapeHtml(badgeLabel)}${pct ? ` ${escapeHtml(pct)}` : ''}</span>`;
  } else if (epsEstFmt) {
    epsHtml = `<span style="font-size:11px;color:var(--text-dim)">EPS est ${escapeHtml(epsEstFmt)}</span>`;
  }

  // Revenue section
  let revHtml = '';
  if (e.hasActuals && revActFmt) {
    revHtml = `<span style="font-size:10px;color:var(--text-dim)">${escapeHtml(revActFmt)} rev</span>`;
  } else if (revEstFmt) {
    revHtml = `<span style="font-size:10px;color:rgba(255,255,255,0.25)">${escapeHtml(revEstFmt)} est</span>`;
  }

  return `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;padding-top:1px">
        ${hourLabel ? `<span style="font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;${hourStyle};letter-spacing:0.04em">${escapeHtml(hourLabel)}</span>` : ''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.company)}</div>
        <div style="font-size:10px;color:var(--text-dim);letter-spacing:0.04em">${escapeHtml(e.symbol)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">
        ${epsHtml ? `<div style="display:flex;align-items:center;gap:5px">${epsHtml}</div>` : ''}
        ${revHtml ? `<div>${revHtml}</div>` : ''}
      </div>
    </div>`;
}

function renderGroup(date: string, entries: EarningsEntry[], isFirst: boolean): string {
  const borderStyle = isFirst ? '' : 'border-top:1px solid rgba(255,255,255,0.06);';
  return `
    <div style="${borderStyle}padding-top:${isFirst ? '0' : '10'}px;padding-bottom:2px">
      <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.06em;padding:0 0 5px">${escapeHtml(dateLabel(date))}</div>
      ${entries.map(renderEntry).join('')}
    </div>`;
}

export class EarningsCalendarPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'earnings-calendar', title: 'Earnings Calendar', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    return this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<boolean> {
    try {
      const client = await getMarketClient();
      const today = new Date();
      const future = new Date();
      future.setDate(future.getDate() + 14);
      const fromDate = today.toISOString().slice(0, 10);
      const toDate = future.toISOString().slice(0, 10);
      const resp = await client.listEarningsCalendar({ fromDate, toDate });

      if (resp.unavailable || !resp.earnings?.length) {
        if (!this._hasData) this.showError('No earnings data', () => void this.fetchData());
        return false;
      }

      this.render(resp.earnings as EarningsEntry[]);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(earnings: EarningsEntry[]): void {
    this._hasData = true;

    const grouped = new Map<string, EarningsEntry[]>();
    for (const e of earnings) {
      const key = e.date || 'Unknown';
      const arr = grouped.get(key);
      if (arr) arr.push(e);
      else grouped.set(key, [e]);
    }

    const sortedDates = [...grouped.keys()].sort();

    const html = `
      <div style="padding:0 14px 12px;max-height:480px;overflow-y:auto">
        ${sortedDates.map((d, i) => renderGroup(d, grouped.get(d)!, i === 0)).join('')}
      </div>`;

    this.setContent(html);
  }
}
