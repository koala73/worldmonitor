import type { CriticalMineralProject } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export function renderMineralPopup(mine: CriticalMineralProject): string {
  const statusColors: Record<string, string> = {
    'producing': 'elevated',
    'development': 'high',
    'exploration': 'low',
  };
  const statusLabels: Record<string, string> = {
    'producing': t('popups.mineral.status.producing'),
    'development': t('popups.mineral.status.development'),
    'exploration': t('popups.mineral.status.exploration'),
  };

  // Icon based on mineral type
  const icon = mine.mineral === 'Lithium' ? '🔋' : mine.mineral === 'Rare Earths' ? '🧲' : '💎';

  return `
    <div class="popup-header mineral ${mine.status}">
      <span class="popup-icon">${icon}</span>
      <span class="popup-title">${escapeHtml(mine.name.toUpperCase())}</span>
      <span class="popup-badge ${statusColors[mine.status] || 'normal'}">${statusLabels[mine.status] || mine.status.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${t('popups.mineral.projectSubtitle', { mineral: escapeHtml(mine.mineral.toUpperCase()) })}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.operator')}</span>
          <span class="stat-value">${escapeHtml(mine.operator)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.country')}</span>
          <span class="stat-value">${escapeHtml(mine.country)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${mine.lat.toFixed(2)}°, ${mine.lon.toFixed(2)}°</span>
        </div>
      </div>
      <p class="popup-description">${escapeHtml(mine.significance)}</p>
    </div>
  `;
}
