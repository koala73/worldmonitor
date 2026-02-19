import type { Earthquake } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getTimeAgo } from './popup-helpers';

export function renderEarthquakePopup(earthquake: Earthquake): string {
  const severity = earthquake.magnitude >= 6 ? 'high' : earthquake.magnitude >= 5 ? 'medium' : 'low';
  const severityLabel = earthquake.magnitude >= 6 ? t('popups.earthquake.levels.major') : earthquake.magnitude >= 5 ? t('popups.earthquake.levels.moderate') : t('popups.earthquake.levels.minor');

  const timeAgo = getTimeAgo(earthquake.time);

  return `
    <div class="popup-header earthquake">
      <span class="popup-title magnitude">M${earthquake.magnitude.toFixed(1)}</span>
      <span class="popup-badge ${severity}">${severityLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <p class="popup-location">${escapeHtml(earthquake.place)}</p>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.depth')}</span>
          <span class="stat-value">${earthquake.depth.toFixed(1)} km</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${earthquake.lat.toFixed(2)}°, ${earthquake.lon.toFixed(2)}°</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.time')}</span>
          <span class="stat-value">${timeAgo}</span>
        </div>
      </div>
      <a href="${sanitizeUrl(earthquake.url)}" target="_blank" class="popup-link">${t('popups.viewUSGS')} →</a>
    </div>
  `;
}
