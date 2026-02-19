import type { EconomicCenter } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getMarketStatus } from './popup-helpers';

export interface StockExchangePopupData {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  tier: string;
  marketCap?: number;
  tradingHours?: string;
  timezone?: string;
  description?: string;
}

export interface FinancialCenterPopupData {
  id: string;
  name: string;
  city: string;
  country: string;
  type: string;
  gfciRank?: number;
  specialties?: string[];
  description?: string;
}

export interface CentralBankPopupData {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  type: string;
  currency?: string;
  description?: string;
}

export interface CommodityHubPopupData {
  id: string;
  name: string;
  city: string;
  country: string;
  type: string;
  commodities?: string[];
  description?: string;
}

export function renderEconomicPopup(center: EconomicCenter): string {
  const typeLabels: Record<string, string> = {
    'exchange': t('popups.economic.types.exchange'),
    'central-bank': t('popups.economic.types.centralBank'),
    'financial-hub': t('popups.economic.types.financialHub'),
  };
  const typeIcons: Record<string, string> = {
    'exchange': '📈',
    'central-bank': '🏛',
    'financial-hub': '💰',
  };

  const marketStatus = center.marketHours ? getMarketStatus(center.marketHours) : null;
  const marketStatusLabel = marketStatus
    ? marketStatus === 'open'
      ? t('popups.open')
      : marketStatus === 'closed'
      ? t('popups.economic.closed')
      : t('popups.unknown')
    : '';

  return `
    <div class="popup-header economic ${center.type}">
      <span class="popup-title">${typeIcons[center.type] || ''} ${center.name.toUpperCase()}</span>
      <span class="popup-badge ${marketStatus === 'open' ? 'elevated' : 'low'}">${marketStatusLabel || typeLabels[center.type]}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      ${center.description ? `<p class="popup-description">${center.description}</p>` : ''}
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.type')}</span>
          <span class="stat-value">${typeLabels[center.type] || center.type.toUpperCase()}</span>
        </div>
        <div class="popup-stat">
          <span class="stat-label">${t('popups.country')}</span>
          <span class="stat-value">${center.country}</span>
        </div>
        ${center.marketHours ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.tradingHours')}</span>
          <span class="stat-value">${center.marketHours.open} - ${center.marketHours.close}</span>
        </div>
        ` : ''}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.coordinates')}</span>
          <span class="stat-value">${center.lat.toFixed(2)}°, ${center.lon.toFixed(2)}°</span>
        </div>
      </div>
    </div>
  `;
}

export function renderStockExchangePopup(exchange: StockExchangePopupData): string {
  const tierLabel = exchange.tier.toUpperCase();
  const tierClass = exchange.tier === 'mega' ? 'high' : exchange.tier === 'major' ? 'medium' : 'low';

  return `
    <div class="popup-header exchange">
      <span class="popup-title">${escapeHtml(exchange.shortName)}</span>
      <span class="popup-badge ${tierClass}">${tierLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(exchange.name)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.location')}</span>
          <span class="stat-value">${escapeHtml(exchange.city)}, ${escapeHtml(exchange.country)}</span>
        </div>
        ${exchange.marketCap ? `<div class="popup-stat"><span class="stat-label">${t('popups.stockExchange.marketCap')}</span><span class="stat-value">$${exchange.marketCap}T</span></div>` : ''}
        ${exchange.tradingHours ? `<div class="popup-stat"><span class="stat-label">${t('popups.tradingHours')}</span><span class="stat-value">${escapeHtml(exchange.tradingHours)}</span></div>` : ''}
      </div>
      ${exchange.description ? `<p class="popup-description">${escapeHtml(exchange.description)}</p>` : ''}
    </div>
  `;
}

export function renderFinancialCenterPopup(center: FinancialCenterPopupData): string {
  const typeLabel = center.type.toUpperCase();

  return `
    <div class="popup-header financial-center">
      <span class="popup-title">${escapeHtml(center.name)}</span>
      <span class="popup-badge">${typeLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.location')}</span>
          <span class="stat-value">${escapeHtml(center.city)}, ${escapeHtml(center.country)}</span>
        </div>
        ${center.gfciRank ? `<div class="popup-stat"><span class="stat-label">${t('popups.financialCenter.gfciRank')}</span><span class="stat-value">#${center.gfciRank}</span></div>` : ''}
      </div>
      ${center.specialties && center.specialties.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.financialCenter.specialties')}</span>
          <div class="popup-tags">
            ${center.specialties.map(s => `<span class="popup-tag">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${center.description ? `<p class="popup-description">${escapeHtml(center.description)}</p>` : ''}
    </div>
  `;
}

export function renderCentralBankPopup(bank: CentralBankPopupData): string {
  const typeLabel = bank.type.toUpperCase();

  return `
    <div class="popup-header central-bank">
      <span class="popup-title">${escapeHtml(bank.shortName)}</span>
      <span class="popup-badge">${typeLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-subtitle">${escapeHtml(bank.name)}</div>
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.location')}</span>
          <span class="stat-value">${escapeHtml(bank.city)}, ${escapeHtml(bank.country)}</span>
        </div>
        ${bank.currency ? `<div class="popup-stat"><span class="stat-label">${t('popups.centralBank.currency')}</span><span class="stat-value">${escapeHtml(bank.currency)}</span></div>` : ''}
      </div>
      ${bank.description ? `<p class="popup-description">${escapeHtml(bank.description)}</p>` : ''}
    </div>
  `;
}

export function renderCommodityHubPopup(hub: CommodityHubPopupData): string {
  const typeLabel = hub.type.toUpperCase();

  return `
    <div class="popup-header commodity-hub">
      <span class="popup-title">${escapeHtml(hub.name)}</span>
      <span class="popup-badge">${typeLabel}</span>
      <button class="popup-close">×</button>
    </div>
    <div class="popup-body">
      <div class="popup-stats">
        <div class="popup-stat">
          <span class="stat-label">${t('popups.location')}</span>
          <span class="stat-value">${escapeHtml(hub.city)}, ${escapeHtml(hub.country)}</span>
        </div>
      </div>
      ${hub.commodities && hub.commodities.length > 0 ? `
        <div class="popup-section">
          <span class="section-label">${t('popups.commodityHub.commodities')}</span>
          <div class="popup-tags">
            ${hub.commodities.map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${hub.description ? `<p class="popup-description">${escapeHtml(hub.description)}</p>` : ''}
    </div>
  `;
}
