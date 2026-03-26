import type { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

let _client: EconomicServiceClient | null = null;
async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!_client) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

const COUNTRY_FLAGS: Record<string, string> = {
  US: '🇺🇸',
  GB: '🇬🇧',
  UK: '🇬🇧',
  EU: '🇪🇺',
  EUR: '🇪🇺',
  DE: '🇩🇪',
  FR: '🇫🇷',
  JP: '🇯🇵',
  CN: '🇨🇳',
  CA: '🇨🇦',
  AU: '🇦🇺',
};

const IMPACT_COLORS: Record<string, string> = {
  high: '#e74c3c',
  medium: '#f39c12',
  low: 'rgba(255,255,255,0.3)',
};

interface EconomicEvent {
  event: string;
  country: string;
  date: string;
  impact: string;
  actual: string;
  estimate: string;
  previous: string;
  unit: string;
}

function groupByDate(events: EconomicEvent[]): Map<string, EconomicEvent[]> {
  const map = new Map<string, EconomicEvent[]>();
  for (const ev of events) {
    const key = ev.date || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return map;
}

function formatDateGroup(dateStr: string): string {
  if (!dateStr || dateStr === 'Unknown') return 'Unknown';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtVal(val: string, unit: string): string {
  if (!val) return '—';
  return unit ? `${val} ${unit}` : val;
}

export class EconomicCalendarPanel extends Panel {
  private _hasData = false;
  private _events: EconomicEvent[] = [];

  constructor() {
    super({ id: 'economic-calendar', title: 'Economic Calendar', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading economic calendar...');
    try {
      const client = await getEconomicClient();
      const today = new Date();
      const fromDate = today.toISOString().slice(0, 10);
      const toDate = new Date(today.getTime() + 30 * 86400_000).toISOString().slice(0, 10);
      const resp = await client.getEconomicCalendar({ fromDate, toDate });

      if (resp.unavailable || !resp.events || resp.events.length === 0) {
        if (!this._hasData) this.showError('Economic calendar data unavailable.', () => void this.fetchData());
        return false;
      }

      this._events = resp.events as EconomicEvent[];
      this._hasData = true;
      this._render();
      return true;
    } catch (err) {
      if (this.isAbortError(err)) return false;
      if (!this._hasData) this.showError('Failed to load economic calendar.', () => void this.fetchData());
      return false;
    }
  }

  private _render(): void {
    if (!this._hasData || this._events.length === 0) {
      if (!this._hasData) this.showError('No upcoming economic events.', () => void this.fetchData());
      return;
    }

    const grouped = groupByDate(this._events);
    let bodyRows = '';
    let isFirstGroup = true;

    for (const [date, events] of grouped) {
      const borderTop = isFirstGroup ? '' : 'border-top:1px solid rgba(255,255,255,0.06);';
      isFirstGroup = false;

      bodyRows += `<tr>
        <td colspan="5" style="
          padding:10px 0 3px;
          font-size:10px;font-weight:600;
          color:rgba(255,255,255,0.35);
          text-transform:uppercase;letter-spacing:0.06em;
          ${borderTop}
        ">${escapeHtml(formatDateGroup(date))}</td>
      </tr>`;

      for (const ev of events) {
        const impact = (ev.impact || 'low').toLowerCase();
        const impactColor = IMPACT_COLORS[impact] ?? IMPACT_COLORS.low;
        const flag = COUNTRY_FLAGS[ev.country] ?? escapeHtml(ev.country);
        const isHigh = impact === 'high';
        const actual = escapeHtml(fmtVal(ev.actual, ev.unit));
        const estimate = escapeHtml(fmtVal(ev.estimate, ev.unit));
        const previous = escapeHtml(fmtVal(ev.previous, ev.unit));
        const actualColor = ev.actual ? 'color:var(--text)' : 'color:rgba(255,255,255,0.2)';
        const estColor = ev.estimate ? 'color:rgba(255,255,255,0.5)' : 'color:rgba(255,255,255,0.2)';
        const prevColor = ev.previous ? 'color:rgba(255,255,255,0.35)' : 'color:rgba(255,255,255,0.15)';

        bodyRows += `<tr style="font-size:12px;line-height:1.2">
          <td style="padding:4px 8px 4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0">
            <span style="margin-right:5px">${flag}</span><span style="font-weight:${isHigh ? 600 : 400}">${escapeHtml(ev.event)}</span>
          </td>
          <td style="padding:4px 6px;text-align:center;vertical-align:middle">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${impactColor};vertical-align:middle"></span>
          </td>
          <td style="padding:4px;text-align:right;font-variant-numeric:tabular-nums;${actualColor};white-space:nowrap">${actual}</td>
          <td style="padding:4px 0 4px 6px;text-align:right;font-variant-numeric:tabular-nums;${estColor};white-space:nowrap">${estimate}</td>
          <td style="padding:4px 0 4px 6px;text-align:right;font-variant-numeric:tabular-nums;${prevColor};white-space:nowrap">${previous}</td>
        </tr>`;
      }
    }

    const html = `<div style="padding:0 14px 12px;max-height:480px;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse;table-layout:fixed">
        <colgroup>
          <col style="width:auto">
          <col style="width:20px">
          <col style="width:52px">
          <col style="width:52px">
          <col style="width:52px">
        </colgroup>
        <thead>
          <tr style="font-size:9px;font-weight:600;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.06em">
            <th style="text-align:left;padding:0 8px 8px 0;font-weight:600">EVENT</th>
            <th style="padding:0 0 8px;font-weight:600"></th>
            <th style="text-align:right;padding:0 4px 8px;font-weight:600">ACT</th>
            <th style="text-align:right;padding:0 4px 8px;font-weight:600">EST</th>
            <th style="text-align:right;padding:0 0 8px 6px;font-weight:600">PREV</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;

    this.setContent(html);
  }
}
