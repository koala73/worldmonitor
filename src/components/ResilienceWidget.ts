import { DEFAULT_UPGRADE_PRODUCT } from '@/config/products';
import { type AuthSession, getAuthState, subscribeAuthState } from '@/services/auth-state';
import { openSignIn } from '@/services/clerk';
import { PanelGateReason, getPanelGateReason } from '@/services/panel-gating';
import { getResilienceScore, type ResilienceDomain, type ResilienceScoreResponse } from '@/services/resilience';
import { isDesktopRuntime } from '@/services/runtime';
import { invokeTauri } from '@/services/tauri-bridge';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  type DimensionConfidence,
  LOCKED_PREVIEW,
  RESILIENCE_VISUAL_LEVEL_COLORS,
  collectDimensionConfidences,
  formatBaselineStress,
  formatResilienceChange30d,
  formatResilienceConfidence,
  formatResilienceDataVersion,
  getImputationClassIcon,
  getImputationClassLabel,
  getResilienceDomainLabel,
  getResilienceTrendArrow,
  getResilienceVisualLevel,
  getStalenessLabel,
} from './resilience-widget-utils';
import type { CountryEnergyProfileData } from './CountryBriefPanel';

// LOCKED_PREVIEW lives in resilience-widget-utils.ts so tests and
// other non-Vite consumers can import it without dragging in the
// full ResilienceWidget class transitive graph (the class indirectly
// depends on import.meta.env.DEV via proxy.ts, which breaks plain
// node test runners). Moved in the PR #2949 review round.

