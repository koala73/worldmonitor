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
const PUBLISHED_BY_DOMAIN_SCHEMA = 2;

export type DomainReliability =
  | { kind: 'measured'; brier: number; n: number; yesShare: number }
  | { kind: 'unmeasured'; n: number };

/** Published-origin per-domain rows for the card badges; null when the scorecard cannot vouch for them. */
export interface ReliabilityTable {
  windowDays: number;
  stale: boolean;
  byDomain: ReadonlyMap<string, DomainReliability>;
}

/**
 * Reads only publishedByDomain. byDomain pools shadow and synthetic origins,
 * so a response without the published breakdown yields no badges at all. The
 * handler fills an absent field with [], so only a schema-2 seed vouches for it.
 */
export function projectReliability(resp: GetForecastScorecardResponse): ReliabilityTable | null {
  if (resp.degraded || resp.error || !Array.isArray(resp.publishedByDomain)) return null;
  if (!finite(resp.schemaVersion) || resp.schemaVersion < PUBLISHED_BY_DOMAIN_SCHEMA) return null;
  const byDomain = new Map<string, DomainReliability>();
  for (const row of resp.publishedByDomain) {
    const n = finite(row.count) && row.count > 0 ? row.count : 0;
    const validYes = Number.isInteger(row.yesCount) && row.yesCount >= 0 && row.yesCount <= n;
    byDomain.set(row.domain, n >= DOMAIN_RELIABILITY_MIN_SAMPLE && finite(row.brier) && validYes
      ? { kind: 'measured', brier: row.brier, n, yesShare: row.yesCount / n }
      : { kind: 'unmeasured', n });
  }
  const windowDays = finite(resp.rollingWindowDays) && resp.rollingWindowDays > 0 ? resp.rollingWindowDays : DEFAULT_WINDOW_DAYS;
  return { windowDays, stale: resp.stale === true, byDomain };
}

/** A domain the scorecard has no published row for has graded nothing yet, so it reads as unmeasured with n=0. */
export function renderReliabilityBadge(table: ReliabilityTable | null, domain: string, domainLabel: string): string {
  if (!table) return '';
  const r = table.byDomain.get(domain) ?? { kind: 'unmeasured', n: 0 };
  const days = table.windowDays;
  const [main, hint] = r.kind === 'measured'
    ? [
        t('components.forecast.reliability.measured', { domain: domainLabel, score: r.brier.toFixed(3), base: baseRateBrier(r.yesShare).toFixed(3), n: r.n }),
        t('components.forecast.reliability.measuredHint', { domain: domainLabel, n: r.n, days }),
      ]
    : [
        t('components.forecast.reliability.unmeasured'),
        t('components.forecast.reliability.unmeasuredHint', { domain: domainLabel, n: r.n, days, min: DOMAIN_RELIABILITY_MIN_SAMPLE }),
      ];
  // Stale and n lead: the badge is one line with an ellipsis, so a narrow card cuts the tail.
  const text = table.stale ? `${t('components.forecast.record.stale')} · ${main}` : main;
  return `<a class="fc-reliability" data-fc-reliability-state="${r.kind}" href="${escapeHtml(reliabilityHref(isDesktopRuntime()))}" aria-label="${escapeHtml(`${text}. ${hint}`)}">${escapeHtml(text)}</a>`;
}

const OUTCOMES = ['YES', 'NO', 'VOID'] as const;
type Outcome = typeof OUTCOMES[number];
// Distinct shapes, so the history never relies on colour; the words are in the screen-reader text.
const OUTCOME_MARKS: Record<Outcome, string> = { YES: '✓', NO: '✗', VOID: '∅' };

/** Public void-reason codes; mirrors RECEIPT_VOID_REASON_LABELS in scripts/_forecast-scorecard.mjs (a test pins the parity). */
export const VOID_REASON_CODES = [
  'no_establishable_metric', 'value_source_never_settled', 'count_source_window_not_retained', 'unsupported_window',
  'unsupported_metric_key', 'not_hard_spec', 'missing_threshold', 'missing_deadline', 'missing_generated_at',
  'beyond_archive_horizon', 'no_archive_evidence', 'all_judges_void', 'judge_disagreement', 'judge_retry_exhausted', 'withheld_unpublished', 'other',
] as const;
const VOID_REASONS = new Set<string>(VOID_REASON_CODES);

