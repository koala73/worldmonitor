import { enqueueSentryCall } from './sentry-defer';

/**
 * Variant stylesheets load through a fire-and-forget dynamic import so they stay
 * off the other variants' eager CSS graph (see `main.ts`). Vite's preload helper
 * appends a `<link rel="stylesheet">` for a CSS-only dynamic import and rejects
 * the promise it returns with `Unable to preload CSS for <url>` when that link
 * fires `error`, so an uncaught `void import('./styles/<variant>-theme.css')`
 * surfaces as an onunhandledrejection ERROR in Sentry — even though the user is
 * unaffected, because the same helper dispatches `vite:preloadError` first and
 * `installChunkReloadGuard` (chunk-reload.ts) turns that into a one-shot reload
 * (WORLDMONITOR-XT: happy-theme.css, 2026-07-28; the asset itself served 200, so
 * the failure was client-local, not deploy skew).
 *
 * Consume the rejection here and re-report it as deliberate warning-level
 * telemetry instead: a stylesheet genuinely missing from a deploy still
 * escalates by volume, while a lone client-side network blip stops reading as an
 * unhandled error. Every other dynamic import under `bootstrap/` already
 * terminates in a `.catch`; this is the same contract, made testable.
 */
export function reportVariantThemeLoadFailure(variant: string, error: unknown): void {
  enqueueSentryCall((s) => {
    s.captureMessage(`Variant theme stylesheet failed to load: ${variant}`, {
      level: 'warning',
      tags: { kind: 'variant_theme_load_failed', variant },
      extra: { reason: error instanceof Error ? error.message : String(error) },
    });
  });
}

export function loadVariantThemeStylesheet(
  variant: string,
  importTheme: () => Promise<unknown>,
  report: (variant: string, error: unknown) => void = reportVariantThemeLoadFailure,
): Promise<void> {
  return Promise.resolve()
    .then(importTheme)
    .then(
      () => undefined,
      (error: unknown) => {
        // The reporter runs inside the rejection handler, so a throw here would
        // re-reject this promise and recreate the exact leak being closed.
        try {
          report(variant, error);
        } catch {
          // Telemetry must never resurrect the rejection it exists to report.
        }
      },
    );
}
