import type {
  IntelligenceServiceClient,
  MaterialEvent,
  MaterialEventItem,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { Panel } from './Panel';
import { getLocale } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';

/**
 * SEC material events (#6429) — the first dashboard surface over the 8-K
 * stream the backend has seeded and served (scripts/seed-sec-8k-stream.mjs →
 * listMaterialEvents) since #5695 with no renderer at all. Deliberately a
 * thin list: company, form + item-code badge, item description, filing time,
 * and an origin-locked link to the filing index. Default-off in every
 * variant, like earnings-calendar — enabling it is a product decision.
 */

let _client: IntelligenceServiceClient | null = null;
async function getIntelligenceClient(): Promise<IntelligenceServiceClient> {
  if (!_client) {
    const { IntelligenceServiceClient } = await import('@/generated/client/worldmonitor/intelligence/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

const EVENT_LIMIT = 30;

export interface ProjectedMaterialEvent {
  company: string;
  form: string;
  filedAtMs: number;
  items: MaterialEventItem[];
  url: string;
}

/**
 * Filing links come from a seeded Redis blob, not from code this bundle
 * controls — so only canonical https sec.gov URLs may render as anchors.
 * Everything else (other origins, downgraded schemes, lookalike hosts,
 * javascript:) renders as plain text.
 */
export function secArchiveUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'www.sec.gov' && parsed.hostname !== 'sec.gov') return null;
    return url;
  } catch {
    return null;
  }
}

/** Newest-first, identity-bearing rows only, items always an array. */
export function projectMaterialEvents(events: readonly MaterialEvent[]): ProjectedMaterialEvent[] {
  return events
    .filter((event) => Boolean(event.company || event.cik))
    .map((event) => ({
      company: event.company || `CIK ${event.cik}`,
      form: event.form || '8-K',
      filedAtMs: Number.isFinite(event.filedAtMs) ? event.filedAtMs : 0,
      items: Array.isArray(event.items) ? event.items : [],
      url: event.url,
    }))
    .sort((a, b) => b.filedAtMs - a.filedAtMs);
}

/** A time for same-day filings, a date for older ones, '' when unusable. */
export function filedAtLabel(filedAtMs: number, nowMs: number, locale: string): string {
  if (!Number.isFinite(filedAtMs) || filedAtMs <= 0) return '';
  const filed = new Date(filedAtMs);
  const now = new Date(nowMs);
  const sameDay = filed.getFullYear() === now.getFullYear()
    && filed.getMonth() === now.getMonth()
    && filed.getDate() === now.getDate();
  return sameDay
    ? filed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : filed.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function renderMaterialEvent(event: ProjectedMaterialEvent, nowMs: number, locale: string): string {
  const primary = event.items[0];
  const extraItems = event.items.length > 1 ? ` +${event.items.length - 1}` : '';
  const link = secArchiveUrl(event.url);
  const company = escapeHtml(event.company);
  const companyHtml = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="color:var(--text);text-decoration:none">${company}</a>`
    : company;
  const timeLabel = filedAtLabel(event.filedAtMs, nowMs, locale);

  return `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;padding-top:1px">
        <span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));font-weight:700;padding:2px 5px;border-radius:3px;background:rgba(52,152,219,0.15);color:#3498db;letter-spacing:0.04em">${escapeHtml(event.form)}</span>
        ${primary ? `<span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));font-weight:700;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.08);color:var(--text-dim)">${escapeHtml(primary.code)}${escapeHtml(extraItems)}</span>` : ''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${companyHtml}</div>
        ${primary ? `<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(primary.description)}</div>` : ''}
      </div>
      ${timeLabel ? `<div style="flex-shrink:0;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);padding-top:1px">${escapeHtml(timeLabel)}</div>` : ''}
    </div>`;
}

export class MaterialEventsPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({
      id: 'material-events',
      title: 'SEC Material Events',
      showCount: false,
      infoTooltip: 'Recent SEC 8-K material-event filings across all filers — item codes flag what happened (e.g. 5.02 executive departures, 2.02 results, 1.01 material agreements). Links open the filing index on sec.gov.',
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getIntelligenceClient();
      const resp = await client.listMaterialEvents({ itemCode: '', limit: EVENT_LIMIT });

      const events = projectMaterialEvents(resp.events ?? []);
      if (resp.unavailable || events.length === 0) {
        if (!this._hasData) this.showError('No recent SEC material events', () => void this.fetchData());
        return false;
      }

      this.render(events);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load SEC material events', () => void this.fetchData());
      return false;
    }
  }

  private render(events: ProjectedMaterialEvent[]): void {
    this._hasData = true;
    const now = Date.now();
    const locale = getLocale();
    const html = `
      <div style="padding:0 14px 12px;max-height:480px;overflow-y:auto">
        ${events.map((event) => renderMaterialEvent(event, now, locale)).join('')}
      </div>`;
    this.setSafeContent(unsafeRawHtml(html, 'material-events controlled panel markup — every dynamic field passes escapeHtml'));
  }
}
