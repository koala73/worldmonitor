/**
 * CountryIntelModal - Shows AI-generated intelligence brief when user clicks a country
 */
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { sanitizeUrl } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import type { CountryScore } from '@/services/country-instability';
import type { PredictionMarket } from '@/services/prediction';

interface CountryIntelData {
  brief: string;
  country: string;
  code: string;
  cached?: boolean;
  generatedAt?: string;
  error?: string;
}

export interface StockIndexData {
  available: boolean;
  code: string;
  symbol: string;
  indexName: string;
  price: string;
  weekChangePercent: string;
  currency: string;
  cached?: boolean;
}

interface ActiveSignals {
  protests: number;
  militaryFlights: number;
  militaryVessels: number;
  outages: number;
  earthquakes: number;
}

export class CountryIntelModal {
  private overlay: HTMLElement;
  private contentEl: HTMLElement;
  private headerEl: HTMLElement;
  private onCloseCallback?: () => void;
  private onShareStory?: (code: string, name: string) => void;
  private currentCode: string | null = null;
  private currentName: string | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'country-intel-overlay';
    this.overlay.innerHTML = `
      <div class="country-intel-modal">
        <div class="country-intel-header">
          <div class="country-intel-title"></div>
          <button class="country-intel-close">×</button>
        </div>
        <div class="country-intel-content"></div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.headerEl = this.overlay.querySelector('.country-intel-title')!;
    this.contentEl = this.overlay.querySelector('.country-intel-content')!;

    this.overlay.querySelector('.country-intel-close')?.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('country-intel-overlay')) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.classList.contains('active')) this.hide();
    });
  }

  private countryFlag(code: string): string {
    try {
      return code
        .toUpperCase()
        .split('')
        .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
        .join('');
    } catch {
      return '🌍';
    }
  }

  private levelBadge(level: string): string {
    const varMap: Record<string, string> = {
      critical: '--semantic-critical',
      high: '--semantic-high',
      elevated: '--semantic-elevated',
      normal: '--semantic-normal',
      low: '--semantic-low',
    };
    const color = getCSSColor(varMap[level] || '--text-dim');
    return `<span class="cii-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${level.toUpperCase()}</span>`;
  }

  private scoreBar(score: number): string {
    const pct = Math.min(100, Math.max(0, score));
    const color = pct >= 70 ? getCSSColor('--semantic-critical') : pct >= 50 ? getCSSColor('--semantic-high') : pct >= 30 ? getCSSColor('--semantic-elevated') : getCSSColor('--semantic-normal');
    return `
      <div class="cii-score-bar">
        <div class="cii-score-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="cii-score-value">${score}/100</span>
    `;
  }

  public showLoading(): void {
    this.currentCode = '__loading__';
    this.headerEl.innerHTML = `
      <span class="country-flag">🌍</span>
      <span class="country-name">${t('modals.countryIntel.identifying')}</span>
    `;
    this.contentEl.innerHTML = `
      <div class="intel-brief-section">
        <div class="intel-brief-loading">
          <div class="intel-skeleton"></div>
          <div class="intel-skeleton short"></div>
          <span class="intel-loading-text">${t('modals.countryIntel.locating')}</span>
        </div>
      </div>
    `;
    this.overlay.classList.add('active');
  }

  public show(country: string, code: string, score: CountryScore | null, signals?: ActiveSignals): void {
    this.currentCode = code;
    this.currentName = country;
    const flag = this.countryFlag(code);
    let html = '';
    this.overlay.classList.add('active');

    this.headerEl.innerHTML = `
      <span class="country-flag">${flag}</span>
      <span class="country-name">${escapeHtml(country)}</span>
      ${score ? this.levelBadge(score.level) : ''}
      <button class="country-intel-share-btn" title="${t('modals.story.shareTitle')}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
    `;

    if (score) {
      html += `
        <div class="cii-section">
          <div class="cii-label">${t('modals.countryIntel.instabilityIndex')} ${this.scoreBar(score.score)}</div>
          <div class="cii-components">
            <span title="${t('common.unrest')}">📢 ${score.components.unrest.toFixed(0)}</span>
            <span title="${t('common.conflict')}">⚔ ${score.components.conflict.toFixed(0)}</span>
            <span title="${t('common.security')}">🛡️ ${score.components.security.toFixed(0)}</span>
            <span title="${t('common.information')}">📡 ${score.components.information.toFixed(0)}</span>
            <span class="cii-trend ${score.trend}">${score.trend === 'rising' ? '↗' : score.trend === 'falling' ? '↘' : '→'} ${score.trend}</span>
          </div>
        </div>
      `;
    }

    const chips: string[] = [];
    if (signals) {
      if (signals.protests > 0) chips.push(`<span class="signal-chip protest">📢 ${signals.protests} ${t('modals.countryIntel.protests')}</span>`);
      if (signals.militaryFlights > 0) chips.push(`<span class="signal-chip military">✈️ ${signals.militaryFlights} ${t('modals.countryIntel.militaryAircraft')}</span>`);
      if (signals.militaryVessels > 0) chips.push(`<span class="signal-chip military">⚓ ${signals.militaryVessels} ${t('modals.countryIntel.militaryVessels')}</span>`);
      if (signals.outages > 0) chips.push(`<span class="signal-chip outage">🌐 ${signals.outages} ${t('modals.countryIntel.outages')}</span>`);
      if (signals.earthquakes > 0) chips.push(`<span class="signal-chip quake">🌍 ${signals.earthquakes} ${t('modals.countryIntel.earthquakes')}</span>`);
    }
    chips.push(`<span class="signal-chip stock-loading">📈 ${t('modals.countryIntel.loadingIndex')}</span>`);
    html += `<div class="active-signals">${chips.join('')}</div>`;

    html += `<div class="country-markets-section"><span class="intel-loading-text">${t('modals.countryIntel.loadingMarkets')}</span></div>`;

    html += `
      <div class="intel-brief-section">
        <div class="intel-brief-loading">
          <div class="intel-skeleton"></div>
          <div class="intel-skeleton short"></div>
          <div class="intel-skeleton"></div>
          <div class="intel-skeleton short"></div>
          <span class="intel-loading-text">${t('modals.countryIntel.generatingBrief')}</span>
        </div>
      </div>
    `;

    this.contentEl.innerHTML = html;

    const shareBtn = this.headerEl.querySelector('.country-intel-share-btn');
    shareBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.currentCode && this.currentName && this.onShareStory) {
        this.onShareStory(this.currentCode, this.currentName);
      }
    });
  }

  public updateBrief(data: CountryIntelData & { skipped?: boolean; reason?: string; fallback?: boolean }): void {
    if (this.currentCode !== data.code && this.currentCode !== '__loading__') return;

    // If modal closed, don't update
    if (!this.isVisible()) return;

    if (data.error || data.skipped || !data.brief) {
      const msg = data.error || data.reason || t('modals.countryIntel.unavailable');
      const briefSection = this.contentEl.querySelector('.intel-brief-section');
      if (briefSection) {
        briefSection.innerHTML = `<div class="intel-error">${escapeHtml(msg)}</div>`;
      }
      return;
    }

    const briefSection = this.contentEl.querySelector('.intel-brief-section');
    if (!briefSection) return;

    const formatted = this.formatBrief(data.brief);
    briefSection.innerHTML = `
      <div class="intel-brief">${formatted}</div>
      <div class="intel-footer">
        ${data.cached ? `<span class="intel-cached">📋 ${t('modals.countryIntel.cached')}</span>` : `<span class="intel-fresh">✨ ${t('modals.countryIntel.fresh')}</span>`}
        <span class="intel-timestamp">${data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ''}</span>
      </div>
    `;
  }

  public updateMarkets(markets: PredictionMarket[]): void {
    const section = this.contentEl.querySelector('.country-markets-section');
    if (!section) return;

    if (markets.length === 0) {
      section.innerHTML = `<span class="intel-loading-text" style="opacity:0.5">${t('modals.countryIntel.noMarkets')}</span>`;
      return;
    }

    const items = markets.map(market => {
      const href = sanitizeUrl(market.url || '#') || '#';
      return `
      <div class="market-item">
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="prediction-market-card">
        <div class="market-provider">Polymarket</div>
        <div class="market-question">${escapeHtml(market.title)}</div>
        <div class="market-prob">${market.yesPrice.toFixed(1)}%</div>
      </a>
    `;
    }).join('');

    section.innerHTML = `<div class="markets-label">📊 ${t('modals.countryIntel.predictionMarkets')}</div>${items}`;
  }

  public updateStock(data: StockIndexData): void {
    const el = this.contentEl.querySelector('.stock-loading');
    if (!el) return;

    if (!data.available) {
      el.remove();
      return;
    }

    const pct = parseFloat(data.weekChangePercent);
    const sign = pct >= 0 ? '+' : '';
    const cls = pct >= 0 ? 'stock-up' : 'stock-down';
    const arrow = pct >= 0 ? '📈' : '📉';
    el.className = `signal-chip stock ${cls}`;
    el.innerHTML = `${arrow} ${escapeHtml(data.indexName)}: ${sign}${data.weekChangePercent}% (1W)`;
  }

  private formatBrief(text: string): string {
    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  public hide(): void {
    this.overlay.classList.remove('active');
    this.currentCode = null;
    this.onCloseCallback?.();
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public isVisible(): boolean {
    return this.overlay.classList.contains('active');
  }
}
