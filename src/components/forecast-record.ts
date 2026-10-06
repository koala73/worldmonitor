import type { GetForecastScorecardResponse } from '@/services/forecast';
import { getLocale, t } from '@/services/i18n';
import { isDesktopRuntime } from '@/services/runtime';
import { CANONICAL_ORIGIN } from '@/config/schema-graph-ids';
import { escapeHtml } from '@/utils/sanitize';

interface GradedRecord {
  stale: boolean;
  /** Epoch ms the seeder built the scorecard; 0 when the response carried none. */
  generatedAt: number;
  windowDays: number;
}

/**
 * The track-record strip's state (#7074). `loading` is the panel's initial
 * value, `unavailable` covers a degraded response and a failed request, and
 * the other two come from a healthy response: `insufficient` when the headline
 * cohort has nothing graded, `ready` when it carries a Brier with a sample.
 */
export type ForecastRecord =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | ({ kind: 'insufficient' } & GradedRecord)
  | ({
      kind: 'ready';
      brier: number;
      graded: number;
      /** YES share of the graded cohort; null when the seed predates skill.yesCount (#8891). */
      yesShare: number | null;
      /** Null when nothing resolved, so a 0-of-0 rate is never shown. */
      voids: { count: number; resolved: number; rate: number } | null;
    } & GradedRecord);

const DEFAULT_WINDOW_DAYS = 180;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function projectForecastRecord(resp: GetForecastScorecardResponse): ForecastRecord {
  if (resp.degraded || resp.error) return { kind: 'unavailable' };
  const graded = {
    stale: resp.stale === true,
    generatedAt: finite(resp.generatedAt) && resp.generatedAt > 0 ? resp.generatedAt : 0,
    windowDays: finite(resp.rollingWindowDays) && resp.rollingWindowDays > 0 ? resp.rollingWindowDays : DEFAULT_WINDOW_DAYS,
  };
  const skill = resp.skill;
  const count = skill && finite(skill.count) ? skill.count : 0;
  if (!skill || count <= 0 || !finite(skill.brier)) return { kind: 'insufficient', ...graded };

  const yesShare = finite(skill.yesCount) && skill.yesCount >= 0 && skill.yesCount <= count
    ? skill.yesCount / count
    : null;
  const totals = resp.totals;
  const voids = totals && finite(totals.resolved) && totals.resolved > 0 && finite(totals.void) && finite(totals.voidRate)
    ? { count: totals.void, resolved: totals.resolved, rate: totals.voidRate }
    : null;
  return { kind: 'ready', ...graded, brier: skill.brier, graded: count, yesShare, voids };
}

/** Mirrors INTERVAL_MIN_SAMPLE in scripts/_forecast-scorecard.mjs; a test pins the two together. */
export const DOMAIN_RELIABILITY_MIN_SAMPLE = 30;

export type DomainReliability =
  | { kind: 'measured'; brier: number; n: number }
  | { kind: 'unmeasured'; n: number };

/** Per-domain scorecard rows for the card badges; null when the scorecard cannot vouch for them. */
export interface ReliabilityTable {
  windowDays: number;
  byDomain: ReadonlyMap<string, DomainReliability>;
}

export function projectReliability(resp: GetForecastScorecardResponse): ReliabilityTable | null {
  if (resp.degraded || resp.error) return null;
  const byDomain = new Map<string, DomainReliability>();
  for (const row of resp.byDomain ?? []) {
    const n = finite(row.scored) && row.scored > 0 ? row.scored : 0;
    byDomain.set(row.domain, n >= DOMAIN_RELIABILITY_MIN_SAMPLE && finite(row.brier)
      ? { kind: 'measured', brier: row.brier, n }
      : { kind: 'unmeasured', n });
  }
  const windowDays = finite(resp.rollingWindowDays) && resp.rollingWindowDays > 0 ? resp.rollingWindowDays : DEFAULT_WINDOW_DAYS;
  return { windowDays, byDomain };
}

