import {
  BillingDenialError,
  MAX_VALIDATION_BODY_BYTES,
  RpcValidationError,
  parseSafeRpcViolations,
  throwIfBillingDenial,
} from './billing-denial';
import type { RpcValidationViolation } from './billing-denial';
import { readBoundedResponseText } from './bounded-body';
import { emitTelemetry } from './telemetry';
import type {
  McpAuthContext,
  McpToolExecutionContext,
} from './types';

export const MCP_CANONICAL_API_ORIGIN = 'https://api.worldmonitor.app';

const VARIANT_HOSTS: ReadonlySet<string> = new Set([
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

const SAFE_GATEWAY_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_internal_mcp_signature',
  'internal_mcp_replay_cache_unavailable',
  'insufficient_entitlement',
  'entitlement_verification_unavailable',
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
  'payload_too_large',
  'rate_limited',
]);

const SAFE_GATEWAY_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['invalid api key', 'invalid_api_key'],
  ['invalid or expired session', 'invalid_session'],
  ['api access requires an active subscription', 'api_subscription_required'],
  ['pro subscription required', 'pro_subscription_required'],
  ['unable to verify api access', 'entitlement_verification_unavailable'],
  ['method not allowed', 'method_not_allowed'],
  ['configuration', 'configuration'],
]);

type ToolFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
};

type DownstreamResponseMarker =
  | 'json'
  | 'html'
  | 'other'
  | 'json_error'
  | 'html_error'
  | 'empty_error'
  | 'method_not_allowed'
  | 'billing_verification';

export class ToolFetchError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly safeCode: string;
  readonly responseMarker: DownstreamResponseMarker;

  constructor(
    operation: string,
    status: number,
    safeCode: string,
    responseMarker: DownstreamResponseMarker,
  ) {
    super(`${operation} HTTP ${status}: ${safeCode}`);
    this.name = 'ToolFetchError';
    this.operation = operation;
    this.status = status;
    this.safeCode = safeCode;
    this.responseMarker = responseMarker;
  }
}

type DownstreamObservation = {
  operation: string;
  tool: string;
  auth: McpAuthContext;
  execution?: McpToolExecutionContext;
};

function classifyMcpInboundHost(hostname: string): McpToolExecutionContext['inboundHostClass'] {
  hostname = hostname.toLowerCase();
  if (hostname === 'api.worldmonitor.app') return 'canonical_api';
  if (hostname === 'worldmonitor.app') return 'apex';
  if (hostname === 'www.worldmonitor.app') return 'www';
  if (VARIANT_HOSTS.has(hostname)) return 'variant';
  if (hostname.endsWith('.worldmonitor.app')) return 'worldmonitor_subdomain';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'local';
  if (hostname.endsWith('.vercel.app')) return 'vercel_preview';
  return 'other';
}

