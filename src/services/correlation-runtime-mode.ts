import { toApiUrl } from '@/services/runtime';
import {
  CORRELATION_RUNTIME_MODE_ENDPOINT,
  resolveCorrelationRuntimeMode,
} from '../../shared/correlation-runtime-mode.js';
import type { CorrelationRuntimeMode } from '../../shared/correlation-runtime-mode.js';

export type { CorrelationRuntimeMode } from '../../shared/correlation-runtime-mode.js';

type RuntimeModeFetch = typeof globalThis.fetch;

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
    });
    if (!response.ok) return 'legacy';
    return resolveCorrelationRuntimeMode(await response.json());
  } catch {
    return 'legacy';
  }
}
