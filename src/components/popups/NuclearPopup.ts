import type { NuclearFacility, GammaIrradiator } from '@/types';
import { t } from '@/services/i18n';

export function renderNuclearPopup(facility: NuclearFacility): string {
  const typeLabels: Record<string, string> = {
    'plant': t('popups.nuclear.types.plant'),
    'enrichment': t('popups.nuclear.types.enrichment'),
    'weapons': t('popups.nuclear.types.weapons'),
    'research': t('popups.nuclear.types.research'),
  };
  const statusColors: Record<string, string> = {
    'active': 'elevated',
    'contested': 'high',
    'decommissioned': 'low',
  };

  return `
    <div class="popup-header nuclear">
      <span class="popup-title">${facility.name.toUpperCase()}</span>
      <span class="popup-badge ${statusColors[facility.status] || 'low'}">${facility.status.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${typeLabels[facility.type] || facility.type.toUpperCase()}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.status')}</span>
          <span class="stat-value">${facility.status.toUpperCase()}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${facility.lat.toFixed(2)}°, ${facility.lon.toFixed(2)}°</span>
        </div>
      </div>
      <p class="popup-description">${t('popups.nuclear.description')}</p>
    </div>
  `;
}

export function renderIrradiatorPopup(irradiator: GammaIrradiator): string {
  return `
    <div class="popup-header irradiator">
      <span class="popup-title">☢ ${irradiator.city.toUpperCase()}</span>
      <span class="popup-badge elevated">${t('popups.gamma')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${t('popups.irradiator.subtitle')}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.country')}</span>
          <span class="stat-value">${irradiator.country}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.city')}</span>
          <span class="stat-value">${irradiator.city}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${irradiator.lat.toFixed(2)}°, ${irradiator.lon.toFixed(2)}°</span>
        </div>
      </div>
      <p class="popup-description">${t('popups.irradiator.description')}</p>
    </div>
  `;
}
