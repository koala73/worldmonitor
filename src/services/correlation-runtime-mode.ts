import { toApiUrl } from '@/services/runtime';
import {
  CORRELATION_RUNTIME_MODE_ENDPOINT,
  resolveCorrelationRuntimeMode,
} from '../../shared/correlation-runtime-mode.js';
import type { CorrelationRuntimeMode } from '../../shared/correlation-runtime-mode.js';

export type { CorrelationRuntimeMode } from '../../shared/correlation-runtime-mode.js';

type RuntimeModeFetch = typeof globalThis.fetch;

/**
 * Hard bound on the control-plane read.
 *
 * This is load-bearing, not defensive polish: this read is awaited inside the
 * `correlation-engine` refresh callback, and RefreshScheduler only clears its
 * in-flight latch in a `finally`. A fetch that never settles would therefore
 * latch that lane forever and silently stop every future correlation refresh
 * for the life of the page. Matches the 3s budget used by the sibling seeder
 * and edge readers of the same control.
 */
const CONTROL_PLANE_TIMEOUT_MS = 3_000;

/**
 * Read the operator-selected correlation mode for one browser decision.
 *
 * This intentionally does not cache the result: startup and every scheduled
 * correlation refresh must observe the current control. Any transport or
 * payload failure returns legacy so a control-plane outage cannot activate a
 * newer clustering algorithm accidentally.
 */
export async function fetchCorrelationRuntimeMode(
  fetchImpl: RuntimeModeFetch = (...args) => globalThis.fetch(...args),
): Promise<CorrelationRuntimeMode> {
  try {
    const response = await fetchImpl(toApiUrl(CORRELATION_RUNTIME_MODE_ENDPOINT), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `[CorrelationRuntimeMode] control plane returned HTTP ${response.status}; using legacy`,
      );
      return 'legacy';
    }
    return resolveCorrelationRuntimeMode(await response.json());
  } catch (error) {
    console.warn('[CorrelationRuntimeMode] control-plane read failed; using legacy:', error);
    return 'legacy';
  }
}
