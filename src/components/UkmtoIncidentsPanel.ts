import { Panel } from './Panel';
import { safeHtml, joinSafeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { UKMTO_SOURCE_URL } from '../../shared/ukmto-incidents';
import type { ListUkmtoIncidentsResponse } from '@/generated/client/worldmonitor/maritime/v1/service_client';
import './ukmto-incidents.css';

export class UkmtoIncidentsPanel extends Panel {
  private snapshot: ListUkmtoIncidentsResponse = { incidents: [], fetchedAt: 0, dataAvailable: false, stale: false };
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    super({ id: 'ukmto-incidents', title: t('panels.ukmtoIncidents'), showCount: true });
    this.content.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
      const incident = this.snapshot.incidents.find(item => item.id === target?.dataset.id);
      if (incident?.location) this.onLocationClick?.(incident.location.latitude, incident.location.longitude);
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public setData(snapshot: ListUkmtoIncidentsResponse): void {
    this.snapshot = snapshot;
    this.setCount(snapshot.incidents.length);
    const date = (value: number) => new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    this.setSafeContent(safeHtml`
      <div class="ukmto-status" role="status">${!snapshot.dataAvailable ? t('ukmto.unavailable') : snapshot.stale ? t('ukmto.stale') : t('ukmto.current')}
        ${snapshot.fetchedAt ? date(snapshot.fetchedAt) : ''}</div>
      <p class="ukmto-attribution"><a href="${UKMTO_SOURCE_URL}" target="_blank" rel="noopener noreferrer">UKMTO</a> · ${t('ukmto.reportedClaims')}</p>
      ${snapshot.dataAvailable && snapshot.incidents.length === 0 ? safeHtml`<div class="panel-empty">${t('ukmto.empty')}</div>` : ''}
      <div class="ukmto-list">${joinSafeHtml(snapshot.incidents.map(item => safeHtml`
        <article class="ukmto-incident">
          <button type="button" data-id="${item.id}" class="ukmto-location">UKMTO ${item.incidentNumber} · ${item.incidentType} · ${item.place}</button>
          <div class="ukmto-dates">${t('ukmto.occurred')}: ${date(item.occurredAt)}<br>${t('ukmto.reported')}: ${date(item.reportedAt)}</div>
          <p>${item.description}</p>
        </article>`))}</div>`);
  }
}
