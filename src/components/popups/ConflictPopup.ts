import type { ConflictZone } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export function renderConflictPopup(conflict: ConflictZone): string {
  const severityClass = conflict.intensity === 'high' ? 'high' : conflict.intensity === 'medium' ? 'medium' : 'low';
  const severityLabel = escapeHtml(conflict.intensity?.toUpperCase() || t('popups.unknown').toUpperCase());

  return `
    <div class="popup-header conflict">
      <span class="popup-title">${escapeHtml(conflict.name.toUpperCase())}</span>
      <span class="popup-badge ${severityClass}">${severityLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.startDate')}</span>
          <span class="stat-value">${escapeHtml(conflict.startDate || t('popups.unknown'))}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.casualties')}</span>
          <span class="stat-value">${escapeHtml(conflict.casualties || t('popups.unknown'))}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.displaced')}</span>
          <span class="stat-value">${escapeHtml(conflict.displaced || t('popups.unknown'))}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.location')}</span>
          <span class="stat-value">${escapeHtml(conflict.location || `${conflict.center[1]}°N, ${conflict.center[0]}°E`)}</span>
        </div>
      </div>
      ${conflict.description ? `<p class="popup-description">${escapeHtml(conflict.description)}</p>` : ''}
      ${conflict.parties && conflict.parties.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.belligerents')}</span>
          <div class="popup-tags">
            ${conflict.parties.map(p => `<span class="popup-tag">${escapeHtml(p)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${conflict.keyDevelopments && conflict.keyDevelopments.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.keyDevelopments')}</span>
          <ul class="popup-list">
            ${conflict.keyDevelopments.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  `;
}
