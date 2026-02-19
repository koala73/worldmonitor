import type { Pipeline, UnderseaCable, CableAdvisory, RepairShip, InternetOutage } from '@/types';
import { UNDERSEA_CABLES } from '@/config';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getTimeAgo } from './popup-helpers';

export function renderPipelinePopup(pipeline: Pipeline): string {
  const typeLabels: Record<string, string> = {
    'oil': t('popups.pipeline.types.oil'),
    'gas': t('popups.pipeline.types.gas'),
    'products': t('popups.pipeline.types.products'),
  };
  const typeColors: Record<string, string> = {
    'oil': 'high',
    'gas': 'elevated',
    'products': 'low',
  };
  const statusLabels: Record<string, string> = {
    'operating': t('popups.pipeline.status.operating'),
    'construction': t('popups.pipeline.status.construction'),
  };
  const typeIcon = pipeline.type === 'oil' ? '🛢' : pipeline.type === 'gas' ? '🔥' : '⛽';

  return `
    <div class="popup-header pipeline ${pipeline.type}">
      <span class="popup-title">${typeIcon} ${pipeline.name.toUpperCase()}</span>
      <span class="popup-badge ${typeColors[pipeline.type] || 'low'}">${pipeline.type.toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${typeLabels[pipeline.type] || t('popups.pipeline.title')}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.status')}</span>
          <span class="stat-value">${statusLabels[pipeline.status] || pipeline.status.toUpperCase()}</span>
        </div>
        ${pipeline.capacity ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.capacity')}</span>
          <span class="stat-value">${pipeline.capacity}</span>
        </div>
        ` : ''}
        ${pipeline.length ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.length')}</span>
          <span class="stat-value">${pipeline.length}</span>
        </div>
        ` : ''}
        ${pipeline.operator ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.operator')}</span>
          <span class="stat-value">${pipeline.operator}</span>
        </div>
        ` : ''}
      </div>
      ${pipeline.countries && pipeline.countries.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.countries')}</span>
          <div class="popup-tags">
            ${pipeline.countries.map(c => `<span class="popup-tag">${c}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      <p class="popup-description">${t('popups.pipeline.description', { type: pipeline.type, status: pipeline.status === 'operating' ? t('popups.pipelineStatusDesc.operating') : t('popups.pipelineStatusDesc.construction') })}</p>
    </div>
  `;
}

export function renderCablePopup(cable: UnderseaCable, cableAdvisories: CableAdvisory[], repairShips: RepairShip[]): string {
  const advisory = getLatestCableAdvisory(cable.id, cableAdvisories);
  const repairShip = getPriorityRepairShip(cable.id, repairShips);
  const statusLabel = advisory ? (advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded')) : t('popups.cable.active');
  const statusBadge = advisory ? (advisory.severity === 'fault' ? 'high' : 'elevated') : 'low';
  const repairEta = repairShip?.eta || advisory?.repairEta;
  const cableName = escapeHtml(cable.name.toUpperCase());
  const safeStatusLabel = escapeHtml(statusLabel);
  const safeRepairEta = repairEta ? escapeHtml(repairEta) : '';
  const advisoryTitle = advisory ? escapeHtml(advisory.title) : '';
  const advisoryImpact = advisory ? escapeHtml(advisory.impact) : '';
  const advisoryDescription = advisory ? escapeHtml(advisory.description) : '';
  const repairShipName = repairShip ? escapeHtml(repairShip.name) : '';
  const repairShipNote = repairShip ? escapeHtml(repairShip.note || t('popups.repairShip.note')) : '';

  return `
    <div class="popup-header cable">
      <span class="popup-title">🌐 ${cableName}</span>
      <span class="popup-badge ${statusBadge}">${cable.major ? t('popups.cable.major') : t('popups.cable.cable')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${t('popups.cable.subtitle')}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${t('popups.cable.type')}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.waypoints')}</span>
          <span class="stat-value">${cable.points.length}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.status')}</span>
          <span class="stat-value">${safeStatusLabel}</span>
        </div>
        ${repairEta ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.repairEta')}</span>
          <span class="stat-value">${safeRepairEta}</span>
        </div>
        ` : ''}
      </div>
      ${advisory ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.cable.advisory')}</span>
          <div class="popup-tags">
            <span class="popup-tag">${advisoryTitle}</span>
            <span class="popup-tag">${advisoryImpact}</span>
          </div>
          <p class="popup-description">${advisoryDescription}</p>
        </div>
      ` : ''}
      ${repairShip ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.cable.repairDeployment')}</span>
          <div class="popup-tags">
            <span class="popup-tag">${repairShipName}</span>
            <span class="popup-tag">${repairShip.status === 'on-station' ? t('popups.cable.repairStatus.onStation') : t('popups.cable.repairStatus.enRoute')}</span>
          </div>
          <p class="popup-description">${repairShipNote}</p>
        </div>
      ` : ''}
      <p class="popup-description">${t('popups.cable.description')}</p>
    </div>
  `;
}

export function renderCableAdvisoryPopup(advisory: CableAdvisory): string {
  const cable = UNDERSEA_CABLES.find((item) => item.id === advisory.cableId);
  const timeAgo = getTimeAgo(advisory.reported);
  const statusLabel = advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded');
  const cableName = escapeHtml(cable?.name.toUpperCase() || advisory.cableId.toUpperCase());
  const advisoryTitle = escapeHtml(advisory.title);
  const advisoryImpact = escapeHtml(advisory.impact);
  const advisoryEta = advisory.repairEta ? escapeHtml(advisory.repairEta) : '';
  const advisoryDescription = escapeHtml(advisory.description);

  return `
    <div class="popup-header cable">
      <span class="popup-title">🚨 ${cableName}</span>
      <span class="popup-badge ${advisory.severity === 'fault' ? 'high' : 'elevated'}">${statusLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${advisoryTitle}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.cableAdvisory.reported')}</span>
          <span class="stat-value">${timeAgo}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.cableAdvisory.impact')}</span>
          <span class="stat-value">${advisoryImpact}</span>
        </div>
        ${advisory.repairEta ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
          <span class="stat-value">${advisoryEta}</span>
        </div>
        ` : ''}
      </div>
      <p class="popup-description">${advisoryDescription}</p>
    </div>
  `;
}

export function renderRepairShipPopup(ship: RepairShip): string {
  const cable = UNDERSEA_CABLES.find((item) => item.id === ship.cableId);
  const shipName = escapeHtml(ship.name.toUpperCase());
  const cableLabel = escapeHtml(cable?.name || ship.cableId);
  const shipEta = escapeHtml(ship.eta);
  const shipOperator = ship.operator ? escapeHtml(ship.operator) : '';
  const shipNote = escapeHtml(ship.note || t('popups.repairShip.description'));

  return `
    <div class="popup-header cable">
      <span class="popup-title">🚢 ${shipName}</span>
      <span class="popup-badge elevated">${t('popups.repairShip.badge')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${cableLabel}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.status')}</span>
          <span class="stat-value">${ship.status === 'on-station' ? t('popups.repairShip.status.onStation') : t('popups.repairShip.status.enRoute')}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
          <span class="stat-value">${shipEta}</span>
        </div>
        ${ship.operator ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.operator')}</span>
          <span class="stat-value">${shipOperator}</span>
        </div>
        ` : ''}
      </div>
      <p class="popup-description">${shipNote}</p>
    </div>
  `;
}

export function renderOutagePopup(outage: InternetOutage): string {
  const severityColors: Record<string, string> = {
    'total': 'high',
    'major': 'elevated',
    'partial': 'low',
  };
  const severityLabels: Record<string, string> = {
    'total': t('popups.outage.levels.total'),
    'major': t('popups.outage.levels.major'),
    'partial': t('popups.outage.levels.partial'),
  };
  const timeAgo = getTimeAgo(outage.pubDate);
  const severityClass = escapeHtml(outage.severity);

  return `
    <div class="popup-header outage ${severityClass}">
      <span class="popup-title">📡 ${escapeHtml(outage.country.toUpperCase())}</span>
      <span class="popup-badge ${severityColors[outage.severity] || 'low'}">${severityLabels[outage.severity] || t('popups.outage.levels.disruption')}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(outage.title)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.severity')}</span>
          <span class="stat-value">${escapeHtml(outage.severity.toUpperCase())}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.outage.reported')}</span>
          <span class="stat-value">${timeAgo}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${outage.lat.toFixed(2)}°, ${outage.lon.toFixed(2)}°</span>
        </div>
      </div>
      ${outage.categories && outage.categories.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.outage.categories')}</span>
          <div class="popup-tags">
            ${outage.categories.slice(0, 5).map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      <p class="popup-description">${escapeHtml(outage.description.slice(0, 250))}${outage.description.length > 250 ? '...' : ''}</p>
      <a href="${sanitizeUrl(outage.link)}" target="_blank" class="popup-link">${t('popups.outage.readReport')} →</a>
    </div>
  `;
}

export function getLatestCableAdvisory(cableId: string, cableAdvisories: CableAdvisory[]): CableAdvisory | undefined {
  const advisories = cableAdvisories.filter((item) => item.cableId === cableId);
  return advisories.reduce<CableAdvisory | undefined>((latest, advisory) => {
    if (!latest) return advisory;
    return advisory.reported.getTime() > latest.reported.getTime() ? advisory : latest;
  }, undefined);
}

export function getPriorityRepairShip(cableId: string, repairShips: RepairShip[]): RepairShip | undefined {
  const ships = repairShips.filter((item) => item.cableId === cableId);
  if (ships.length === 0) return undefined;
  const onStation = ships.find((ship) => ship.status === 'on-station');
  return onStation || ships[0];
}
