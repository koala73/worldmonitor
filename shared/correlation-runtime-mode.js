/**
 * Staged correlation runtime control shared by the browser and Railway seeders.
 *
 * The Redis value is a JSON object such as `{ "mode": "exact" }`. The
 * resolver is deliberately strict: every missing, malformed, or unknown value
 * stays on the existing legacy path.
 */

export const CORRELATION_RUNTIME_MODE_KEY = 'correlation:runtime-mode:v1';
export const CORRELATION_RUNTIME_MODE_ENDPOINT = '/api/correlation-runtime-mode';
export const CORRELATION_RUNTIME_MODES = Object.freeze(['legacy', 'exact', 'fuzzy']);

const VALID_MODES = new Set(CORRELATION_RUNTIME_MODES);

export function resolveCorrelationRuntimeMode(value) {
  const candidate = typeof value === 'string'
    ? value
    : value != null && typeof value === 'object' && !Array.isArray(value)
      ? value.mode
      : undefined;

  return typeof candidate === 'string' && VALID_MODES.has(candidate)
    ? candidate
    : 'legacy';
}
