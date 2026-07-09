export type RpcNoStoreReason =
  | 'upstream-unavailable'
  | 'unavailable'
  | 'data-unavailable'
  | 'degraded'
  | 'available-false'
  | 'error'
  | 'nonterminal';

interface RpcNoStoreOptions {
  pathname?: string;
  includeAvailableFalse?: boolean;
}

const SCENARIO_STATUS_PATH = '/api/scenario/v1/get-scenario-status';
const SCENARIO_TERMINAL_STATUSES = new Set(['done', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function getRpcNoStoreReasonFromPayload(
  payload: unknown,
  options: RpcNoStoreOptions = {},
): RpcNoStoreReason | null {
  if (!isRecord(payload)) return null;

  if (payload.upstreamUnavailable === true) return 'upstream-unavailable';
  if (payload.unavailable === true) return 'unavailable';
  if (payload.dataAvailable === false) return 'data-unavailable';
  if (payload.degraded === true) return 'degraded';
  if (options.includeAvailableFalse !== false && payload.available === false) return 'available-false';
  if (nonEmptyString(payload.error)) return 'error';

  if (options.pathname === SCENARIO_STATUS_PATH && nonEmptyString(payload.status)) {
    const status = payload.status.trim().toLowerCase();
    if (!SCENARIO_TERMINAL_STATUSES.has(status)) return 'nonterminal';
  }

  return null;
}

export function getRpcNoStoreReasonFromJson(
  body: string,
  options: RpcNoStoreOptions = {},
): RpcNoStoreReason | null {
  try {
    return getRpcNoStoreReasonFromPayload(JSON.parse(body), options);
  } catch {
    // Keep the previous gateway behavior for non-JSON or malformed bodies
    // where string markers are still all we can safely inspect.
    if (body.includes('"upstreamUnavailable":true')) return 'upstream-unavailable';
    if (body.includes('"unavailable":true')) return 'unavailable';
    if (body.includes('"dataAvailable":false')) return 'data-unavailable';
    if (body.includes('"degraded":true')) return 'degraded';
    if (options.includeAvailableFalse !== false && body.includes('"available":false')) return 'available-false';
    return null;
  }
}
