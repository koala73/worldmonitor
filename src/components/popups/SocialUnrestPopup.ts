import type { SocialUnrestEvent } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export interface ProtestClusterData {
  items: SocialUnrestEvent[];
  country: string;
  count?: number;
  riotCount?: number;
  highSeverityCount?: number;
  verifiedCount?: number;
  totalFatalities?: number;
  sampled?: boolean;
}

export function renderProtestPopup(event: SocialUnrestEvent): string {
  const severityClass = escapeHtml(event.severity);
  const severityLabel = escapeHtml(event.severity.toUpperCase());
  const eventTypeLabel = escapeHtml(event.eventType.replace('_', ' ').toUpperCase());
  const icon = event.eventType === 'riot' ? '🔥' : event.eventType === 'strike' ? '✊' : '📢';
  const sourceLabel = event.sourceType === 'acled' ? t('popups.protest.acledVerified') : t('popups.protest.gdelt');
  const validatedBadge = event.validated ? `<span class="popup-badge verified">${t('popups.verified')}</span>` : '';
  const fatalitiesSection = event.fatalities
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.fatalities')}</span><span class="stat-value alert">${event.fatalities}</span></div>`
    : '';
  const actorsSection = event.actors?.length
    ? `<div class="popup-stat"><span class="stat-label">${t('popups.actors')}</span><span class="stat-value">${event.actors.map(a => escapeHtml(a)).join(', ')}</span></div>`
    : '';
  const tagsSection = event.tags?.length
    ? `<div class="popup-tags">${event.tags.map(t => `<span class="popup-tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const relatedHotspots = event.relatedHotspots?.length
    ? `<div class="popup-related">${t('popups.near')}: ${event.relatedHotspots.map(h => escapeHtml(h)).join(', ')}</div>`
    : '';

  return `
    <div class="popup-header protest ${severityClass}">
      <span class="popup-icon">${icon}</span>
      <span class="popup-title">${eventTypeLabel}</span>
      <span class="popup-badge ${severityClass}">${severityLabel}</span>
      ${validatedBadge}
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${event.city ? `${escapeHtml(event.city)}, ` : ''}${escapeHtml(event.country)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.time')}</span>
          <span class="stat-value">${event.time.toLocaleDateString()}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.source')}</span>
          <span class="stat-value">${sourceLabel}</span>
        </div>
        ${fatalitiesSection}
        ${actorsSection}
      </div>
      ${event.title ? `<p class="popup-description">${escapeHtml(event.title)}</p>` : ''}
      ${tagsSection}
      ${relatedHotspots}
    </div>
  `;
}

export function renderProtestClusterPopup(data: ProtestClusterData): string {
  const totalCount = data.count ?? data.items.length;
  const riots = data.riotCount ?? data.items.filter(e => e.eventType === 'riot').length;
  const highSeverity = data.highSeverityCount ?? data.items.filter(e => e.severity === 'high').length;
  const verified = data.verifiedCount ?? data.items.filter(e => e.validated).length;
  const totalFatalities = data.totalFatalities ?? data.items.reduce((sum, e) => sum + (e.fatalities || 0), 0);

  const sortedItems = [...data.items].sort((a, b) => {
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const typeOrder: Record<string, number> = { riot: 0, civil_unrest: 1, strike: 2, demonstration: 3, protest: 4 };
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return (typeOrder[a.eventType] ?? 5) - (typeOrder[b.eventType] ?? 5);
  });

  const listItems = sortedItems.slice(0, 10).map(event => {
    const icon = event.eventType === 'riot' ? '🔥' : event.eventType === 'strike' ? '✊' : '📢';
    const sevClass = event.severity;
    const dateStr = event.time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const city = event.city ? escapeHtml(event.city) : '';
    const title = event.title ? `: ${escapeHtml(event.title.slice(0, 40))}${event.title.length > 40 ? '...' : ''}` : '';
    return `<li class="cluster-item ${sevClass}">${icon} ${dateStr}${city ? ` • ${city}` : ''}${title}</li>`;
  }).join('');

  const renderedCount = Math.min(10, data.items.length);
  const remainingCount = Math.max(0, totalCount - renderedCount);
  const moreCount = remainingCount > 0 ? `<li class="cluster-more">+${remainingCount} ${t('popups.moreEvents')}</li>` : '';
  const headerClass = highSeverity > 0 ? 'high' : riots > 0 ? 'medium' : 'low';

  return `
    <div class="popup-header protest ${headerClass} cluster">
      <span class="popup-title">📢 ${escapeHtml(data.country)}</span>
      <span class="popup-badge">${totalCount} ${t('popups.events').toUpperCase()}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body cluster-popup">
      <div class="cluster-summary">
        ${riots ? `<span class="summary-item riot">🔥 ${riots} ${t('popups.protest.riots')}</span>` : ''}
        ${highSeverity ? `<span class="summary-item high">⚠️ ${highSeverity} ${t('popups.protest.highSeverity')}</span>` : ''}
        ${verified ? `<span class="summary-item verified">✓ ${verified} ${t('popups.verified')}</span>` : ''}
        ${totalFatalities > 0 ? `<span class="summary-item fatalities">💀 ${totalFatalities} ${t('popups.fatalities')}</span>` : ''}
      </div>
      <ul class="cluster-list">${listItems}${moreCount}</ul>
      ${data.sampled ? `<p class="popup-more">${t('popups.sampledList', { count: data.items.length })}</p>` : ''}
    </div>
  `;
}