function normalizeCountryCode(countryCode: string | null | undefined): string | null {
  const normalized = String(countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

export class ResilienceWidget {
  private readonly element: HTMLElement;
  private authState: AuthSession = getAuthState();
  private unsubscribeAuth: (() => void) | null = null;
  private currentCountryCode: string | null = null;
  private currentData: ResilienceScoreResponse | null = null;
  private loading = false;
  private errorMessage: string | null = null;
  private requestVersion = 0;
  private energyMixData: CountryEnergyProfileData | null = null;

  constructor(countryCode?: string | null) {
    this.element = document.createElement('section');
    this.element.className = 'cdp-card resilience-widget';
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.authState = state;
      const gateReason = this.getGateReason();
      if (gateReason === PanelGateReason.NONE && this.currentCountryCode && !this.loading && this.currentData?.countryCode !== this.currentCountryCode) {
        void this.refresh();
        return;
      }
      this.render();
    });

    this.setCountryCode(countryCode ?? null);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public setCountryCode(countryCode: string | null): void {
    const normalized = normalizeCountryCode(countryCode);
    if (normalized === this.currentCountryCode) return;

    this.currentCountryCode = normalized;
    this.currentData = null;
    this.energyMixData = null;
    this.errorMessage = null;
    this.loading = false;
    this.requestVersion += 1;

    if (!normalized) {
      this.render();
      return;
    }

    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.currentCountryCode) {
      this.render();
      return;
    }

    if (this.authState.isPending || this.getGateReason() !== PanelGateReason.NONE) {
      this.render();
      return;
    }

    const requestVersion = ++this.requestVersion;
    this.loading = true;
    this.errorMessage = null;
    this.render();

    try {
      const response = await getResilienceScore(this.currentCountryCode);
      if (requestVersion !== this.requestVersion) return;
      this.currentData = response;
      this.loading = false;
      this.errorMessage = null;
      this.render();
    } catch (error) {
      if (requestVersion !== this.requestVersion) return;
      this.loading = false;
      this.currentData = null;
      this.errorMessage = error instanceof Error ? error.message : 'Unable to load resilience score.';
      this.render();
    }
  }

  public setEnergyMix(data: CountryEnergyProfileData | null): void {
    this.energyMixData = data;
    this.render();
  }

  public destroy(): void {
    this.requestVersion += 1;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
  }

  private getGateReason(): PanelGateReason {
    return getPanelGateReason(this.authState, true);
  }

  private render(): void {
    const gateReason = this.getGateReason();
    const body = this.renderBody(gateReason);

    replaceChildren(
      this.element,
      h(
        'div',
        { className: 'resilience-widget__header' },
        h('h3', { className: 'cdp-card-title resilience-widget__title' }, 'Resilience Score'),
        h(
          'span',
          {
            className: 'resilience-widget__help',
            title: 'Composite resilience score derived from economic, infrastructure, energy, social/governance, and health/food domains.',
            'aria-label': 'Resilience score methodology',
          },
          '?',
        ),
      ),
      body,
    );
  }

  private renderBody(gateReason: PanelGateReason): HTMLElement {
    if (!this.currentCountryCode) {
      return h('div', { className: 'cdp-card-body' }, this.makeEmpty('Resilience data loads when a country is selected.'));
    }

    if (this.authState.isPending) {
      return h('div', { className: 'cdp-card-body' }, this.makeLoading('Checking access…'));
    }

    if (gateReason !== PanelGateReason.NONE) {
      return this.renderLocked(gateReason);
    }

    if (this.loading) {
      return h('div', { className: 'cdp-card-body' }, this.makeLoading('Loading resilience score…'));
    }

    if (this.errorMessage) {
      return this.renderError(this.errorMessage);
    }

    if (!this.currentData) {
      return h('div', { className: 'cdp-card-body' }, this.makeEmpty('Resilience score unavailable.'));
    }

    return this.renderScoreCard(this.currentData);
  }

  private renderLocked(gateReason: PanelGateReason): HTMLElement {
    const description = gateReason === PanelGateReason.ANONYMOUS
      ? 'Sign in to unlock premium resilience scores.'
      : 'Upgrade to Pro to unlock resilience scores.';
    const cta = gateReason === PanelGateReason.ANONYMOUS ? 'Sign In' : 'Upgrade to Pro';

    const preview = this.renderScoreCard(LOCKED_PREVIEW, true);
    preview.classList.add('resilience-widget__preview');

    const button = h('button', {
      type: 'button',
      className: 'panel-locked-cta resilience-widget__cta',
      onclick: () => {
        if (gateReason === PanelGateReason.ANONYMOUS) {
          openSignIn();
          return;
        }
        this.openUpgradeFlow();
      },
    }, cta) as HTMLButtonElement;

    return h(
      'div',
      { className: 'cdp-card-body resilience-widget__locked' },
      preview,
      h('div', { className: 'panel-locked-desc resilience-widget__gate-desc' }, description),
      button,
    );
  }

  private renderError(message: string): HTMLElement {
    return h(
      'div',
      { className: 'cdp-card-body resilience-widget__error' },
      h('div', { className: 'cdp-empty' }, message),
      h(
        'button',
        {
          type: 'button',
          className: 'cdp-action-btn resilience-widget__retry',
          onclick: () => void this.refresh(),
        },
        'Retry',
      ),
    );
  }

  private renderScoreCard(data: ResilienceScoreResponse, preview = false): HTMLElement {
    const visualLevel = getResilienceVisualLevel(data.overallScore);
    const levelLabel = visualLevel.replace('_', ' ').toUpperCase();
    const levelColor = RESILIENCE_VISUAL_LEVEL_COLORS[visualLevel];

    return h(
      'div',
      { className: 'cdp-card-body resilience-widget__body' },
      h(
        'div',
        { className: 'resilience-widget__overall' },
        this.renderBarBlock(
          clampScore(data.overallScore),
          levelColor,
          h(
            'div',
            { className: 'resilience-widget__overall-meta' },
            h('span', { className: 'resilience-widget__overall-score' }, String(Math.round(clampScore(data.overallScore)))),
            ...(data.scoreInterval
              ? [h('span', {
                  className: 'resilience-widget__overall-interval',
                  title: `95% confidence interval: ${data.scoreInterval.p05} - ${data.scoreInterval.p95}`,
                }, `[${Math.round(data.scoreInterval.p05)}\u2013${Math.round(data.scoreInterval.p95)}]`)]
              : []),
            h('span', { className: 'resilience-widget__overall-level', style: { color: levelColor } }, levelLabel),
            h('span', { className: 'resilience-widget__overall-trend' }, `${getResilienceTrendArrow(data.trend)} ${data.trend}`),
          ),
        ),
      ),
      ...(data.baselineScore != null && data.stressScore != null
        ? [h(
            'div',
            { className: 'resilience-widget__baseline-stress' },
            h('span', { className: 'resilience-widget__baseline-stress-text' },
              formatBaselineStress(data.baselineScore, data.stressScore)),
          )]
        : []),
      h(
        'div',
        { className: 'resilience-widget__domains' },
        ...data.domains.map((domain) => this.renderDomainRow(domain, preview)),
      ),
      // T1.6 Phase 1 of the country-resilience reference-grade upgrade plan:
      // per-dimension confidence grid. Uses only the existing `coverage`,
      // `observedWeight`, `imputedWeight` fields on ResilienceDimension so
      // this ships without proto changes. Imputation class icons (T1.7)
      // and freshness badges (T1.5 full pass) land as additional columns
      // once the schema exposes those fields through the response type.
      this.renderDimensionConfidenceGrid(data),
      h(
        'div',
        { className: 'resilience-widget__footer' },
        h(
          'span',
          {
            className: `resilience-widget__confidence${data.lowConfidence ? ' resilience-widget__confidence--low' : ''}`,
            title: preview ? 'Preview only' : 'Coverage and imputation-based confidence signal.',
          },
          formatResilienceConfidence(data),
        ),
        h('span', { className: 'resilience-widget__delta' }, formatResilienceChange30d(data.change30d)),
        ...(() => {
          // Hoisted so the formatter (which runs a regex + Date parse) is
          // only invoked once per render instead of twice (guard + child).
          // Raised in review of PR #2943 for consistency with the existing
          // scoreInterval / baselineScore blocks in this file.
          const dataVersionLabel = formatResilienceDataVersion(data.dataVersion);
          return dataVersionLabel
            ? [h(
                'span',
                {
                  className: 'resilience-widget__data-version',
                  title: 'Date the underlying source data was last refreshed by the Railway static-seed job.',
                },
                dataVersionLabel,
              )]
            : [];
        })(),
      ),
    );
  }

  private renderDimensionConfidenceGrid(data: ResilienceScoreResponse): HTMLElement {
    const dimensions = collectDimensionConfidences(data.domains);
    return h(
      'div',
      {
        className: 'resilience-widget__dimension-grid',
        title: 'Per-dimension data coverage. Hover a cell for the coverage percentage and observation provenance.',
      },
      ...dimensions.map((dim) => this.renderDimensionConfidenceCell(dim)),
    );
  }

  private renderDimensionConfidenceCell(dim: DimensionConfidence): HTMLElement {
    // Compose the tooltip from three independent fragments so the order
    // is stable regardless of which optional fields the scorer
    // populated. Imputation class + freshness are added by T1.7 / T1.5
    // and may both be null (observed + unknown cadence), in which case
    // only the base coverage string is shown.
    const titleParts: string[] = [
      dim.absent ? `${dim.label}: no data` : `${dim.label}: ${dim.coveragePct}% coverage, ${dim.status}`,
    ];
    if (dim.imputationClass) titleParts.push(getImputationClassLabel(dim.imputationClass));
    if (dim.staleness) titleParts.push(getStalenessLabel(dim.staleness));
    const title = titleParts.join(' | ');

    const imputationClassName = dim.imputationClass
      ? `resilience-widget__dimension-imputation resilience-widget__dimension-imputation--${dim.imputationClass}`
      : 'resilience-widget__dimension-imputation';
    const freshnessClassName = dim.staleness
      ? `resilience-widget__dimension-freshness resilience-widget__dimension-freshness--${dim.staleness}`
      : 'resilience-widget__dimension-freshness';

    return h(
      'div',
      {
        className: `resilience-widget__dimension-cell resilience-widget__dimension-cell--${dim.status}`,
        title,
      },
      h('span', { className: 'resilience-widget__dimension-label' }, dim.label),
      h(
        'div',
        { className: 'resilience-widget__dimension-bar-track' },
        h('div', {
          className: 'resilience-widget__dimension-bar-fill',
          style: { width: `${dim.coveragePct}%` },
        }),
      ),
      h(
        'span',
        {
          className: imputationClassName,
          'aria-label': dim.imputationClass ? getImputationClassLabel(dim.imputationClass) : undefined,
        },
        dim.imputationClass ? getImputationClassIcon(dim.imputationClass) : '',
      ),
      h('span', { className: 'resilience-widget__dimension-pct' }, dim.absent ? 'n/a' : `${dim.coveragePct}%`),
      h(
        'span',
        {
          className: freshnessClassName,
          'aria-label': dim.staleness ? getStalenessLabel(dim.staleness) : undefined,
        },
        dim.staleness ? '\u25CF' : '',
      ),
    );
  }

  private renderDomainRow(domain: ResilienceDomain, preview = false): HTMLElement {
    const score = clampScore(domain.score);
    const levelColor = RESILIENCE_VISUAL_LEVEL_COLORS[getResilienceVisualLevel(score)];

    const attrs: Record<string, string> = { className: 'resilience-widget__domain-row' };

    if (!preview && domain.id === 'energy' && this.energyMixData?.mixAvailable) {
      const d = this.energyMixData;
      const parts = [
        `Import dep: ${d.importShare.toFixed(1)}%`,
        `Gas: ${d.gasShare.toFixed(1)}%`,
        `Coal: ${d.coalShare.toFixed(1)}%`,
        `Renew: ${d.renewShare.toFixed(1)}%`,
      ];
      if (d.gasStorageAvailable) parts.push(`EU storage: ${d.gasStorageFillPct.toFixed(1)}%`);
      attrs['title'] = parts.join(' | ');
    }

    return h(
      'div',
      attrs,
      h('span', { className: 'resilience-widget__domain-label' }, getResilienceDomainLabel(domain.id)),
      this.renderBarBlock(score, levelColor),
      h('span', { className: 'resilience-widget__domain-score' }, String(Math.round(score))),
    );
  }

  private renderBarBlock(score: number, color: string, trailing?: HTMLElement): HTMLElement {
    return h(
      'div',
      { className: 'resilience-widget__bar-block' },
      h(
        'div',
        { className: 'resilience-widget__bar-track' },
        h('div', {
          className: 'resilience-widget__bar-fill',
          style: {
            width: `${score}%`,
            background: color,
          },
        }),
      ),
      trailing ?? null,
    );
  }

  private makeLoading(text: string): HTMLElement {
    return h(
      'div',
      { className: 'cdp-loading-inline' },
      h('div', { className: 'cdp-loading-line' }),
      h('div', { className: 'cdp-loading-line cdp-loading-line-short' }),
      h('span', { className: 'cdp-loading-text' }, text),
    );
  }

  private makeEmpty(text: string): HTMLElement {
    return h('div', { className: 'cdp-empty' }, text);
  }

  private openUpgradeFlow(): void {
    if (isDesktopRuntime()) {
      void invokeTauri<void>('open_url', { url: 'https://worldmonitor.app/pro' })
        .catch(() => window.open('https://worldmonitor.app/pro', '_blank'));
      return;
    }

    import('@/services/checkout')
      .then((module) => module.startCheckout(DEFAULT_UPGRADE_PRODUCT))
      .catch(() => {
        window.open('https://worldmonitor.app/pro', '_blank');
      });
  }
}
