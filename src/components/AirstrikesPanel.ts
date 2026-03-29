import { Panel } from './Panel';
import type { AirstrikeEvent } from '@/services/airstrikes';
import { isFeatureAvailable } from '@/services/runtime-config';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

const SUB_TYPE_LABELS: Record<string, string> = {
  'Drone': '🛸 Drone',
  'Airstrike': '✈ Airstrike',
  'Missile': '🚀 Missile',
  'Shelling': '💥 Shelling',
  'Loitering munition': '🛸 Loitering',
  'Air/drone strike': '✈ Air/Drone',
};

export class AirstrikesPanel extends Panel {
  private events: AirstrikeEvent[] = [];
  private unreadCount = 0;
  private onEventClick: ((lat: number, lon: number) => void) | null = null;

  constructor() {
    super({
      id: 'airstrikes',
      title: t('panels.airstrikes'),
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Air/drone strikes and missile attacks from ACLED (last 30 days). Requires ACLED API key + email in API Keys settings.',
    });
    this.showLoading('Fetching airstrike data…');

    this.element.addEventListener('click', () => {
      this.unreadCount = 0;
      this.setCount(this.events.length);
    });
  }

  public setEventClickHandler(fn: (lat: number, lon: number) => void): void {
    this.onEventClick = fn;
  }

  public update(events: AirstrikeEvent[]): void {
    const prevIds = new Set(this.events.map(e => e.id));
    const fresh = events.filter(e => !prevIds.has(e.id));
    this.unreadCount += fresh.length;

    // Merge + dedupe by id, newest-first (already sorted from ACLED), cap at 200
    const merged = new Map<string, AirstrikeEvent>();
    for (const e of this.events) merged.set(e.id, e);
    for (const e of events) merged.set(e.id, e);
    this.events = [...merged.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 200);

    this.setCount(this.events.length);
    if (fresh.length > 0) this.setNewBadge(fresh.length);
    this.render();
  }

  public getEvents(): AirstrikeEvent[] {
    return this.events;
  }

  public onActivate(): void {
    this.unreadCount = 0;
    this.setCount(this.events.length);
  }

  private render(): void {
    if (!isFeatureAvailable('acledAirstrikes') && this.events.length === 0) {
      this.setContent(`
        <div class="panel-empty" style="padding:16px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">🚀</div>
          <div style="font-weight:600;margin-bottom:4px">Air Strikes & Drones</div>
          <div style="font-size:11px;color:var(--text-dim)">Configure ACLED API key and registered email in <strong>API Keys</strong> settings to enable this panel.</div>
        </div>
      `);
      return;
    }

    if (this.events.length === 0) {
      this.setContent(`<div class="panel-empty">No air strike events in the last 30 days.</div>`);
      return;
    }

    const rows = this.events.map(e => {
      const typeLabel = (SUB_TYPE_LABELS[e.subEventType] ?? SUB_TYPE_LABELS[e.eventType] ?? e.subEventType) || e.eventType;
      const pillClass = e.subEventType.toLowerCase().includes('drone') || e.subEventType.toLowerCase().includes('loiter')
        ? 'as-pill-drone'
        : (e.subEventType.toLowerCase().includes('missile')
        ? 'as-pill-missile'
        : 'as-pill-air');
      const fatBadge = e.fatalities > 0
        ? `<span class="as-fatalities">${e.fatalities}✝</span>`
        : '';
      const locationStr = escapeHtml([e.location, e.region, e.country].filter(Boolean).join(', '));
      const actorStr = escapeHtml(e.actor || '—');
      const targetStr = e.targetActor ? ` → ${escapeHtml(e.targetActor)}` : '';
      const coordsAttr = `data-lat="${e.lat}" data-lon="${e.lon}"`;

      return `<div class="as-row" role="button" tabindex="0" ${coordsAttr}>
        <div class="as-row-header">
          <span class="as-pill ${pillClass}">${typeLabel}</span>
          <span class="as-date">${e.date}</span>
          ${fatBadge}
        </div>
        <div class="as-location">${locationStr}</div>
        <div class="as-actor">${actorStr}${targetStr}</div>
        ${e.notes ? `<div class="as-notes">${escapeHtml(e.notes.slice(0, 200))}${e.notes.length > 200 ? '…' : ''}</div>` : ''}
      </div>`;
    }).join('');

    const html = `<div class="as-list">${rows}</div>`;
    this.setContent(html);

    // Wire click-to-fly handlers
    this.getContentElement().querySelectorAll<HTMLElement>('.as-row[data-lat]').forEach(row => {
      row.addEventListener('click', () => {
        const lat = Number.parseFloat(row.dataset.lat ?? '0');
        const lon = Number.parseFloat(row.dataset.lon ?? '0');
        if (!isNaN(lat) && !isNaN(lon) && this.onEventClick) {
          this.onEventClick(lat, lon);
        }
      });
    });
  }
}