/** A domain the scorecard has no row for has graded nothing yet, so it reads as unmeasured with n=0. */
export function renderReliabilityBadge(table: ReliabilityTable | null, domain: string, domainLabel: string): string {
  if (!table) return '';
  const r = table.byDomain.get(domain) ?? { kind: 'unmeasured', n: 0 };
  const days = table.windowDays;
  const [text, hint] = r.kind === 'measured'
    ? [
        t('components.forecast.reliability.measured', { domain: domainLabel, score: r.brier.toFixed(3), n: r.n }),
        t('components.forecast.reliability.measuredHint', { domain: domainLabel, n: r.n, days }),
      ]
    : [
        t('components.forecast.reliability.unmeasured'),
        t('components.forecast.reliability.unmeasuredHint', { domain: domainLabel, n: r.n, days, min: DOMAIN_RELIABILITY_MIN_SAMPLE }),
      ];
  return `<a class="fc-reliability" data-fc-reliability-state="${r.kind}" href="${escapeHtml(recordHref(isDesktopRuntime()))}" title="${escapeHtml(hint)}">${escapeHtml(text)}</a>`;
}

/** Brier of a forecaster who always answers the cohort's yes rate: p(1-p). */
export function baseRateBrier(yesShare: number): number {
  return yesShare * (1 - yesShare);
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function label(hint?: string): string {
  const title = hint ? ` title="${escapeHtml(hint)}"` : '';
  return `<span class="fc-record-label"${title}>${escapeHtml(t('components.forecast.record.label'))}</span>`;
}

function note(text: string): string {
  return `<span class="fc-record-note">${escapeHtml(text)}</span>`;
}

function item(text: string, hint: string): string {
  return `<span class="fc-record-item" title="${escapeHtml(hint)}">${escapeHtml(text)}</span>`;
}

function staleBadge(record: GradedRecord): string {
  if (!record.stale) return '';
  const title = record.generatedAt > 0
    ? ` title="${escapeHtml(t('components.forecast.record.staleHint', { date: formatDate(record.generatedAt) }))}"`
    : '';
  return `<span class="fc-record-stale"${title}>${escapeHtml(t('components.forecast.record.stale'))}</span>`;
}

/** The desktop bundle has no /accuracy/ page, so desktop links to the hosted one. */
export function recordHref(desktop: boolean): string {
  return desktop ? `${CANONICAL_ORIGIN}accuracy/` : '/accuracy/';
}

function link(): string {
  return `<a class="fc-record-link" href="${escapeHtml(recordHref(isDesktopRuntime()))}">${escapeHtml(t('components.forecast.record.fullRecord'))}</a>`;
}

function wrap(kind: ForecastRecord['kind'], inner: string): string {
  return `<div class="fc-record" data-fc-record="${kind}" role="group" aria-label="${escapeHtml(t('components.forecast.record.label'))}">${inner}</div>`;
}

export function renderForecastRecord(record: ForecastRecord): string {
  switch (record.kind) {
    case 'loading':
      return wrap('loading', `${label()}${note(t('common.loading'))}`);
    case 'unavailable':
      return wrap('unavailable', `${label()}${note(t('components.forecast.record.unavailable'))}${link()}`);
    case 'insufficient': {
      const hint = t('components.forecast.record.labelHint', { days: record.windowDays });
      return wrap('insufficient', `${label(hint)}${staleBadge(record)}${note(t('components.forecast.record.insufficient'))}${link()}`);
    }
    case 'ready': {
      const hint = t('components.forecast.record.labelHint', { days: record.windowDays });
      const n = String(record.graded);
      const items = [
        item(
          t('components.forecast.record.brier', { score: record.brier.toFixed(3), n }),
          t('components.forecast.record.brierHint', { n }),
        ),
        record.yesShare === null ? '' : item(
          t('components.forecast.record.baseRate', { score: baseRateBrier(record.yesShare).toFixed(3), n }),
          t('components.forecast.record.baseRateHint', { n, pct: Math.round(record.yesShare * 100) }),
        ),
        record.voids === null ? '' : item(
          t('components.forecast.record.void', { pct: (record.voids.rate * 100).toFixed(1), count: record.voids.count, resolved: record.voids.resolved }),
          t('components.forecast.record.voidHint', { resolved: record.voids.resolved }),
        ),
      ].join('');
      return wrap('ready', `${label(hint)}${staleBadge(record)}${items}${link()}`);
    }
  }
}
