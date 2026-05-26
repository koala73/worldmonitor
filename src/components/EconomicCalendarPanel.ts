import type { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
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
  EA: '🇪🇺',
  DE: '🇩🇪',
  FR: '🇫🇷',
  JP: '🇯🇵',
  CN: '🇨🇳',
  CA: '🇨🇦',
  AU: '🇦🇺',
};

const EU_COUNTRIES = new Set(['EU', 'EA', 'EUR', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PT', 'FI', 'IE', 'GR']);

type RegionFilter = 'all' | 'us' | 'eu';

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

function countdown(dateStr: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return Math.abs(days) < 14 ? `${Math.abs(days)}d ago` : `${Math.round(Math.abs(days) / 7)}w ago`;
  if (days < 14) return `in ${days}d`;
  return `in ${Math.round(days / 7)}w`;
}

export class EconomicCalendarPanel extends Panel {
  private _hasData = false;
  private _events: EconomicEvent[] = [];
  private _region: RegionFilter = 'all';

  constructor() {
    super({ id: 'economic-calendar', title: 'Economic Calendar', showCount: false, infoTooltip: t('components.economicCalendar.infoTooltip') });
    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-region]');
      if (!btn) return;
      const region = btn.dataset.region as RegionFilter;
      if (region && region !== this._region) {
        this._region = region;
        this._render();
      }
    });
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

  private _filterEvents(): EconomicEvent[] {
    if (this._region === 'us') return this._events.filter((e) => e.country === 'US');
    if (this._region === 'eu') return this._events.filter((e) => EU_COUNTRIES.has(e.country));
    return this._events;
  }

  private _renderRegionTabs(): string {
    const tabs: { key: RegionFilter; label: string }[] = [
      { key: 'all', label: 'All' },
      { key: 'us',  label: 'US' },
      { key: 'eu',  label: 'EU' },
    ];
    return `<div style="display:flex;gap:4px;padding:0 14px 10px">` +
      tabs.map(({ key, label }) => {
        const active = this._region === key;
        return `<button data-region="${key}" style="
          padding:3px 10px;font-size:10px;font-weight:600;letter-spacing:0.04em;
          border-radius:3px;border:none;cursor:pointer;
          background:${active ? 'rgba(255,255,255,0.15)' : 'transparent'};
          color:${active ? 'var(--text)' : 'rgba(255,255,255,0.35)'};
        ">${escapeHtml(label)}</button>`;
      }).join('') +
    `</div>`;
  }

  private _render(): void {
    if (!this._hasData) {
      this.showError('No upcoming economic events.', () => void this.fetchData());
      return;
    }

    const filtered = this._filterEvents();
    const grouped = groupByDate(filtered);
    let bodyRows = '';
    let isFirstGroup = true;

    for (const [date, events] of grouped) {
      const borderTop = isFirstGroup ? '' : 'border-top:1px solid rgba(255,255,255,0.06);';
      isFirstGroup = false;

      bodyRows += `<tr>
        <td colspan="3" style="
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

        // Right column: actual value when released, countdown otherwise
        let rightLabel: string;
        let rightStyle: string;
        if (ev.actual) {
          rightLabel = escapeHtml(fmtVal(ev.actual, ev.unit));
          rightStyle = 'color:var(--text);font-weight:600';
        } else {
          rightLabel = escapeHtml(countdown(ev.date));
          rightStyle = 'color:rgba(255,255,255,0.35);font-style:italic';
        }

        bodyRows += `<tr style="font-size:12px;line-height:1.2">
          <td style="padding:4px 8px 4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0">
            <span style="margin-right:5px">${flag}</span><span style="font-weight:${isHigh ? 600 : 400}">${escapeHtml(ev.event)}</span>
          </td>
          <td style="padding:4px 6px;text-align:center;vertical-align:middle">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${impactColor};vertical-align:middle"></span>
          </td>
          <td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums;${rightStyle};white-space:nowrap">${rightLabel}</td>
        </tr>`;
      }
    }

    const emptyMsgText = this._region === 'all'
      ? 'No upcoming economic events'
      : 'No events for selected region';
    const emptyMsg = filtered.length === 0
      ? `<tr><td colspan="3" style="padding:20px 0;text-align:center;color:rgba(255,255,255,0.3);font-size:12px">${escapeHtml(emptyMsgText)}</td></tr>`
      : '';

    const html = `${this._renderRegionTabs()}<div style="padding:0 14px 12px;max-height:440px;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse;table-layout:fixed">
        <colgroup>
          <col style="width:auto">
          <col style="width:20px">
          <col style="width:64px">
        </colgroup>
        <thead>
          <tr style="font-size:9px;font-weight:600;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.06em">
            <th style="text-align:left;padding:0 8px 8px 0;font-weight:600">EVENT</th>
            <th style="padding:0 0 8px;font-weight:600"></th>
            <th style="text-align:right;padding:0 0 8px;font-weight:600"></th>
          </tr>
        </thead>
        <tbody>${emptyMsg}${bodyRows}</tbody>
      </table>
    </div>`;

    this.setContent(html);
  }
}
