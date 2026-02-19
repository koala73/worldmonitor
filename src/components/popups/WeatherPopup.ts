import type { WeatherAlert } from '@/services/weather';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getTimeUntil } from './popup-helpers';

export function renderWeatherPopup(alert: WeatherAlert): string {
  const severityClass = escapeHtml(alert.severity.toLowerCase());
  const expiresIn = getTimeUntil(alert.expires);

  return `
    <div class="popup-header weather ${severityClass}">
      <span class="popup-title">${escapeHtml(alert.event.toUpperCase())}</span>
      <span class="popup-badge ${severityClass}">${escapeHtml(alert.severity.toUpperCase())}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <p class="popup-headline">${escapeHtml(alert.headline)}</p>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.area')}</span>
          <span class="stat-value">${escapeHtml(alert.areaDesc)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.expires')}</span>
          <span class="stat-value">${expiresIn}</span>
        </div>
      </div>
      <p class="popup-description">${escapeHtml(alert.description.slice(0, 300))}${alert.description.length > 300 ? '...' : ''}</p>
    </div>
  `;
}
