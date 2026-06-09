/**
 * Left-rail summary card for the Route Explorer. Always visible across
 * all tabs, shows transit/freight/risk at a glance plus the destination
 * country's resilience score.
 *
 * Sprint 3: route summary + resilience + risk.
 * Sprint 4 will add dependency flags from get-route-impact.
 */

import type { GetRouteExplorerLaneResponse, DependencyFlag } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  formatTransitRange,
  formatFreightRange,
  formatDisruptionScore,
  disruptionScoreClass,
  warRiskTierLabel,
  warRiskTierClass,
  escapeHtml,
} from '../tabs/route-utils';
import { getCurrentLanguage } from '@/services/i18n';

export class LeftRail {
  public readonly element: HTMLElement;
  private resilienceScore: number | null = null;

  constructor() {
    const ja = getCurrentLanguage() === 'ja';
    this.element = document.createElement('aside');
    this.element.className = 're-leftrail';
    this.element.setAttribute('aria-label', ja ? 'ルート概要' : 'Lane summary');
    this.renderPlaceholder();
  }

  public updateLane(data: GetRouteExplorerLaneResponse | null, mode?: 'loading' | 'error' | 'gate'): void {
    this.resilienceScore = null;
    if (mode === 'loading') { this.renderLoading(); return; }
    if (mode === 'error') { this.renderError(); return; }
    if (mode === 'gate') { this.renderGate(); return; }
    if (!data || data.noModeledLane) { this.renderNoLane(); return; }
    this.renderSummary(data);
  }

  public updateResilience(score: number | null): void {
    this.resilienceScore = score;
    const el = this.element.querySelector('.re-leftrail__resilience-value');
    if (el) {
      el.textContent = score !== null ? `${Math.round(score)}/100` : '\u2014';
    }
  }

  private renderPlaceholder(): void {
    const ja = getCurrentLanguage() === 'ja';
    this.element.innerHTML =
      `<div class="re-leftrail__placeholder">${ja ? '国の組み合わせと製品を選ぶと、ルート概要が表示されます。' : 'Pick a country pair and product to see the lane summary.'}</div>`;
  }

  private renderNoLane(): void {
    const ja = getCurrentLanguage() === 'ja';
    this.element.innerHTML =
      `<div class="re-leftrail__empty">${ja ? 'この組み合わせにはモデル化されたルートがありません。' : 'No modeled lane for this pair.'}</div>`;
  }

  private renderLoading(): void {
    const ja = getCurrentLanguage() === 'ja';
    this.element.innerHTML =
      `<div class="re-leftrail__placeholder">${ja ? 'ルートデータを読み込み中…' : 'Loading lane data\u2026'}</div>`;
  }

  private renderError(): void {
    const ja = getCurrentLanguage() === 'ja';
    this.element.innerHTML =
      `<div class="re-leftrail__empty">${ja ? 'ルートデータの読み込みに失敗しました。' : 'Failed to load lane data.'}</div>`;
  }

  private renderGate(): void {
    const ja = getCurrentLanguage() === 'ja';
    this.element.innerHTML =
      `<div class="re-leftrail__empty">${ja ? 'ルートインテリジェンスは PRO で利用できます。' : 'Upgrade to PRO for route intelligence.'}</div>`;
  }

  private static readonly FLAG_LABELS: Record<string, string> = {
    DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL: 'Single Source Critical',
    DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL: 'Single Corridor Critical',
    DEPENDENCY_FLAG_COMPOUND_RISK: 'Compound Risk',
    DEPENDENCY_FLAG_DIVERSIFIABLE: 'Diversifiable',
  };

  public updateDependencyFlags(flags: DependencyFlag[]): void {
    const el = this.element.querySelector('.re-leftrail__card--flags');
    if (!el) return;
    if (flags.length === 0) {
      el.innerHTML = `<h3 class="re-leftrail__title">${getCurrentLanguage() === 'ja' ? '依存フラグ' : 'Dependency Flags'}</h3><div class="re-leftrail__placeholder-text">${getCurrentLanguage() === 'ja' ? '重大な依存関係は検出されていません' : 'No critical dependencies identified'}</div>`;
      return;
    }
    const flagHtml = flags.map((f) =>
      `<span class="re-leftrail__flag re-leftrail__flag--${f.toLowerCase().replace(/^dependency_flag_/, '')}">${escapeHtml(LeftRail.FLAG_LABELS[f] ?? f)}</span>`,
    ).join('');
    el.innerHTML = `<h3 class="re-leftrail__title">${getCurrentLanguage() === 'ja' ? '依存フラグ' : 'Dependency Flags'}</h3><div class="re-leftrail__flags">${flagHtml}</div>`;
  }

  private renderSummary(data: GetRouteExplorerLaneResponse): void {
    const ja = getCurrentLanguage() === 'ja';
    const riskCls = warRiskTierClass(data.warRiskTier);
    const disruptCls = disruptionScoreClass(data.disruptionScore);
    const resValue = this.resilienceScore !== null ? `${Math.round(this.resilienceScore)}/100` : '\u2014';

    this.element.innerHTML = [
      '<div class="re-leftrail__card">',
      `  <h3 class="re-leftrail__title">${ja ? 'ルート概要' : 'Route Summary'}</h3>`,
      '  <div class="re-leftrail__row">',
      `    <span class="re-leftrail__label">${ja ? '輸送日数' : 'Transit'}</span>`,
      `    <span class="re-leftrail__value">${formatTransitRange(data.estTransitDaysRange)}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      `    <span class="re-leftrail__label">${ja ? '推定運賃' : 'Freight (est.)'}</span>`,
      `    <span class="re-leftrail__value">${formatFreightRange(data.estFreightUsdPerTeuRange, data.cargoType)}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      `    <span class="re-leftrail__label">${ja ? '戦争リスク' : 'War Risk'}</span>`,
      `    <span class="re-leftrail__value ${riskCls}">${escapeHtml(warRiskTierLabel(data.warRiskTier))}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      `    <span class="re-leftrail__label">${ja ? '寸断度' : 'Disruption'}</span>`,
      `    <span class="re-leftrail__value ${disruptCls}">${formatDisruptionScore(data.disruptionScore)}</span>`,
      '  </div>',
      '</div>',
      '<div class="re-leftrail__card">',
      `  <h3 class="re-leftrail__title">${ja ? '耐性' : 'Resilience'}</h3>`,
      '  <div class="re-leftrail__row">',
      `    <span class="re-leftrail__label">${escapeHtml(data.toIso2)} score</span>`,
      `    <span class="re-leftrail__value re-leftrail__resilience-value">${resValue}</span>`,
      '  </div>',
      '</div>',
      '<div class="re-leftrail__card re-leftrail__card--flags">',
      '  <h3 class="re-leftrail__title">依存フラグ</h3>',
      '  <div class="re-leftrail__placeholder-text">影響タブで順次表示します</div>',
      '</div>',
    ].join('\n');
  }
}
