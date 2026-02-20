import type { CorrelationSignal } from '@/services/correlation';
import type { UnifiedAlert } from '@/services/cross-module-integration';
import { suppressTrendingTerm } from '@/services/trending-keywords';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import { getSignalContext, type SignalType } from '@/utils/analysis-constants';
import { t } from '@/services/i18n';

export class SignalModal {
  private element: HTMLElement;
  private currentSignals: CorrelationSignal[] = [];
  private audioEnabled = true;
  private audio: HTMLAudioElement | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'signal-modal-overlay';
    this.element.innerHTML = `
      <div class="signal-modal">
        <div class="signal-modal-header">
          <span class="signal-modal-title">🎯 ${t('modals.signal.title')}</span>
          <button class="signal-modal-close">×</button>
        </div>
        <div class="signal-modal-content"></div>
        <div class="signal-modal-footer">
          <label class="signal-audio-toggle">
            <input type="checkbox" checked>
            <span>${t('modals.signal.soundAlerts')}</span>
          </label>
          <button class="signal-dismiss-btn">${t('modals.signal.dismiss')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.element);
    this.setupEventListeners();
    this.initAudio();

    // Remove will-change after entrance animation to free GPU memory
    const modal = this.element.querySelector('.signal-modal') as HTMLElement | null;
    modal?.addEventListener('animationend', () => {
      modal.style.willChange = 'auto';
    }, { once: true });
  }

  private initAudio(): void {
    this.audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQYjfKapmWswEjCJvuPQfSoXZZ+3qqBJESSP0unGaxMJVYiytrFeLhR6p8znrFUXRW+bs7V3Qx1hn8Xjp1cYPnegprhkMCFmoLi1k0sZTYGlqqlUIA==');
    this.audio.volume = 0.3;
  }

  private setupEventListeners(): void {
    this.element.querySelector('.signal-modal-close')?.addEventListener('click', () => {
      this.hide();
    });

    this.element.querySelector('.signal-dismiss-btn')?.addEventListener('click', () => {
      this.hide();
    });

    this.element.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('signal-modal-overlay')) {
        this.hide();
      }
    });

    const checkbox = this.element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox?.addEventListener('change', () => {
      this.audioEnabled = checkbox.checked;
    });

    // Delegate click handler for location links
    this.element.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('location-link')) {
        const lat = parseFloat(target.dataset.lat || '0');
        const lon = parseFloat(target.dataset.lon || '0');
        if (this.onLocationClick && !isNaN(lat) && !isNaN(lon)) {
          this.onLocationClick(lat, lon);
          this.hide();
        }
        return;
      }

      if (target.classList.contains('suppress-keyword-btn')) {
        const term = (target.dataset.term || '').trim();
        if (!term) return;
        suppressTrendingTerm(term);
        this.currentSignals = this.currentSignals.filter(signal => {
          const signalTerm = (signal.data as Record<string, unknown>).term;
          return typeof signalTerm !== 'string' || signalTerm.toLowerCase() !== term.toLowerCase();
        });
        this.renderSignals();
      }
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public show(signals: CorrelationSignal[]): void {
    if (signals.length === 0) return;
    if (document.fullscreenElement) return;

    this.currentSignals = [...signals, ...this.currentSignals].slice(0, 50);
    this.renderSignals();
    this.element.classList.add('active');
    this.playSound();
  }

  public showSignal(signal: CorrelationSignal): void {
    this.currentSignals = [signal];
    this.renderSignals();
    this.element.classList.add('active');
  }

  public showAlert(alert: UnifiedAlert): void {
    if (document.fullscreenElement) return;
    const content = this.element.querySelector('.signal-modal-content')!;
    const priorityColors: Record<string, string> = {
      critical: getCSSColor('--semantic-critical'),
      high: getCSSColor('--semantic-high'),
      medium: getCSSColor('--semantic-low'),
      low: getCSSColor('--text-dim'),
    };
    const typeIcons: Record<string, string> = {
      cii_spike: '📊',
      convergence: '🌍',
      cascade: '⚡',
      composite: '🔗',
    };

    const icon = typeIcons[alert.type] || '⚠️';
    const color = priorityColors[alert.priority] || '#ff9944';

    let detailsHtml = '';

    // CII Change details
    if (alert.components.ciiChange) {
      const cii = alert.components.ciiChange;
      const changeSign = cii.change > 0 ? '+' : '';
      detailsHtml += `
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.country')}</span>
          <span class="context-value">${escapeHtml(cii.countryName)}</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.scoreChange')}</span>
          <span class="context-value">${cii.previousScore} → ${cii.currentScore} (${changeSign}${cii.change})</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.instabilityLevel')}</span>
          <span class="context-value" style="text-transform: uppercase; color: ${color}">${cii.level}</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.primaryDriver')}</span>
          <span class="context-value">${escapeHtml(cii.driver)}</span>
        </div>
      `;
    }

    // Convergence details
    if (alert.components.convergence) {
      const conv = alert.components.convergence;
      detailsHtml += `
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.location')}</span>
          <button class="location-link" data-lat="${conv.lat}" data-lon="${conv.lon}">${conv.lat.toFixed(2)}°, ${conv.lon.toFixed(2)}° ↗</button>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.eventTypes')}</span>
          <span class="context-value">${conv.types.join(', ')}</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.eventCount')}</span>
          <span class="context-value">${t('modals.signal.eventCountValue', { count: conv.totalEvents })}</span>
        </div>
      `;
    }

    // Cascade details
    if (alert.components.cascade) {
      const cascade = alert.components.cascade;
      detailsHtml += `
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.source')}</span>
          <span class="context-value">${escapeHtml(cascade.sourceName)} (${cascade.sourceType})</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.countriesAffected')}</span>
          <span class="context-value">${cascade.countriesAffected}</span>
        </div>
        <div class="signal-context-item">
          <span class="context-label">${t('modals.signal.impactLevel')}</span>
          <span class="context-value">${escapeHtml(cascade.highestImpact)}</span>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="signal-item" style="border-left-color: ${color}">
        <div class="signal-type">${icon} ${alert.type.toUpperCase().replace('_', ' ')}</div>
        <div class="signal-title">${escapeHtml(alert.title)}</div>
        <div class="signal-description">${escapeHtml(alert.summary)}</div>
        <div class="signal-meta">
          <span class="signal-confidence" style="background: ${color}22; color: ${color}">${alert.priority.toUpperCase()}</span>
          <span class="signal-time">${this.formatTime(alert.timestamp)}</span>
        </div>
        <div class="signal-context">
          ${detailsHtml}
        </div>
        ${alert.countries.length > 0 ? `
          <div class="signal-topics">
            ${alert.countries.map(c => `<span class="signal-topic">${escapeHtml(c)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    this.element.classList.add('active');
  }

  public playSound(): void {
    if (this.audioEnabled && this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }
  }

  public hide(): void {
    this.element.classList.remove('active');
  }

  private renderSignals(): void {
    const content = this.element.querySelector('.signal-modal-content')!;

    const signalTypeLabels: Record<string, string> = {
      prediction_leads_news: `🔮 ${t('modals.signal.predictionLeading')}`,
      news_leads_markets: `📰 ${t('modals.signal.newsLeading')}`,
      silent_divergence: `🔇 ${t('modals.signal.silentDivergence')}`,
      velocity_spike: `🔥 ${t('modals.signal.velocitySpike')}`,
      keyword_spike: `📊 ${t('modals.signal.keywordSpike')}`,
      convergence: `◉ ${t('modals.signal.convergence')}`,
      triangulation: `△ ${t('modals.signal.triangulation')}`,
      flow_drop: `🛢️ ${t('modals.signal.flowDrop')}`,
      flow_price_divergence: `📈 ${t('modals.signal.flowPriceDivergence')}`,
      geo_convergence: `🌐 ${t('modals.signal.geoConvergence')}`,
      explained_market_move: `✓ ${t('modals.signal.marketMove')}`,
      sector_cascade: `📊 ${t('modals.signal.sectorCascade')}`,
      military_surge: `🛩️ ${t('modals.signal.militarySurge')}`,
    };

    const html = this.currentSignals.map(signal => {
      const context = getSignalContext(signal.type as SignalType);
      // Military surge signals have additional properties in data
      const data = signal.data as Record<string, unknown>;
      const newsCorrelation = data?.newsCorrelation as string | null;
      const focalPoints = data?.focalPointContext as string[] | null;
      const locationData = { lat: data?.lat as number | undefined, lon: data?.lon as number | undefined, regionName: data?.regionName as string | undefined };

      return `
        <div class="signal-item ${escapeHtml(signal.type)}">
          <div class="signal-type">${signalTypeLabels[signal.type] || escapeHtml(signal.type)}</div>
          <div class="signal-title">${escapeHtml(signal.title)}</div>
          <div class="signal-description">${escapeHtml(signal.description)}</div>
          <div class="signal-meta">
            <span class="signal-confidence">${t('modals.signal.confidence')}: ${Math.round(signal.confidence * 100)}%</span>
            <span class="signal-time">${this.formatTime(signal.timestamp)}</span>
          </div>
          ${signal.data.explanation ? `
            <div class="signal-explanation">${escapeHtml(signal.data.explanation)}</div>
          ` : ''}
          ${focalPoints && focalPoints.length > 0 ? `
            <div class="signal-focal-points">
              <div class="focal-points-header">📡 ${t('modals.signal.focalPoints')}</div>
              ${focalPoints.map(fp => `<div class="focal-point-item">${escapeHtml(fp)}</div>`).join('')}
            </div>
          ` : ''}
          ${newsCorrelation ? `
            <div class="signal-news-correlation">
              <div class="news-correlation-header">📰 ${t('modals.signal.newsCorrelation')}</div>
              <pre class="news-correlation-text">${escapeHtml(newsCorrelation)}</pre>
            </div>
          ` : ''}
          ${locationData.lat && locationData.lon ? `
            <div class="signal-location">
              <button class="location-link" data-lat="${locationData.lat}" data-lon="${locationData.lon}">
                📍 ${t('modals.signal.viewOnMap')}: ${locationData.regionName || `${locationData.lat.toFixed(2)}°, ${locationData.lon.toFixed(2)}°`}
              </button>
            </div>
          ` : ''}
          <div class="signal-context">
            <div class="signal-context-item why-matters">
              <span class="context-label">${t('modals.signal.whyItMatters')}</span>
              <span class="context-value">${escapeHtml(context.whyItMatters)}</span>
            </div>
            <div class="signal-context-item actionable">
              <span class="context-label">${t('modals.signal.action')}</span>
              <span class="context-value">${escapeHtml(context.actionableInsight)}</span>
            </div>
            <div class="signal-context-item confidence-note">
              <span class="context-label">${t('modals.signal.note')}</span>
              <span class="context-value">${escapeHtml(context.confidenceNote)}</span>
            </div>
          </div>
          ${signal.data.relatedTopics?.length ? `
            <div class="signal-topics">
              ${signal.data.relatedTopics.map(t => `<span class="signal-topic">${escapeHtml(t)}</span>`).join('')}
            </div>
          ` : ''}
          ${signal.type === 'keyword_spike' && typeof data?.term === 'string' ? `
            <div class="signal-actions">
              <button class="suppress-keyword-btn" data-term="${escapeHtml(data.term)}">${t('modals.signal.suppress')}</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    content.innerHTML = html;
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
