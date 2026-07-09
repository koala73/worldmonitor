/**
 * Field CLS attribution reporting (#4580).
 *
 * `reportClsMetric` shapes one web-vitals CLS measurement (attribution build)
 * into a Sentry event and routes it through `enqueueSentryCall` so it survives
 * Sentry's deferred (~10s idle) init. Reporting the largest shift target/value
 * lets field data name the real shifting element before we ship a layout fix.
 * Good-rated events are trimmed (#4565), so captured-event p75 is conditioned
 * on the bad tail. Verify fixes with bad-event rate per formFactor plus
 * weekly page-level CrUX queryHistoryRecord, not p75 of captured Sentry events.
 *
 * The `onCLS` registration that calls this lives behind the `web-vitals`
 * dependency (see `registerClsReporting` doc at the bottom). This module keeps
 * the reportable logic free of that import so it builds and is unit-tested
 * without the package present.
 */
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { getWebVitalsFormFactor, roundMs } from '@/bootstrap/web-vitals-utils';

/** Structural subset of web-vitals' CLS attribution (kept local to avoid the dep). */
export interface ClsAttributionLike {
  largestShiftTarget?: string;
  largestShiftValue?: number;
  largestShiftTime?: number;
  loadState?: string;
}

/** Structural subset of web-vitals' CLSMetricWithAttribution. */
export interface ClsMetricLike {
  value: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  attribution?: ClsAttributionLike;
}

/**
 * Environment facts that split the field-only CLS classes (#4580): a
 * background-tab load revealed all at once, a top-of-page banner push, or a
 * below-fold panel swap all produce different (hiddenAtLoad, scrollY) pairs
 * that `largestShiftTarget` alone cannot distinguish. Injectable for tests.
 */
export interface ClsReportEnv {
  /** Document was hidden when CLS reporting registered (≈ background-tab load). */
  hiddenAtLoad?: boolean;
  /** Document went hidden at least once before this report. */
  hadHiddenPeriod?: boolean;
  /** document.visibilityState at report time. */
  visibilityState?: string;
  /** window.scrollY at report time, rounded (0 ≈ top-of-page shift class). */
  scrollY?: number;
  /** `${innerWidth}x${innerHeight}` at report time. */
  viewport?: string;
}

// Set once by registerClsReporting(); module-scope so collectClsReportEnv()
// can answer "was this a background-tab load" long after boot.
let hiddenAtLoad: boolean | undefined;
let hadHiddenPeriod = false;

/** Snapshot the reporting environment. Safe in non-browser contexts. */
export function collectClsReportEnv(): ClsReportEnv {
  if (typeof document === 'undefined' || typeof window === 'undefined') return {};
  return {
    hiddenAtLoad,
    hadHiddenPeriod,
    visibilityState: document.visibilityState,
    scrollY: Math.round(window.scrollY),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

/**
 * Report one field CLS measurement to Sentry. `enqueue` is injectable for tests;
 * in production it defaults to the deferred-Sentry queue.
 */
export function reportClsMetric(
  metric: ClsMetricLike,
  enqueue: typeof enqueueSentryCall = enqueueSentryCall,
  env: ClsReportEnv = collectClsReportEnv(),
): void {
  // Volume trim: skip 'good' (<0.1) CLS and report needs-improvement / poor /
  // unknown only, so field attribution stays focused on actionable shifts.
  if (metric.rating === 'good') return;
  const a = metric.attribution ?? {};
  const formFactor = getWebVitalsFormFactor();
  enqueue((s) => {
    s.captureMessage('web-vital: CLS', {
      level: 'info',
      tags: {
        webvital: 'cls',
        formFactor,
        'cls.rating': metric.rating ?? 'unknown',
      },
      extra: {
        value: metric.value,
        largestShiftTarget: a.largestShiftTarget ?? 'unknown',
        largestShiftValue: a.largestShiftValue,
        largestShiftTime: roundMs(a.largestShiftTime),
        loadState: a.loadState,
        hiddenAtLoad: env.hiddenAtLoad,
        hadHiddenPeriod: env.hadHiddenPeriod,
        visibilityState: env.visibilityState,
        scrollY: env.scrollY,
        viewport: env.viewport,
      },
    });
  });
}

/**
 * Register the field CLS listener. Browser-only. Uses a dynamic import so
 * `web-vitals` code-splits into its own chunk and so this module stays
 * node-loadable for unit tests. Uses web-vitals' default lifecycle cadence
 * (including bfcache/visibility reports), matching the INP reporter.
 */
export function registerClsReporting(): void {
  if (typeof window === 'undefined') return;
  // Track visibility synchronously at boot: registration runs from main.ts, so
  // hidden-here ≈ the tab was opened in the background (cmd-click). The
  // listener stays for the page's life to catch later hide/reveal cycles.
  hiddenAtLoad = document.visibilityState === 'hidden';
  hadHiddenPeriod = hiddenAtLoad;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hadHiddenPeriod = true;
  });
  void import('web-vitals/attribution')
    .then(({ onCLS }) => {
      onCLS((metric) => reportClsMetric(metric as unknown as ClsMetricLike));
    })
    .catch(() => { /* web-vitals chunk failed to load (adblock/CDN) - non-fatal */ });
}
