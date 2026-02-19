import type { AIDataCenter } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { formatNumber } from './popup-helpers';

export interface DatacenterClusterData {
  items: AIDataCenter[];
  region: string;
  country: string;
  count?: number;
  totalChips?: number;
  totalPowerMW?: number;
  existingCount?: number;
  plannedCount?: number;
  sampled?: boolean;
}

export function renderDatacenterPopup(dc: AIDataCenter): string {
  const statusColors: Record<string, string> = {
    'existing': 'normal',
    'planned': 'elevated',
    'decommissioned': 'low',
  };
  const statusLabels: Record<string, string> = {
    'existing': t('popups.datacenter.status.existing'),
    'planned': t('popups.datacenter.status.planned'),
    'decommissioned': t('popups.datacenter.status.decommissioned'),
  };

  return `
    <div class="popup-header datacenter ${dc.status}">
      <span class="popup-title">🖥️ ${dc.name}</span>
      <span class="popup-badge ${statusColors[dc.status] || 'normal'}">${statusLabels[dc.status] || t('popups.datacenter.status.unknown')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${dc.owner} • ${dc.country}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.gpuChipCount')}</span>
          <span class="stat-value">${formatNumber(dc.chipCount)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.chipType')}</span>
          <span class="stat-value">${dc.chipType || t('popups.unknown')}</span>
        </div>
        ${dc.powerMW ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.power')}</span>
          <span class="stat-value">${dc.powerMW.toFixed(0)} MW</span>
        </div>
        ` : ''}
        ${dc.sector ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.sector')}</span>
          <span class="stat-value">${dc.sector}</span>
        </div>
        ` : ''}
      </div>
      ${dc.note ? `<p class="popup-description">${dc.note}</p>` : ''}
      <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
    </div>
  `;
}

export function renderDatacenterClusterPopup(data: DatacenterClusterData): string {
  const totalCount = data.count ?? data.items.length;
  const totalChips = data.totalChips ?? data.items.reduce((sum, dc) => sum + dc.chipCount, 0);
  const totalPower = data.totalPowerMW ?? data.items.reduce((sum, dc) => sum + (dc.powerMW || 0), 0);
  const existingCount = data.existingCount ?? data.items.filter(dc => dc.status === 'existing').length;
  const plannedCount = data.plannedCount ?? data.items.filter(dc => dc.status === 'planned').length;

  const dcListHtml = data.items.slice(0, 8).map(dc => `
    <div class="cluster-item">
      <span class="cluster-item-icon">${dc.status === 'planned' ? '🔨' : '🖥️'}</span>
      <div class="cluster-item-info">
        <span class="cluster-item-name">${escapeHtml(dc.name.slice(0, 40))}${dc.name.length > 40 ? '...' : ''}</span>
        <span class="cluster-item-detail">${escapeHtml(dc.owner)} • ${formatNumber(dc.chipCount)} ${t('popups.datacenter.chips')}</span>
      </div>
    </div>
  `).join('');

  return `
    <div class="popup-header datacenter cluster">
      <span class="popup-title">🖥️ ${t('popups.datacenter.cluster.title', { count: String(totalCount) })}</span>
      <span class="popup-badge elevated">${escapeHtml(data.region)}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(data.country)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.cluster.totalChips')}</span>
          <span class="stat-value">${formatNumber(totalChips)}</span>
        </div>
        ${totalPower > 0 ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.cluster.totalPower')}</span>
          <span class="stat-value">${totalPower.toFixed(0)} MW</span>
        </div>
        ` : ''}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.cluster.operational')}</span>
          <span class="stat-value">${existingCount}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.datacenter.cluster.planned')}</span>
          <span class="stat-value">${plannedCount}</span>
        </div>
      </div>
      <div class="cluster-list">
        ${dcListHtml}
      </div>
      ${totalCount > 8 ? `<p class="popup-more">${t('popups.datacenter.cluster.moreDataCenters', { count: String(Math.max(0, totalCount - 8)) })}</p>` : ''}
      ${data.sampled ? `<p class="popup-more">${t('popups.datacenter.cluster.sampledSites', { count: String(data.items.length) })}</p>` : ''}
      <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
    </div>
  `;
}