interface FamilyWindow { outcome: Outcome; voidReason: string }

/** Earlier resolved windows per forecast id, newest first; null when the scorecard cannot vouch for them. */
export type FamilyHistory = ReadonlyMap<string, readonly FamilyWindow[]>;

export function projectFamilyHistory(resp: GetForecastScorecardResponse): FamilyHistory | null {
  if (resp.degraded || resp.error || !Array.isArray(resp.familyOutcomes)) return null;
  const history = new Map<string, FamilyWindow[]>();
  for (const row of resp.familyOutcomes) {
    if (typeof row?.forecastId !== 'string' || !(OUTCOMES as readonly string[]).includes(row.outcome)) continue;
    const voidReason = row.outcome === 'VOID' ? (VOID_REASONS.has(row.voidReason) ? row.voidReason : 'other') : '';
    const windows = history.get(row.forecastId) ?? [];
    windows.push({ outcome: row.outcome as Outcome, voidReason });
    history.set(row.forecastId, windows);
  }
  return history;
}

function outcomeWord(outcome: Outcome): string {
  return t(`components.forecast.resolution.outcome.${outcome.toLowerCase()}`);
}

const RES_GAP = '<span class="fc-res-gap" aria-hidden="true">&nbsp;</span>';

/**
 * The card is the open window, so the chip is the family's last resolved one; the history adds up to four earlier.
 * A VOID window has a reason to read, so the row becomes a disclosure that tap and keyboard can open; `open`
 * restores one the reader left open. The slot always holds two line boxes (chip, then history), filled with
 * invisible gaps when absent, so a narrow card is the same height while loading, with history, and without.
 */
export function renderResolutionChips(history: FamilyHistory | null, forecastId: string, open = false): string {
  const windows = history?.get(forecastId);
  if (!windows?.length) return `<span class="fc-res-slot">${RES_GAP}${RES_GAP}</span>`;
  const reasonOf = (w: FamilyWindow) => (w.outcome === 'VOID' ? t(`components.forecast.resolution.void.${w.voidReason}`) : '');
  const [last] = windows as [FamilyWindow, ...FamilyWindow[]];
  const reason = reasonOf(last);
  const chip = `<span class="fc-res-chip" data-outcome="${last.outcome}"${reason ? ` title="${escapeHtml(reason)}"` : ''}>`
    + `<span aria-hidden="true">${escapeHtml(t('components.forecast.resolution.last', { outcome: outcomeWord(last.outcome) }))}</span>`
    + `<span class="fc-sr-only">${escapeHtml(t('components.forecast.resolution.lastSr', { outcome: outcomeWord(last.outcome) }))}</span></span>`;
  const disclosed = windows.some((w) => w.outcome === 'VOID');
  const sentence = t('components.forecast.resolution.history', {
    list: windows.map((w) => (reasonOf(w) ? `${outcomeWord(w.outcome)} (${reasonOf(w)})` : outcomeWord(w.outcome))).join(', '),
  });
  const marks = windows.map((w) => {
    const why = reasonOf(w);
    return `<span class="fc-res-mark" data-outcome="${w.outcome}" aria-hidden="true"${why ? ` title="${escapeHtml(why)}"` : ''}>${OUTCOME_MARKS[w.outcome]}</span>`;
  }).join('');
  const row = windows.length < 2
    ? `${chip}${RES_GAP}`
    : `${chip}<span class="fc-res-history">${marks}${disclosed ? '' : `<span class="fc-sr-only">${escapeHtml(sentence)}</span>`}</span>`;
  if (!disclosed) return `<span class="fc-res-slot">${row}</span>`;
  return `<span class="fc-res-slot"><details class="fc-res-void"${open ? ' open' : ''}><summary>${row}</summary><p class="fc-res-reasons">${escapeHtml(windows.length < 2 ? reason : sentence)}</p></details></span>`;
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

/** The badge lands on the /accuracy/ table built from the same publishedByDomain rows. */
export function reliabilityHref(desktop: boolean): string {
  return `${recordHref(desktop)}#by-domain`;
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