export function createMcpToolExecutionContext(requestUrl: string): McpToolExecutionContext {
  const inbound = new URL(requestUrl);
  const inboundHostClass = classifyMcpInboundHost(inbound.hostname);
  const isProductionWorldMonitorHost = (
    inbound.hostname === 'worldmonitor.app'
    || inbound.hostname.endsWith('.worldmonitor.app')
  );
  const downstreamOrigin = isProductionWorldMonitorHost
    ? MCP_CANONICAL_API_ORIGIN
    : inbound.origin;
  return {
    inboundHostClass,
    downstreamOrigin,
    // Only the canonical public origin is recorded verbatim. Non-production
    // origins collapse to their bounded host class so preview names, local
    // ports, and self-hosted domains never enter telemetry.
    downstreamOriginTag: downstreamOrigin === MCP_CANONICAL_API_ORIGIN
      ? MCP_CANONICAL_API_ORIGIN
      : inboundHostClass,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function buildMcpDownstreamHeaders(
  targetOrigin: string,
  execution: McpToolExecutionContext | undefined,
  headers: Record<string, string>,
): Record<string, string> {
  if (execution?.inboundHostClass !== 'local') return headers;
  let target: URL;
  let expected: URL;
  try {
    target = new URL(targetOrigin);
    expected = new URL(execution.downstreamOrigin);
  } catch {
    return headers;
  }
  if (target.origin !== expected.origin || !isLoopbackHostname(target.hostname)) return headers;
  const token = process.env.LOCAL_API_TOKEN?.trim();
  if (!token) return headers;
  return { ...headers, 'X-WorldMonitor-Local-Token': token };
}

function contentType(response: ToolFetchResponse): string {
  return (response.headers?.get('Content-Type') ?? '').toLowerCase();
}

function successMarker(response: ToolFetchResponse): DownstreamResponseMarker {
  const type = contentType(response);
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  return 'other';
}

function defaultSafeErrorCode(status: number): string {
  if (status === 401) return 'auth_rejected';
  if (status === 403) return 'forbidden';
  if (status === 405) return 'method_not_allowed';
  if (status === 429) return 'rate_limited';
  return 'upstream_http_error';
}

function safeGatewayErrorCode(value: unknown, status: number): string {
  if (typeof value !== 'string') return defaultSafeErrorCode(status);
  const normalized = value.trim().toLowerCase();
  if (SAFE_GATEWAY_ERROR_CODES.has(normalized)) return normalized;
  return SAFE_GATEWAY_ERROR_MESSAGES.get(normalized) ?? defaultSafeErrorCode(status);
}

type DownstreamFailure = {
  errorCode: string;
  marker: DownstreamResponseMarker;
  violations: readonly RpcValidationViolation[];
};

async function classifyFailure(
  response: ToolFetchResponse,
): Promise<DownstreamFailure> {
  if (response.status === 405) {
    return { errorCode: 'method_not_allowed', marker: 'method_not_allowed', violations: [] };
  }

  const type = contentType(response);
  // A sibling body can only be read once, so this single read has to serve
  // both classifications. A proto/sebuf 400 carries its field violations in
  // the body and a dozen localized descriptions already overflow 4 KB, so
  // that status reads the validation budget; every other status keeps the
  // tighter cap. Neither path lets raw text escape — only the closed set of
  // gateway codes and the sanitized `{field, description}` pairs do.
  const budget = response.status === 400 ? MAX_VALIDATION_BODY_BYTES : 4096;
  const detail = await readBoundedResponseText(response, budget);
  if (!detail) {
    return {
      errorCode: defaultSafeErrorCode(response.status),
      marker: 'empty_error',
      violations: [],
    };
  }

  const hasJsonContentType = type.includes('json');
  // Match extractSafeRpcViolations for proto 400s: generated responses are
  // JSON, but a missing or generic content type must not discard an otherwise
  // safe validation envelope. HTML remains an explicit rejection, and the
  // relaxed gate never classifies gateway codes on non-JSON responses.
  const mayContainValidationBody = response.status === 400 && !type.includes('html');
  if (hasJsonContentType || mayContainValidationBody) {
    try {
      const parsed = JSON.parse(detail) as { code?: unknown; error?: unknown };
      // A coded gateway rejection is not a proto validation failure: keep the
      // recognised code and leave the violation list empty so the caller stays
      // on the ToolFetchError contract.
      // Absent AND explicit-null both mean "no gateway code": a null would
      // classify as the default code anyway, so treating it as coded would
      // discard the violations of a `{"code":null,"violations":[...]}` body.
      const coded = parsed.code ?? parsed.error;
      const violations = mayContainValidationBody && (coded === undefined || coded === null)
        ? parseSafeRpcViolations(parsed)
        : [];
      if (violations.length > 0 || hasJsonContentType) {
        return {
          errorCode: violations.length > 0
            ? 'rpc_validation'
            : safeGatewayErrorCode(coded, response.status),
          marker: 'json_error',
          violations,
        };
      }
    } catch {
      if (hasJsonContentType) {
        return {
          errorCode: defaultSafeErrorCode(response.status),
          marker: 'json_error',
          violations: [],
        };
      }
    }
  }

  return {
    errorCode: defaultSafeErrorCode(response.status),
    marker: type.includes('html') ? 'html_error' : 'other',
    violations: [],
  };
}

function emitDownstreamTelemetry(
  tool: string,
  operation: string,
  auth: McpAuthContext,
  execution: McpToolExecutionContext | undefined,
  response: ToolFetchResponse,
  errorCode: string | null,
  responseMarker: DownstreamResponseMarker,
): void {
  if (!execution) return;
  emitTelemetry('mcp.downstream', {
    tool,
    auth_kind: auth.kind,
    inbound_host_class: execution.inboundHostClass,
    downstream_origin: execution.downstreamOriginTag,
    downstream_operation: operation,
    status: response.status,
    ok: response.ok,
    error_code: errorCode,
    response_marker: responseMarker,
  });
}

/**
 * Validate one MCP sibling fetch while recording only bounded routing/auth
 * diagnostics. Error response bodies are consumed solely to map a closed set
 * of gateway codes; raw text, unknown values, headers, URLs, and credentials
 * never leave this module.
 */
export async function assertMcpToolFetchOk(
  response: ToolFetchResponse,
  observation: DownstreamObservation,
): Promise<void> {
  const { operation, tool, auth, execution } = observation;
  if (response.ok) {
    emitDownstreamTelemetry(
      tool,
      operation,
      auth,
      execution,
      response,
      null,
      successMarker(response),
    );
    return;
  }

  try {
    throwIfBillingDenial(response, operation);
  } catch (error) {
    if (error instanceof BillingDenialError) {
      emitDownstreamTelemetry(
        tool,
        operation,
        auth,
        execution,
        response,
        error.billingCode,
        'billing_verification',
      );
    }
    throw error;
  }

  const failure = await classifyFailure(response);
  emitDownstreamTelemetry(
    tool,
    operation,
    auth,
    execution,
    response,
    failure.errorCode,
    failure.marker,
  );
  // Parity with assertToolFetchOk: a proto/sebuf 400 names the offending
  // field, and dispatch turns that into JSON-RPC -32602 "Invalid params" with
  // `error.data.violations`. Collapsing it into ToolFetchError reported the
  // caller's own bad argument as -32603 "Internal error" and dropped the one
  // detail that says which argument (WORLDMONITOR-10R / 10Q).
  if (failure.violations.length > 0) {
    throw new RpcValidationError(operation, failure.violations);
  }
  throw new ToolFetchError(
    operation,
    response.status,
    failure.errorCode,
    failure.marker,
  );
}

/**
 * Classify a PromiseSettledResult rejection reason into a short tag value.
 *
 * Returns one of:
 *   `timeout`       — AbortSignal.timeout fired (AbortError)
 *   `http_<status>` — upstream returned a non-ok HTTP status
 *   `auth_error`    — buildAuthHeaders or similar auth-path failure
 *   `error`         — generic Error subclass (message available in detail)
 *   `unknown`       — non-Error rejection (string, undefined, etc.)
 */
export function classifyFailureReason(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.name === 'TimeoutError') return 'timeout';
    const m = reason.message.match(/^HTTP (\d+)/);
    if (m) return `http_${m[1]}`;
    if (/\b(auth|secret|key|unauthorized|forbidden)\b/i.test(reason.message)) return 'auth_error';
    return 'error';
  }
  return reason == null ? 'unknown' : String(reason);
}

function formatErrorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Typed error for `get_airspace` when both the civilian and military upstream
 * sources fail. Carries the classified failure summary so dispatch can tag
 * each side separately in Sentry and attach the full rejection reasons as
 * extra data — distinguishing a shared-host outage (same failure on both
 * sides) from two independent provider failures (different failures).
 */
export class BothSourcesFailedError extends Error {
  readonly civilianFailure: string;
  readonly militaryFailure: string;
  readonly civilianFailureDetail: string;
  readonly militaryFailureDetail: string;

  constructor(civDetail: unknown, milDetail: unknown) {
    super('Airspace data unavailable: both civilian and military sources failed');
    this.name = 'BothSourcesFailedError';
    this.civilianFailure = classifyFailureReason(civDetail);
    this.militaryFailure = classifyFailureReason(milDetail);
    this.civilianFailureDetail = formatErrorDetail(civDetail);
    this.militaryFailureDetail = formatErrorDetail(milDetail);
  }
}

/** Sentry silently truncates a tag value past this; truncate on a field boundary ourselves. */
const MAX_VIOLATION_FIELDS_TAG_LEN = 200;

/**
 * Name the fields a proto/sebuf 400 rejected, as a searchable Sentry tag.
 *
 * `RpcValidationError` already hands its violations to the caller
 * (`error.data.violations`), but the Sentry event carried only
 * `<operation> HTTP 400` — so an issue like WORLDMONITOR-10R could not name its
 * failing field from Sentry alone, and the country fix in #7170 could be
 * neither confirmed nor refuted against it. Fields only: the descriptions are
 * long, and `field` is the part that groups.
 *
 * Safe to expose by construction — `parseSafeRpcViolations` (billing-denial.ts)
 * already bounds the list to 8 and admits a field only if it matches
 * `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`, so no untrusted text reaches this tag. The
 * length bound is belt-and-braces for that 8 x 64 worst case.
 */
function violationFieldsTag(violations: readonly { field: string }[]): string {
  const joined: string[] = [];
  let len = 0;
  for (const { field } of violations) {
    const cost = field.length + (joined.length > 0 ? 1 : 0);
    if (len + cost > MAX_VIOLATION_FIELDS_TAG_LEN) break;
    joined.push(field);
    len += cost;
  }
  return joined.join(',');
}

export function downstreamErrorTags(
  error: unknown,
): Record<string, string> {
  if (error instanceof BillingDenialError) {
    return {
      downstream_operation: error.operation,
      downstream_status: String(error.status),
      downstream_error_code: error.billingCode,
      downstream_response_marker: 'billing_verification',
    };
  }
  if (error instanceof RpcValidationError) {
    return {
      downstream_operation: error.operation,
      downstream_status: String(error.status),
      downstream_error_code: 'rpc_validation',
      downstream_response_marker: 'json_error',
      downstream_violation_fields: violationFieldsTag(error.violations),
    };
  }
  if (error instanceof ToolFetchError) {
    return {
      downstream_operation: error.operation,
      downstream_status: String(error.status),
      downstream_error_code: error.safeCode,
      downstream_response_marker: error.responseMarker,
    };
  }
  if (error instanceof BothSourcesFailedError) {
    return {
      civilian_failure: error.civilianFailure,
      military_failure: error.militaryFailure,
    };
  }
  return {};
}
