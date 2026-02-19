import type { APTGroup, CyberThreat } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export function renderAPTPopup(apt: APTGroup): string {
  return `
    <div class="popup-header apt">
      <span class="popup-title">${apt.name}</span>
      <span class="popup-badge high">${t('popups.threat')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${t('popups.aka')}: ${apt.aka}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.sponsor')}</span>
          <span class="stat-value">${apt.sponsor}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.origin')}</span>
          <span class="stat-value">${apt.lat.toFixed(1)}°, ${apt.lon.toFixed(1)}°</span>
        </div>
      </div>
      <p class="popup-description">${t('popups.apt.description')}</p>
    </div>
  `;
}

export function renderCyberThreatPopup(threat: CyberThreat): string {
  const severityClass = escapeHtml(threat.severity);
  const sourceLabels: Record<string, string> = {
    feodo: 'Feodo Tracker',
    urlhaus: 'URLhaus',
    c2intel: 'C2 Intel Feeds',
    otx: 'AlienVault OTX',
    abuseipdb: 'AbuseIPDB',
  };
  const sourceLabel = sourceLabels[threat.source] || threat.source;
  const typeLabel = threat.type.replace(/_/g, ' ').toUpperCase();
  const tags = (threat.tags || []).slice(0, 6);

  return `
    <div class="popup-header apt ${severityClass}">
      <span class="popup-title">${t('popups.cyberThreat.title')}</span>
      <span class="popup-badge ${severityClass}">${escapeHtml(threat.severity.toUpperCase())}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(typeLabel)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${escapeHtml(threat.indicatorType.toUpperCase())}</span>
          <span class="stat-value">${escapeHtml(threat.indicator)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.country')}</span>
          <span class="stat-value">${escapeHtml(threat.country || t('popups.unknown'))}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.source')}</span>
          <span class="stat-value">${escapeHtml(sourceLabel)}</span>
        </div>
        ${threat.malwareFamily ? `<div class="popup-stat">
          <span class="stat-label">${t('popups.malware')}</span>
          <span class="stat-value">${escapeHtml(threat.malwareFamily)}</span>
        </div>` : ''}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.lastSeen')}</span>
          <span class="stat-value">${escapeHtml(threat.lastSeen ? new Date(threat.lastSeen).toLocaleString() : t('popups.unknown'))}</span>
        </div>
      </div>
      ${tags.length > 0 ? `
      <div class="popup-tags">
        ${tags.map((tag) => `<span class="popup-tag">${escapeHtml(tag)}</span>`).join('')}
      </div>` : ''}
    </div>
  `;
}
