/**
 * Installs `AbortSignal.timeout` and `AbortSignal.any` on engines that lack
 * them. Every page entry imports this module first.
 *
 * Sentry WORLDMONITOR-1D7: Safari < 16 and Chrome < 103 have no
 * `AbortSignal.timeout`, so the news digest request threw before fetch ran
 * and the news panels stayed empty. That was one of 76 bare calls in src/;
 * `AbortSignal.any` (Safari < 17.4, Chrome < 116) had 12 more. Installing
 * the fallbacks once covers them all, including code written later.
 *
 * Native implementations are never replaced.
 */
import { fallbackAnySignal, fallbackTimeoutSignal } from '@/services/timeout-signal';

/** Define the missing functions on `AbortSignal`; a no-op where both are native. */
export function installAbortSignalFallbacks(): void {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return;
  const target = AbortSignal as unknown as Record<string, unknown>;
  try {
    if (typeof AbortSignal.timeout !== 'function') {
      Object.defineProperty(target, 'timeout', { value: fallbackTimeoutSignal, writable: true, configurable: true });
    }
    if (typeof AbortSignal.any !== 'function') {
      Object.defineProperty(target, 'any', { value: fallbackAnySignal, writable: true, configurable: true });
    }
  } catch {
    /* a frozen AbortSignal keeps its old behavior; createTimeoutSignal still works */
  }
}

installAbortSignalFallbacks();
