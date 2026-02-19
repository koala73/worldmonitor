import type { AisDisruptionEvent, AirportDelayAlert, Port, Spaceport } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export function renderAisPopup(event: AisDisruptionEvent): string {
  const severityClass = escapeHtml(event.severity);
  const severityLabel = escapeHtml(event.severity.toUpperCase());
  const typeLabel = event.type === 'gap_spike' ? t('popups.aisGapSpike') : t('popups.chokepointCongestion');
  const changeLabel = event.type === 'gap_spike' ? t('popups.darkening') : t('popups.density');
  const countLabel = event.type === 'gap_spike' ? t('popups.darkShips') : t('popups.vesselCount');
  const countValue = event.type === 'gap_spike'
    ? event.darkShips?.toString() || '—'
    : event.vesselCount?.toString() || '—';

  return `
    <div class="popup-header ais">
      <span class="popup-title">${escapeHtml(event.name.toUpperCase())}</span>
      <span class="popup-badge ${severityClass}">${severityLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${typeLabel}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${changeLabel}</span>
          <span class="stat-value">${event.changePct}% ↑</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${countLabel}</span>
          <span class="stat-value">${countValue}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.window')}</span>
          <span class="stat-value">${event.windowHours}H</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.region')}</span>
          <span class="stat-value">${escapeHtml(event.region || `${event.lat.toFixed(2)}°, ${event.lon.toFixed(2)}°`)}</span>
        </div>
      </div>
      <p class="popup-description">${escapeHtml(event.description)}</p>
    </div>
  `;
}

export function renderFlightPopup(delay: AirportDelayAlert): string {
  const severityClass = escapeHtml(delay.severity);
  const severityLabel = escapeHtml(delay.severity.toUpperCase());
  const delayTypeLabels: Record<string, string> = {
    'ground_stop': t('popups.flight.groundStop'),
    'ground_delay': t('popups.flight.groundDelay'),
    'departure_delay': t('popups.flight.departureDelay'),
    'arrival_delay': t('popups.flight.arrivalDelay'),
    'general': t('popups.flight.delaysReported'),
  };
  const delayTypeLabel = delayTypeLabels[delay.delayType] || t('popups.flight.delays');
  const icon = delay.delayType === 'ground_stop' ? '🛑' : delay.severity === 'severe' ? '✈️' : '🛫';
  const sourceLabels: Record<string, string> = {
    'faa': t('popups.flight.sources.faa'),
    'eurocontrol': t('popups.flight.sources.eurocontrol'),
    'computed': t('popups.flight.sources.computed'),
  };
  const sourceLabel = sourceLabels[delay.source] || escapeHtml(delay.source);
  const regionLabels: Record<string, string> = {
    'americas': t('popups.flight.regions.americas'),
    'europe': t('popups.flight.regions.europe'),
    'apac': t('popups.flight.regions.apac'),
    'mena': t('popups.flight.regions.mena'),
    'africa': t('popups.flight.regions.africa'),
  };
  const regionLabel = regionLabels[delay.region] || escapeHtml(delay.region);

  const avgDelaySection = delay.avgDelayMinutes > 0
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.flight.avgDelay')}</span><span class="stat-value alert">+${delay.avgDelayMinutes} ${t('popups.timeUnits.m')}</span></div>`
    : '';
  const reasonSection = delay.reason
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.reason')}</span><span class="stat-value">${escapeHtml(delay.reason)}</span></div>`
    : '';
  const cancelledSection = delay.cancelledFlights
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.flight.cancelled')}</span><span class="stat-value alert">${delay.cancelledFlights} ${t('popups.events')}</span></div>`
    : '';

  return `
    <div class="popup-header flight ${severityClass}">
      <span class="popup-icon">${icon}</span>
      <span class="popup-title">${escapeHtml(delay.iata)} - ${delayTypeLabel}</span>
      <span class="popup-badge ${severityClass}">${severityLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(delay.name)}</div>
      <div class="popup-location">${escapeHtml(delay.city)}, ${escapeHtml(delay.country)}</div>
      <div class="popup-stats">
        ${avgDelaySection}
        ${reasonSection}
        ${cancelledSection}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.region')}</span>
          <span class="stat-value">${regionLabel}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.source')}</span>
          <span class="stat-value">${sourceLabel}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.updated')}</span>
          <span class="stat-value">${delay.updatedAt.toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderPortPopup(port: Port): string {
  const typeLabels: Record<string, string> = {
    container: t('popups.port.types.container'),
    oil: t('popups.port.types.oil'),
    lng: t('popups.port.types.lng'),
    naval: t('popups.port.types.naval'),
    mixed: t('popups.port.types.mixed'),
    bulk: t('popups.port.types.bulk'),
  };
  const typeColors: Record<string, string> = {
    container: 'elevated',
    oil: 'high',
    lng: 'high',
    naval: 'elevated',
    mixed: 'normal',
    bulk: 'low',
  };
  const typeIcons: Record<string, string> = {
    container: '🏭',
    oil: '🛢️',
    lng: '🔥',
    naval: '⚓',
    mixed: '🚢',
    bulk: '📦',
  };

  const rankSection = port.rank
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.port.worldRank')}</span><span class="stat-value">#${port.rank}</span></div>`
    : '';

  return `
    <div class="popup-header port ${escapeHtml(port.type)}">
      <span class="popup-icon">${typeIcons[port.type] || '🚢'}</span>
      <span class="popup-title">${escapeHtml(port.name.toUpperCase())}</span>
      <span class="popup-badge ${typeColors[port.type] || 'normal'}">${typeLabels[port.type] || port.type.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(port.country)}</div>
      <div class="popup-stats">
        ${rankSection}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${typeLabels[port.type] || port.type.toUpperCase()}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${port.lat.toFixed(2)}°, ${port.lon.toFixed(2)}°</span>
        </div>
      </div>
      <p class="popup-description">${escapeHtml(port.note)}</p>
    </div>
  `;
}

export function renderSpaceportPopup(port: Spaceport): string {
  const statusColors: Record<string, string> = {
    'active': 'elevated',
    'construction': 'high',
    'inactive': 'low',
  };
  const statusLabels: Record<string, string> = {
    'active': t('popups.spaceport.status.active'),
    'construction': t('popups.spaceport.status.construction'),
    'inactive': t('popups.spaceport.status.inactive'),
  };

  return `
    <div class="popup-header spaceport ${port.status}">
      <span class="popup-icon">🚀</span>
      <span class="popup-title">${escapeHtml(port.name.toUpperCase())}</span>
      <span class="popup-badge ${statusColors[port.status] || 'normal'}">${statusLabels[port.status] || port.status.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(port.operator)} • ${escapeHtml(port.country)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.spaceport.launchActivity')}</span>
          <span class="stat-value">${escapeHtml(port.launches.toUpperCase())}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${port.lat.toFixed(2)}°, ${port.lon.toFixed(2)}°</span>
        </div>
      </div>
      <p class="popup-description">${t('popups.spaceport.description')}</p>
    </div>
  `;
}
