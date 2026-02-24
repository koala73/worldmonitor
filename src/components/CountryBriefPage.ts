import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { getCSSColor } from '@/utils';
import type { CountryScore } from '@/services/country-instability';
import type { NewsItem } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import type { AssetType } from '@/types';
import type { CountryBriefSignals } from '@/App';
import type { StockIndexData } from '@/components/CountryIntelModal';
import { getNearbyInfrastructure, haversineDistanceKm } from '@/services/related-assets';
import { PORTS } from '@/config/ports';
import type { Port } from '@/config/ports';
import { exportCountryBriefJSON, exportCountryBriefCSV } from '@/utils/export';
import type { CountryBriefExport } from '@/utils/export';

type BriefAssetType = AssetType | 'port';

interface CountryIntelData {
  brief: string;
  country: string;
  code: string;
  cached?: boolean;
  generatedAt?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  fallback?: boolean;
}

export class CountryBriefPage {
  private static BRIEF_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
    IR: { n: 40, s: 25, e: 63, w: 44 }, IL: { n: 33.3, s: 29.5, e: 35.9, w: 34.3 },
    SA: { n: 32, s: 16, e: 55, w: 35 }, AE: { n: 26.1, s: 22.6, e: 56.4, w: 51.6 },
    IQ: { n: 37.4, s: 29.1, e: 48.6, w: 38.8 }, SY: { n: 37.3, s: 32.3, e: 42.4, w: 35.7 },
    YE: { n: 19, s: 12, e: 54.5, w: 42 }, LB: { n: 34.7, s: 33.1, e: 36.6, w: 35.1 },
    CN: { n: 53.6, s: 18.2, e: 134.8, w: 73.5 }, TW: { n: 25.3, s: 21.9, e: 122, w: 120 },
    JP: { n: 45.5, s: 24.2, e: 153.9, w: 122.9 }, KR: { n: 38.6, s: 33.1, e: 131.9, w: 124.6 },
    KP: { n: 43.0, s: 37.7, e: 130.7, w: 124.2 }, IN: { n: 35.5, s: 6.7, e: 97.4, w: 68.2 },
    PK: { n: 37, s: 24, e: 77, w: 61 }, AF: { n: 38.5, s: 29.4, e: 74.9, w: 60.5 },
    UA: { n: 52.4, s: 44.4, e: 40.2, w: 22.1 }, RU: { n: 82, s: 41.2, e: 180, w: 19.6 },
    BY: { n: 56.2, s: 51.3, e: 32.8, w: 23.2 }, PL: { n: 54.8, s: 49, e: 24.1, w: 14.1 },
    EG: { n: 31.7, s: 22, e: 36.9, w: 25 }, LY: { n: 33, s: 19.5, e: 25, w: 9.4 },
    SD: { n: 22, s: 8.7, e: 38.6, w: 21.8 }, US: { n: 49, s: 24.5, e: -66.9, w: -125 },
    GB: { n: 58.7, s: 49.9, e: 1.8, w: -8.2 }, DE: { n: 55.1, s: 47.3, e: 15.0, w: 5.9 },
    FR: { n: 51.1, s: 41.3, e: 9.6, w: -5.1 }, TR: { n: 42.1, s: 36, e: 44.8, w: 26 },
  };

  private static INFRA_ICONS: Record<BriefAssetType, string> = {
    pipeline: '\u{1F50C}',
    cable: '\u{1F310}',
    datacenter: '\u{1F5A5}\uFE0F',
    base: '\u{1F3DB}\uFE0F',
    nuclear: '\u2622\uFE0F',
    port: '\u2693',
  };

  private static INFRA_LABELS: Record<BriefAssetType, string> = {
    pipeline: 'pipeline',
    cable: 'cable',
    datacenter: 'datacenter',
    base: 'base',
    nuclear: 'nuclear',
    port: 'port',
  };

  private overlay: HTMLElement;
  private currentCode: string | null = null;
  private currentName: string | null = null;
  private currentHeadlineCount = 0;
  private currentScore: CountryScore | null = null;
  private currentSignals: CountryBriefSignals | null = null;
  private currentBrief: string | null = null;
  private currentHeadlines: NewsItem[] = [];
  private onCloseCallback?: () => void;
  private onShareStory?: (code: string, name: string) => void;
  private onExportImage?: (code: string, name: string) => void;
  private boundExportMenuClose: (() => void) | null = null;
  private boundCitationClick: ((e: Event) => void) | null = null;
  private abortController: AbortController = new AbortController();

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'country-brief-overlay';
    document.body.appendChild(this.overlay);

    this.overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('country-brief-overlay')) this.hide();
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

  private levelColor(level: string): string {
    const varMap: Record<string, string> = {
      critical: '--semantic-critical',
      high: '--semantic-high',
      elevated: '--semantic-elevated',
      normal: '--semantic-normal',
      low: '--semantic-low',
    };
    return getCSSColor(varMap[level] || '--text-dim');
  }

  private levelBadge(level: string): string {
    const color = this.levelColor(level);
    const levelKey = level as 'critical' | 'high' | 'elevated' | 'moderate' | 'normal' | 'low';
    const label = t(`countryBrief.levels.${levelKey}`);
    return `<span class="cb-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${label.toUpperCase()}</span>`;
  }

  private trendIndicator(trend: string): string {
    const arrow = trend === 'rising' ? '↗' : trend === 'falling' ? '↘' : '→';
    const cls = trend === 'rising' ? 'trend-up' : trend === 'falling' ? 'trend-down' : 'trend-stable';
    const trendKey = trend as 'rising' | 'falling' | 'stable';
    const trendLabel = t(`countryBrief.trends.${trendKey}`);
    return `<span class="cb-trend ${cls}">${arrow} ${trendLabel}</span>`;
  }

  private scoreRing(score: number, level: string): string {
    const color = this.levelColor(level);
    const pct = Math.min(100, Math.max(0, score));
    const circumference = 2 * Math.PI * 42;
    const dashOffset = circumference * (1 - pct / 100);
    return `
      <div class="cb-score-ring">
        <svg viewBox="0 0 100 100" width="120" height="120">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/>
          <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="6"
            stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
            stroke-linecap="round" transform="rotate(-90 50 50)"
            style="transition: stroke-dashoffset 0.8s ease"/>
        </svg>
        <div class="cb-score-value" style="color:${color}">${score}</div>
        <div class="cb-score-label">/ 100</div>
      </div>`;
  }

  private componentBars(components: CountryScore['components']): string {
    const items = [
      { label: t('modals.countryBrief.components.unrest'), value: components.unrest, icon: '📢' },
      { label: t('modals.countryBrief.components.conflict'), value: components.conflict, icon: '⚔' },
      { label: t('modals.countryBrief.components.security'), value: components.security, icon: '🛡️' },
      { label: t('modals.countryBrief.components.information'), value: components.information, icon: '📡' },
    ];
    return items.map(({ label, value, icon }) => {
      const pct = Math.min(100, Math.max(0, value));
      const color = pct >= 70 ? getCSSColor('--semantic-critical') : pct >= 50 ? getCSSColor('--semantic-high') : pct >= 30 ? getCSSColor('--semantic-elevated') : getCSSColor('--semantic-normal');
      return `
        <div class="cb-comp-row">
          <span class="cb-comp-icon">${icon}</span>
          <span class="cb-comp-label">${label}</span>
          <div class="cb-comp-bar"><div class="cb-comp-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="cb-comp-val">${Math.round(value)}</span>
        </div>`;
    }).join('');
  }

  private signalChips(signals: CountryBriefSignals): string {
    const chips: string[] = [];
    if (signals.protests > 0) chips.push(`<span class="signal-chip protest">📢 ${signals.protests} ${t('modals.countryBrief.signals.protests')}</span>`);
    if (signals.militaryFlights > 0) chips.push(`<span class="signal-chip military">✈️ ${signals.militaryFlights} ${t('modals.countryBrief.signals.militaryAir')}</span>`);
    if (signals.militaryVessels > 0) chips.push(`<span class="signal-chip military">⚓ ${signals.militaryVessels} ${t('modals.countryBrief.signals.militarySea')}</span>`);
    if (signals.outages > 0) chips.push(`<span class="signal-chip outage">🌐 ${signals.outages} ${t('modals.countryBrief.signals.outages')}</span>`);
    if (signals.earthquakes > 0) chips.push(`<span class="signal-chip quake">🌍 ${signals.earthquakes} ${t('modals.countryBrief.signals.earthquakes')}</span>`);
    if (signals.displacementOutflow > 0) {
      const fmt = signals.displacementOutflow >= 1_000_000
        ? `${(signals.displacementOutflow / 1_000_000).toFixed(1)}M`
        : `${(signals.displacementOutflow / 1000).toFixed(0)}K`;
      chips.push(`<span class="signal-chip displacement">🌊 ${fmt} ${t('modals.countryBrief.signals.displaced')}</span>`);
    }
    if (signals.climateStress > 0) chips.push(`<span class="signal-chip climate">🌡️ ${t('modals.countryBrief.signals.climate')}</span>`);
    if (signals.conflictEvents > 0) chips.push(`<span class="signal-chip conflict">⚔️ ${signals.conflictEvents} ${t('modals.countryBrief.signals.conflictEvents')}</span>`);
    chips.push(`<span class="signal-chip stock-loading">📈 ${t('modals.countryBrief.loadingIndex')}</span>`);
    return chips.join('');
  }

  public setShareStoryHandler(handler: (code: string, name: string) => void): void {
    this.onShareStory = handler;
  }

  public setExportImageHandler(handler: (code: string, name: string) => void): void {
    this.onExportImage = handler;
  }

  public showLoading(): void {
    this.currentCode = '__loading__';
    this.overlay.innerHTML = `
      <div class="country-brief-page">
        <div class="cb-header">
          <div class="cb-header-left">
            <span class="cb-flag">🌍</span>
            <span class="cb-country-name">${t('modals.countryBrief.identifying')}</span>
          </div>
          <div class="cb-header-right">
            <button class="cb-close" aria-label="${t('components.newsPanel.close')}">×</button>
          </div>
        </div>
        <div class="cb-body">
          <div class="cb-loading-state">
            <div class="intel-skeleton"></div>
            <div class="intel-skeleton short"></div>
            <span class="intel-loading-text">${t('modals.countryBrief.locating')}</span>
          </div>
        </div>
      </div>`;
    this.overlay.querySelector('.cb-close')?.addEventListener('click', () => this.hide());
    this.overlay.classList.add('active');
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public show(country: string, code: string, score: CountryScore | null, signals: CountryBriefSignals): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.currentCode = code;
    this.currentName = country;
    this.currentScore = score;
    this.currentSignals = signals;
    this.currentBrief = null;
    this.currentHeadlines = [];
    this.currentHeadlineCount = 0;
    const flag = this.countryFlag(code);

    const tierBadge = !signals.isTier1
      ? `<span class="cb-tier-badge">${t('modals.countryBrief.limitedCoverage')}</span>`
      : '';

    this.overlay.innerHTML = `
      <div class="country-brief-page">
        <div class="cb-header">
          <div class="cb-header-left">
            <span class="cb-flag">${flag}</span>
            <span class="cb-country-name">${escapeHtml(country)}</span>
            ${score ? this.levelBadge(score.level) : ''}
            ${score ? this.trendIndicator(score.trend) : ''}
            ${tierBadge}
          </div>
          <div class="cb-header-right">
            <button class="cb-share-btn" title="${t('components.countryBrief.shareStory')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </button>
            <button class="cb-print-btn" title="${t('components.countryBrief.printPdf')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            </button>
            <div style="position:relative;display:inline-block">
              <button class="cb-export-btn" title="${t('components.countryBrief.exportData')}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <div class="cb-export-menu hidden">
                <button class="cb-export-option" data-format="image">${t('common.exportImage')}</button>
                <button class="cb-export-option" data-format="pdf">${t('common.exportPdf')}</button>
                <button class="cb-export-option" data-format="json">${t('common.exportJson')}</button>
                <button class="cb-export-option" data-format="csv">${t('common.exportCsv')}</button>
              </div>
            </div>
            <button class="cb-close" aria-label="${t('components.newsPanel.close')}">×</button>
          </div>
        </div>
        <div class="cb-body">
          <div class="cb-grid">
            <div class="cb-col-left">
              ${score ? `
                <section class="cb-section cb-risk-section">
                  <h3 class="cb-section-title">${t('modals.countryBrief.instabilityIndex')}</h3>
                  <div class="cb-risk-content">
                    ${this.scoreRing(score.score, score.level)}
                    <div class="cb-components">
                      ${this.componentBars(score.components)}
                    </div>
                  </div>
                </section>` : signals.isTier1 ? '' : `
                <section class="cb-section cb-risk-section">
                  <h3 class="cb-section-title">${t('modals.countryBrief.instabilityIndex')}</h3>
                  <div class="cb-not-tracked">
                    <span class="cb-not-tracked-icon">📊</span>
                    <span>${t('modals.countryBrief.notTracked', { country: escapeHtml(country) })}</span>
                  </div>
                </section>`}

              <section class="cb-section cb-brief-section">
                <h3 class="cb-section-title">${t('modals.countryBrief.intelBrief')}</h3>
                <div class="cb-brief-content">
                  <div class="intel-brief-loading">
                    <div class="intel-skeleton"></div>
                    <div class="intel-skeleton short"></div>
                    <div class="intel-skeleton"></div>
                    <div class="intel-skeleton short"></div>
                    <span class="intel-loading-text">${t('modals.countryBrief.generatingBrief')}</span>
                  </div>
                </div>
              </section>

              <section class="cb-section cb-news-section" style="display:none">
                <h3 class="cb-section-title">${t('modals.countryBrief.topNews')}</h3>
                <div class="cb-news-content"></div>
              </section>
            </div>

            <div class="cb-col-right">
              <section class="cb-section cb-signals-section">
                <h3 class="cb-section-title">${t('modals.countryBrief.activeSignals')}</h3>
                <div class="cb-signals-grid">
                  ${this.signalChips(signals)}
                </div>
              </section>

              <section class="cb-section cb-timeline-section">
                <h3 class="cb-section-title">${t('modals.countryBrief.timeline')}</h3>
                <div class="cb-timeline-mount"></div>
              </section>

              <section class="cb-section cb-markets-section">
                <h3 class="cb-section-title">${t('modals.countryBrief.predictionMarkets')}</h3>
                <div class="cb-markets-content">
                  <span class="intel-loading-text">${t('modals.countryBrief.loadingMarkets')}</span>
                </div>
              </section>

              <section class="cb-section cb-infra-section" style="display:none">
                <h3 class="cb-section-title">${t('modals.countryBrief.infrastructure')}</h3>
                <div class="cb-infra-content"></div>
              </section>

            </div>
          </div>
        </div>
      </div>`;

    this.overlay.querySelector('.cb-close')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.cb-share-btn')?.addEventListener('click', () => {
      if (this.onShareStory && this.currentCode && this.currentName) {
        this.onShareStory(this.currentCode, this.currentName);
      }
    });
    this.overlay.querySelector('.cb-print-btn')?.addEventListener('click', () => {
      window.print();
    });

    const exportBtn = this.overlay.querySelector('.cb-export-btn');
    const exportMenu = this.overlay.querySelector('.cb-export-menu');
    exportBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu?.classList.toggle('hidden');
    });
    this.overlay.querySelectorAll('.cb-export-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const format = (opt as HTMLElement).dataset.format;
        if (format === 'image') {
          if (this.onExportImage && this.currentCode && this.currentName) {
            this.onExportImage(this.currentCode, this.currentName);
          }
        } else if (format === 'pdf') {
          this.exportPdf();
        } else {
          this.exportBrief(format as 'json' | 'csv');
        }
        exportMenu?.classList.add('hidden');
      });
    });
    // Remove previous overlay-level listeners to prevent accumulation
    if (this.boundExportMenuClose) this.overlay.removeEventListener('click', this.boundExportMenuClose);
    if (this.boundCitationClick) this.overlay.removeEventListener('click', this.boundCitationClick);

    this.boundExportMenuClose = () => exportMenu?.classList.add('hidden');
    this.overlay.addEventListener('click', this.boundExportMenuClose);

    this.boundCitationClick = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('cb-citation')) {
        e.preventDefault();
        const href = target.getAttribute('href');
        if (href) {
          const el = this.overlay.querySelector(href);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el?.classList.add('cb-news-highlight');
          setTimeout(() => el?.classList.remove('cb-news-highlight'), 2000);
        }
      }
    };
    this.overlay.addEventListener('click', this.boundCitationClick);

    this.overlay.classList.add('active');
  }

  public updateBrief(data: CountryIntelData): void {
    if (data.code !== this.currentCode) return;
    const section = this.overlay.querySelector('.cb-brief-content');
    if (!section) return;

    if (data.error || data.skipped || !data.brief) {
      const msg = data.error || data.reason || t('modals.countryBrief.briefUnavailable');
      section.innerHTML = `<div class="intel-error">${escapeHtml(msg)}</div>`;
      return;
    }

    this.currentBrief = data.brief;
    const formatted = this.formatBrief(data.brief, this.currentHeadlineCount);
    section.innerHTML = `
      <div class="cb-brief-text">${formatted}</div>
      <div class="cb-brief-footer">
        ${data.cached ? `<span class="intel-cached">📋 ${t('modals.countryBrief.cached')}</span>` : `<span class="intel-fresh">✨ ${t('modals.countryBrief.fresh')}</span>`}
        <span class="intel-timestamp">${data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ''}</span>
      </div>`;
  }

  public updateMarkets(markets: PredictionMarket[]): void {
    const section = this.overlay.querySelector('.cb-markets-content');
    if (!section) return;

    if (markets.length === 0) {
      section.innerHTML = `<span class="cb-empty">${t('modals.countryBrief.noMarkets')}</span>`;
      return;
    }

    section.innerHTML = markets.slice(0, 3).map(m => {
      const pct = Math.round(m.yesPrice);
      const noPct = 100 - pct;
      const vol = m.volume ? `$${(m.volume / 1000).toFixed(0)}k vol` : '';
      const safeUrl = sanitizeUrl(m.url || '');
      const link = safeUrl ? ` <a href="${safeUrl}" target="_blank" rel="noopener" class="cb-market-link">↗</a>` : '';
      return `
        <div class="cb-market-item">
          <div class="cb-market-title">${escapeHtml(m.title.slice(0, 100))}${link}</div>
          <div class="market-bar">
            <div class="market-yes" style="width:${pct}%">${pct}%</div>
            <div class="market-no" style="width:${noPct}%">${noPct > 15 ? noPct + '%' : ''}</div>
          </div>
          ${vol ? `<div class="market-vol">${vol}</div>` : ''}
        </div>`;
    }).join('');
  }

  public updateStock(data: StockIndexData): void {
    const el = this.overlay.querySelector('.stock-loading');
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

  public updateNews(headlines: NewsItem[]): void {
    const section = this.overlay.querySelector('.cb-news-section') as HTMLElement | null;
    const content = this.overlay.querySelector('.cb-news-content');
    if (!section || !content || headlines.length === 0) return;

    const items = headlines.slice(0, 8);
    this.currentHeadlineCount = items.length;
    this.currentHeadlines = items;
    section.style.display = '';

    content.innerHTML = items.map((item, i) => {
      const safeUrl = sanitizeUrl(item.link);
      const threatColor = item.threat?.level === 'critical' ? getCSSColor('--threat-critical')
        : item.threat?.level === 'high' ? getCSSColor('--threat-high')
        : item.threat?.level === 'medium' ? getCSSColor('--threat-medium')
        : getCSSColor('--threat-info');
      const timeAgo = this.timeAgo(item.pubDate);
      const cardBody = `
        <span class="cb-news-threat" style="background:${threatColor}"></span>
        <div class="cb-news-body">
          <div class="cb-news-title">${escapeHtml(item.title)}</div>
          <div class="cb-news-meta">${escapeHtml(item.source)} · ${timeAgo}</div>
        </div>`;
      if (safeUrl) {
        return `<a href="${safeUrl}" target="_blank" rel="noopener" class="cb-news-card" id="cb-news-${i + 1}">${cardBody}</a>`;
      }
      return `<div class="cb-news-card" id="cb-news-${i + 1}">${cardBody}</div>`;
    }).join('');
  }


  public updateInfrastructure(countryCode: string): void {
    const bounds = CountryBriefPage.BRIEF_BOUNDS[countryCode];
    if (!bounds) return;

    const centroidLat = (bounds.n + bounds.s) / 2;
    const centroidLon = (bounds.e + bounds.w) / 2;

    const assets = getNearbyInfrastructure(centroidLat, centroidLon, ['pipeline', 'cable', 'datacenter', 'base', 'nuclear']);

    const nearbyPorts = PORTS
      .map((p: Port) => ({ port: p, dist: haversineDistanceKm(centroidLat, centroidLon, p.lat, p.lon) }))
      .filter(({ dist }) => dist <= 600)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);

    const grouped = new Map<BriefAssetType, Array<{ name: string; distanceKm: number }>>();
    for (const a of assets) {
      const list = grouped.get(a.type) || [];
      list.push({ name: a.name, distanceKm: a.distanceKm });
      grouped.set(a.type, list);
    }
    if (nearbyPorts.length > 0) {
      grouped.set('port', nearbyPorts.map(({ port, dist }) => ({ name: port.name, distanceKm: dist })));
    }

    if (grouped.size === 0) return;

    const section = this.overlay.querySelector('.cb-infra-section') as HTMLElement | null;
    const content = this.overlay.querySelector('.cb-infra-content');
    if (!section || !content) return;

    const order: BriefAssetType[] = ['pipeline', 'cable', 'datacenter', 'base', 'nuclear', 'port'];
    let html = '';
    for (const type of order) {
      const items = grouped.get(type);
      if (!items || items.length === 0) continue;
      const icon = CountryBriefPage.INFRA_ICONS[type];
      const key = CountryBriefPage.INFRA_LABELS[type];
      const label = t(`modals.countryBrief.infra.${key}`);
      html += `<div class="cb-infra-group">`;
      html += `<div class="cb-infra-type">${icon} ${label}</div>`;
      for (const item of items) {
        html += `<div class="cb-infra-item"><span>${escapeHtml(item.name)}</span><span class="cb-infra-dist">${Math.round(item.distanceKm)} km</span></div>`;
      }
      html += `</div>`;
    }

    content.innerHTML = html;
    section.style.display = '';
  }

  public getTimelineMount(): HTMLElement | null {
    return this.overlay.querySelector('.cb-timeline-mount');
  }

  public getCode(): string | null {
    return this.currentCode;
  }

  public getName(): string | null {
    return this.currentName;
  }

  private timeAgo(date: Date): string {
    const ms = Date.now() - new Date(date).getTime();
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return t('modals.countryBrief.timeAgo.m', { count: Math.floor(ms / 60000) });
    if (hours < 24) return t('modals.countryBrief.timeAgo.h', { count: hours });
    return t('modals.countryBrief.timeAgo.d', { count: Math.floor(hours / 24) });
  }

  private formatBrief(text: string, headlineCount = 0): string {
    let html = escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');

    if (headlineCount > 0) {
      html = html.replace(/\[(\d{1,2})\]/g, (_match, numStr) => {
        const n = parseInt(numStr, 10);
        if (n >= 1 && n <= headlineCount) {
          return `<a href="#cb-news-${n}" class="cb-citation" title="${t('components.countryBrief.sourceRef', { n: String(n) })}">[${n}]</a>`;
        }
        return `[${numStr}]`;
      });
    }

    return html;
  }

  private exportBrief(format: 'json' | 'csv'): void {
    if (!this.currentCode || !this.currentName) return;
    const data: CountryBriefExport = {
      country: this.currentName,
      code: this.currentCode,
      generatedAt: new Date().toISOString(),
    };
    if (this.currentScore) {
      data.score = this.currentScore.score;
      data.level = this.currentScore.level;
      data.trend = this.currentScore.trend;
      data.components = this.currentScore.components;
    }
    if (this.currentSignals) {
      data.signals = {
        protests: this.currentSignals.protests,
        militaryFlights: this.currentSignals.militaryFlights,
        militaryVessels: this.currentSignals.militaryVessels,
        outages: this.currentSignals.outages,
        earthquakes: this.currentSignals.earthquakes,
        displacementOutflow: this.currentSignals.displacementOutflow,
        climateStress: this.currentSignals.climateStress,
        conflictEvents: this.currentSignals.conflictEvents,
      };
    }
    if (this.currentBrief) data.brief = this.currentBrief;
    if (this.currentHeadlines.length > 0) {
      data.headlines = this.currentHeadlines.map(h => ({
        title: h.title,
        source: h.source,
        link: h.link,
        pubDate: h.pubDate ? new Date(h.pubDate).toISOString() : undefined,
      }));
    }
    if (format === 'json') exportCountryBriefJSON(data);
    else exportCountryBriefCSV(data);
  }

  private exportPdf(): void {
    const content = this.overlay.querySelector('.cb-body');
    const header = this.overlay.querySelector('.cb-header');
    if (!content) return;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;border:none';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) { document.body.removeChild(iframe); return; }

    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
      .map(el => el.outerHTML).join('\n');

    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8">${styles}
      <style>
        @media print { body { margin: 0; padding: 16px; background: #fff; color: #111; }
          .cb-grid { display: block !important; }
          .cb-grid > * { break-inside: avoid; margin-bottom: 16px; }
          .cb-badge, .cb-trend { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          canvas { max-width: 100% !important; }
        }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .country-brief-overlay { position: static !important; background: none !important; }
      </style>
    </head><body>${header ? header.outerHTML : ''}${content.outerHTML}</body></html>`);
    doc.close();

    iframe.contentWindow!.onafterprint = () => document.body.removeChild(iframe);
    setTimeout(() => {
      iframe.contentWindow!.print();
      setTimeout(() => { if (iframe.parentNode) document.body.removeChild(iframe); }, 5000);
    }, 300);
  }

  public hide(): void {
    this.abortController.abort();
    this.overlay.classList.remove('active');
    this.currentCode = null;
    this.currentName = null;
    this.onCloseCallback?.();
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public isVisible(): boolean {
    return this.overlay.classList.contains('active');
  }
}
