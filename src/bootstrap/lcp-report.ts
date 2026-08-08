/**
 * Field LCP attribution reporting (#5079).
 *
 * `reportLcpMetric` shapes one web-vitals LCP measurement (attribution build)
 * into a Sentry event and routes it through `enqueueSentryCall` so it survives
 * Sentry's deferred (~10s idle) init. Reporting the LCP element selector plus
 * the four LCP phase sub-parts lets field data show whether last-mile latency
 * is server response, resource discovery, resource download, or render delay.
 *
 * Good-rated events are trimmed (#4565), so captured-event p75 is conditioned
 * on the bad tail. Verify fixes with bad-event rate per formFactor plus weekly
 * page-level CrUX queryHistoryRecord, not p75 of captured Sentry events.
 *
 * The `onLCP` registration that calls this lives behind the `web-vitals`
 * dependency (see `registerLcpReporting` doc at the bottom). This module keeps
 * the reportable logic free of that import so it builds and is unit-tested
 * without the package present.
 */
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import {
  getWebVitalsFormFactor,
  roundMs,
  sanitizeWebVitalUrl,
  shouldSampleWebVital,
  WEB_VITAL_SAMPLE_RATE,
} from '@/bootstrap/web-vitals-utils';

const MAX_LCP_ELEMENT_TAG_LENGTH = 200;

/** Structural subset of web-vitals' LCP attribution (kept local to avoid the dep). */
export interface LcpAttributionLike {
  target?: string;
  url?: string;
  timeToFirstByte?: number;
  resourceLoadDelay?: number;
  resourceLoadDuration?: number;
  elementRenderDelay?: number;
}

/** Structural subset of web-vitals' LCPMetricWithAttribution. */
export interface LcpMetricLike {
  value: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  attribution?: LcpAttributionLike;
}

function normalizeLcpElementTag(target: string | undefined): string {
  const normalized = (target ?? '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_LCP_ELEMENT_TAG_LENGTH) : 'unknown';
}

/**
 * Report one field LCP measurement to Sentry. `enqueue` is injectable for tests;
 * in production it defaults to the deferred-Sentry queue.
 */
export function reportLcpMetric(
  metric: LcpMetricLike,
  enqueue: typeof enqueueSentryCall = enqueueSentryCall,
  keep: () => boolean = shouldSampleWebVital,
): void {
  // Volume trim (#4565): skip 'good' (<=2500ms) LCP. Report
  // needs-improvement / poor / unknown only, so Sentry volume stays focused on
  // the bad tail while success is measured by bad-event rate per surface.
  if (metric.rating === 'good') return;
  // Uniform sample of the surviving bad tail to cut Sentry volume ~80% without
  // biasing the rating/formFactor/element-target distributions.
  if (!keep()) return;
  const a = metric.attribution ?? {};
  const formFactor = getWebVitalsFormFactor();
  const elementTag = normalizeLcpElementTag(a.target);
  enqueue((s) => {
    s.captureMessage('web-vital: LCP', {
      level: 'info',
      tags: {
        webvital: 'lcp',
        formFactor,
        sampleRate: String(WEB_VITAL_SAMPLE_RATE),
        'lcp.rating': metric.rating ?? 'unknown',
        'lcp.element': elementTag,
      },
      extra: {
        value: Math.round(metric.value),
        elementTarget: a.target ?? 'unknown',
        url: sanitizeWebVitalUrl(a.url) || undefined,
        timeToFirstByte: roundMs(a.timeToFirstByte),
        resourceLoadDelay: roundMs(a.resourceLoadDelay),
        resourceLoadDuration: roundMs(a.resourceLoadDuration),
        elementRenderDelay: roundMs(a.elementRenderDelay),
      },
    });
  });
}

/**
 * Register the field LCP listener. Browser-only. Uses a dynamic import so
 * `web-vitals` code-splits into its own chunk and so this module stays
 * node-loadable for unit tests. Uses web-vitals' default lifecycle cadence:
 * buffered LCP entries are reported when the value is ready, and bfcache restores
 * get their own metric instance.
 */
export function registerLcpReporting(): void {
  if (typeof window === 'undefined') return;
  void import('web-vitals/attribution')
    .then(({ onLCP }) => {
      onLCP((metric) => reportLcpMetric(metric as unknown as LcpMetricLike));
    })
    .catch(() => { /* web-vitals chunk failed to load (adblock/CDN) - non-fatal */ });
}
