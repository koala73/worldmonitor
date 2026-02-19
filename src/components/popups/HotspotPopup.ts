import type { Hotspot, NewsItem } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import { t } from '@/services/i18n';
import { fetchHotspotContext, formatArticleDate, extractDomain, type GdeltArticle } from '@/services/gdelt-intel';
import { getHotspotEscalation, getEscalationChange24h } from '@/services/hotspot-escalation';

function getLocalizedHotspotSubtext(subtext: string): string {
  const slug = subtext
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = `popups.hotspotSubtexts.${slug}`;
  const localized = t(key);
  return localized === key ? subtext : localized;
}

function renderGdeltArticle(article: GdeltArticle): string {
  const domain = article.source || extractDomain(article.url);
  const timeAgo = formatArticleDate(article.date);

  return `
    <a href="${sanitizeUrl(article.url)}" target="_blank" rel="noopener" class="hotspot-gdelt-article">
      <div class="article-meta">
        <span>${escapeHtml(domain)}</span>
        <span>${escapeHtml(timeAgo)}</span>
      </div>
      <div class="article-title">${escapeHtml(article.title)}</div>
    </a>
  `;
}

export function renderHotspotPopup(hotspot: Hotspot, relatedNews?: NewsItem[]): string {
  const severityClass = hotspot.level || 'low';
  const severityLabel = escapeHtml((hotspot.level || 'low').toUpperCase());
  const localizedSubtext = hotspot.subtext ? getLocalizedHotspotSubtext(hotspot.subtext) : '';

  // Get dynamic escalation score
  const dynamicScore = getHotspotEscalation(hotspot.id);
  const change24h = getEscalationChange24h(hotspot.id);

  // Escalation score display
  const escalationColors: Record<number, string> = {
    1: getCSSColor('--semantic-normal'),
    2: getCSSColor('--semantic-normal'),
    3: getCSSColor('--semantic-elevated'),
    4: getCSSColor('--semantic-high'),
    5: getCSSColor('--semantic-critical'),
  };
  const escalationLabels: Record<number, string> = {
    1: t('popups.hotspot.levels.stable'),
    2: t('popups.hotspot.levels.watch'),
    3: t('popups.hotspot.levels.elevated'),
    4: t('popups.hotspot.levels.high'),
    5: t('popups.hotspot.levels.critical')
  };
  const trendIcons: Record<string, string> = { 'escalating': '↑', 'stable': '→', 'de-escalating': '↓' };
  const trendColors: Record<string, string> = { 'escalating': getCSSColor('--semantic-critical'), 'stable': getCSSColor('--semantic-elevated'), 'de-escalating': getCSSColor('--semantic-normal') };

  const displayScore = dynamicScore?.combinedScore ?? hotspot.escalationScore ?? 3;
  const displayScoreInt = Math.round(displayScore);
  const displayTrend = dynamicScore?.trend ?? hotspot.escalationTrend ?? 'stable';

  const escalationSection = `
    <div class="popup-section escalation-section">
      <span class="section-label">${t('popups.hotspot.escalation')}</span>
      <div class="escalation-display">
        <div class="escalation-score" style="background: ${escalationColors[displayScoreInt] || getCSSColor('--text-dim')}">
          <span class="score-value">${displayScore.toFixed(1)}/5</span>
          <span class="score-label">${escalationLabels[displayScoreInt] || t('popups.unknown')}</span>
        </div>
        <div class="escalation-trend" style="color: ${trendColors[displayTrend] || getCSSColor('--text-dim')}">
          <span class="trend-icon">${trendIcons[displayTrend] || ''}</span>
          <span class="trend-label">${escapeHtml(displayTrend.toUpperCase())}</span>
        </div>
      </div>
      ${dynamicScore ? `
        <div class="escalation-breakdown">
          <div class="breakdown-header">
            <span class="baseline-label">${t('popups.hotspot.baseline')}: ${dynamicScore.staticBaseline}/5</span>
            ${change24h ? `
              <span class="change-label ${change24h.change >= 0 ? 'rising' : 'falling'}">
                24h: ${change24h.change >= 0 ? '+' : ''}${change24h.change}
              </span>
            ` : ''}
          </div>
          <div class="breakdown-components">
            <div class="breakdown-row">
              <span class="component-label">${t('popups.hotspot.components.news')}</span>
              <div class="component-bar-bg">
                <div class="component-bar news" style="width: ${dynamicScore.components.newsActivity}%"></div>
              </div>
              <span class="component-value">${Math.round(dynamicScore.components.newsActivity)}</span>
            </div>
            <div class="breakdown-row">
              <span class="component-label">${t('popups.hotspot.components.cii')}</span>
              <div class="component-bar-bg">
                <div class="component-bar cii" style="width: ${dynamicScore.components.ciiContribution}%"></div>
              </div>
              <span class="component-value">${Math.round(dynamicScore.components.ciiContribution)}</span>
            </div>
            <div class="breakdown-row">
              <span class="component-label">${t('popups.hotspot.components.geo')}</span>
              <div class="component-bar-bg">
                <div class="component-bar geo" style="width: ${dynamicScore.components.geoConvergence}%"></div>
              </div>
              <span class="component-value">${Math.round(dynamicScore.components.geoConvergence)}</span>
            </div>
            <div class="breakdown-row">
              <span class="component-label">${t('popups.hotspot.components.military')}</span>
              <div class="component-bar-bg">
                <div class="component-bar military" style="width: ${dynamicScore.components.militaryActivity}%"></div>
              </div>
              <span class="component-value">${Math.round(dynamicScore.components.militaryActivity)}</span>
            </div>
          </div>
        </div>
      ` : ''}
      ${hotspot.escalationIndicators && hotspot.escalationIndicators.length > 0 ? `
        <div class="escalation-indicators">
          ${hotspot.escalationIndicators.map(i => `<span class="indicator-tag">• ${escapeHtml(i)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;

  // Historical context section
  const historySection = hotspot.history ? `
    <div class="popup-section history-section">
      <span class="section-label">${t('popups.historicalContext')}</span>
      <div class="history-content">
        ${hotspot.history.lastMajorEvent ? `
          <div class="history-event">
            <span class="history-label">${t('popups.lastMajorEvent')}:</span>
            <span class="history-value">${escapeHtml(hotspot.history.lastMajorEvent)} ${hotspot.history.lastMajorEventDate ? `(${escapeHtml(hotspot.history.lastMajorEventDate)})` : ''}</span>
          </div>
        ` : ''}
        ${hotspot.history.precedentDescription ? `
          <div class="history-event">
            <span class="history-label">${t('popups.precedents')}:</span>
            <span class="history-value">${escapeHtml(hotspot.history.precedentDescription)}</span>
          </div>
        ` : ''}
        ${hotspot.history.cyclicalRisk ? `
          <div class="history-event cyclical">
            <span class="history-label">${t('popups.cyclicalPattern')}:</span>
            <span class="history-value">${escapeHtml(hotspot.history.cyclicalRisk)}</span>
          </div>
        ` : ''}
      </div>
    </div>
  ` : '';

  // "Why it matters" section
  const whyItMattersSection = hotspot.whyItMatters ? `
    <div class="popup-section why-matters-section">
      <span class="section-label">${t('popups.whyItMatters')}</span>
      <p class="why-matters-text">${escapeHtml(hotspot.whyItMatters)}</p>
    </div>
  ` : '';

  return `
    <div class="popup-header hotspot">
      <span class="popup-title">${escapeHtml(hotspot.name.toUpperCase())}</span>
      <span class="popup-badge ${severityClass}">${severityLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      ${localizedSubtext ? `<div class="popup-subtitle">${escapeHtml(localizedSubtext)}</div>` : ''}
      ${hotspot.description ? `<p class="popup-description">${escapeHtml(hotspot.description)}</p>` : ''}
      ${escalationSection}
      <div class="popup-stats">
        ${hotspot.location ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(hotspot.location)}</span>
          </div>
        ` : ''}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${escapeHtml(`${hotspot.lat.toFixed(2)}°N, ${hotspot.lon.toFixed(2)}°E`)}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.status')}</span>
          <span class="stat-value">${escapeHtml(hotspot.status || t('popups.monitoring'))}</span>
        </div>
      </div>
      ${whyItMattersSection}
      ${historySection}
      ${hotspot.agencies && hotspot.agencies.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.keyEntities')}</span>
          <div class="popup-tags">
            ${hotspot.agencies.map(a => `<span class="popup-tag">${escapeHtml(a)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${relatedNews && relatedNews.length > 0 ? `
        <div class="popup-section">
        <div class="popup-section">
          <span class="section-label">${t('popups.relatedHeadlines')}</span>
          <div class="popup-news">
            ${relatedNews.slice(0, 5).map(n => `
              <div class="popup-news-item">
                <span class="news-source">${escapeHtml(n.source)}</span>
                <a href="${sanitizeUrl(n.link)}" target="_blank" class="news-title">${escapeHtml(n.title)}</a>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="hotspot-gdelt-context" data-hotspot-id="${escapeHtml(hotspot.id)}">
        <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
        <div class="hotspot-gdelt-loading">${t('popups.loadingNews')}</div>
      </div>
    </div>
  `;
}

export async function loadHotspotGdeltContext(popup: HTMLElement | null, hotspot: Hotspot): Promise<void> {
  if (!popup) return;

  const container = popup.querySelector('.hotspot-gdelt-context');
  if (!container) return;

  try {
    const articles = await fetchHotspotContext(hotspot);

    if (!popup || !container.isConnected) return;

    if (articles.length === 0) {
      container.innerHTML = `
        <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
        <div class="hotspot-gdelt-loading">${t('popups.noCoverage')}</div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
      <div class="hotspot-gdelt-articles">
        ${articles.slice(0, 5).map(article => renderGdeltArticle(article)).join('')}
      </div>
    `;
  } catch (error) {
    if (container.isConnected) {
      container.innerHTML = `
        <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
        <div class="hotspot-gdelt-loading">${t('common.error')}</div>
      `;
    }
  }
}
