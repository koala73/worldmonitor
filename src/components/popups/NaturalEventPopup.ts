import type { NaturalEvent } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getNaturalEventIcon } from '@/services/eonet';
import { getTimeAgo } from './popup-helpers';

export function renderNaturalEventPopup(event: NaturalEvent): string {
  const categoryColors: Record<string, string> = {
    severeStorms: 'high',
    wildfires: 'high',
    volcanoes: 'high',
    earthquakes: 'elevated',
    floods: 'elevated',
    landslides: 'elevated',
    drought: 'medium',
    dustHaze: 'low',
    snow: 'low',
    tempExtremes: 'elevated',
    seaLakeIce: 'low',
    waterColor: 'low',
    manmade: 'elevated',
  };
  const icon = getNaturalEventIcon(event.category);
  const severityClass = categoryColors[event.category] || 'low';
  const timeAgo = getTimeAgo(event.date);

  return `
    <div class="popup-header nat-event ${event.category}">
      <span class="popup-icon">${icon}</span>
      <span class="popup-title">${escapeHtml(event.categoryTitle.toUpperCase())}</span>
      <span class="popup-badge ${severityClass}">${event.closed ? t('popups.naturalEvent.closed') : t('popups.naturalEvent.active')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(event.title)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.naturalEvent.reported')}</span>
          <span class="stat-value">${timeAgo}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${event.lat.toFixed(2)}°, ${event.lon.toFixed(2)}°</span>
        </div>
        ${event.magnitude ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.magnitude')}</span>
          <span class="stat-value">${event.magnitude}${event.magnitudeUnit ? ` ${escapeHtml(event.magnitudeUnit)}` : ''}</span>
        </div>
        ` : ''}
        ${event.sourceName ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.source')}</span>
          <span class="stat-value">${escapeHtml(event.sourceName)}</span>
        </div>
        ` : ''}
      </div>
      ${event.description ? `<p class="popup-description">${escapeHtml(event.description)}</p>` : ''}
      ${event.sourceUrl ? `<a href="${sanitizeUrl(event.sourceUrl)}" target="_blank" class="popup-link">${t('popups.naturalEvent.viewOnSource', { source: escapeHtml(event.sourceName || t('popups.source')) })} →</a>` : ''}
      <div class="popup-attribution">${t('popups.naturalEvent.attribution')}</div>
    </div>
  `;
}
