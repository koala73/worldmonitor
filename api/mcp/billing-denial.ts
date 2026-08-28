// #4770 review: billing-verification denials from the gateway must survive the
// tool `_execute` fetch layer. Without this, a mid-request entitlement lapse
// (gateway 403/503 with X-Billing-Verification) is flattened by dispatch's
// catch-all into HTTP 200 / -32603 "Internal error: data fetch failed" — the
// agent loses the retry/billing signal for exactly the window the on-demand
// renewal verification exists to cover.

import type { BillingVerificationStatus } from '../../server/_shared/entitlement-check';
import { readBoundedResponseText } from './bounded-body';

export type BillingVerificationCode =
  | BillingVerificationStatus
  // Gateway-synthesized (server/gateway.ts wm_-key branch): backend-unreachable
  // fail-closed 503. Deliberately NOT in the Convex-facing
  // BillingVerificationStatus union — Convex never produces it.
  | 'entitlement_verification_unavailable';

const BILLING_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
  'entitlement_verification_unavailable',
] satisfies BillingVerificationCode[]);

export class BillingDenialError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly billingCode: BillingVerificationCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    label: string,
    status: number,
    billingCode: BillingVerificationCode,
    retryAfterSeconds: number | undefined,
  ) {
    // Keep the `<tool> HTTP <status>` shape: dispatch's log-severity downgrade
    // for expected 4xx keys on this message format.
    super(`${label} HTTP ${status} (${billingCode})`);
    this.name = 'BillingDenialError';
    this.operation = label;
    this.status = status;
    this.billingCode = billingCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Structural subset of Response so test doubles that stub only {ok, status}
// (several suites do) pass through the non-billing path instead of throwing
// on a missing headers object. `body` / `text` are optional so those doubles
// still work; they are only read on HTTP 400 to extract proto violations.
type ToolFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
};

export type RpcValidationViolation = {
  field: string;
  description: string;
};

// Generated proto 400 bodies can legitimately exceed 4 KB — a dozen fields
// with localized descriptions already overflows, and truncation mid-JSON drops
// the whole violation list into the generic fallback. 16 KB stays bounded
// (larger or hostile bodies still truncate and never leak raw content); the
// surviving projection stays capped independently by MAX_VALIDATION_VIOLATIONS
// and the per-field length limits below.
export const MAX_VALIDATION_BODY_BYTES = 16384;
const MAX_VALIDATION_VIOLATIONS = 8;
const MAX_VIOLATION_FIELD_LEN = 64;
const MAX_VIOLATION_DESCRIPTION_LEN = 200;
const SAFE_VIOLATION_FIELD = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const UNSAFE_VIOLATION_DESCRIPTION = /[<>]|authorization\s*:|bearer\s/i;

export class RpcValidationError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly violations: readonly RpcValidationViolation[];

  constructor(label: string, violations: readonly RpcValidationViolation[]) {
    // Keep the `<tool> HTTP <status>` shape so dispatch's client-4xx
    // log-severity downgrade and mcpErrorFingerprint grouping still match.
    super(`${label} HTTP 400`);
    this.name = 'RpcValidationError';
    this.operation = label;
    this.status = 400;
    this.violations = violations;
  }
}

/**
 * Throws BillingDenialError when a non-ok gateway response carries the
 * billing-verification marker header. Detection is header-only, so callers
 * that read the error body for detail can still consume it afterwards.
 */
export function throwIfBillingDenial(response: ToolFetchResponse, label: string): void {
  if (response.ok) return;
  const marker = response.headers?.get('X-Billing-Verification');
  if (!marker || !BILLING_VERIFICATION_CODES.has(marker)) return;
  // Distinguish a missing header from a present-but-zero value: Number(null)
  // is 0 (finite), which would silently masquerade as an explicit 0s hint.
  const retryHeader = response.headers?.get('Retry-After');
  const rawRetryAfter = retryHeader == null ? Number.NaN : Number(retryHeader);
  throw new BillingDenialError(
    label,
    response.status,
    marker as BillingVerificationCode,
    Number.isFinite(rawRetryAfter) ? rawRetryAfter : undefined,
  );
}

function sanitizeViolationField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const field = value.trim().slice(0, MAX_VIOLATION_FIELD_LEN);
  return SAFE_VIOLATION_FIELD.test(field) ? field : null;
}

function sanitizeViolationDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const description = value.replace(/\s+/g, ' ').trim().slice(0, MAX_VIOLATION_DESCRIPTION_LEN);
  if (!description || UNSAFE_VIOLATION_DESCRIPTION.test(description)) return null;
  return description;
}

/**
 * Project an already-parsed sibling 400 body down to its safe proto/sebuf
 * `ValidationError.violations`. Only `{field, description}` pairs survive,
 * each length-bounded and character-restricted. Unknown keys, non-string
 * values, and credential-like text are dropped — never copied into the error.
 *
 * Kept separate from the reading helper so every caller that has already
 * consumed the body (a sibling classifier can only read it once) projects it
 * through this exact function rather than reimplementing the sanitizing —
 * that divergence is what let the observed-downstream path drop violations.
 */
export function parseSafeRpcViolations(parsed: unknown): readonly RpcValidationViolation[] {
  if (!parsed || typeof parsed !== 'object' || !('violations' in parsed)) return [];
  const raw = (parsed as { violations: unknown }).violations;
  if (!Array.isArray(raw)) return [];

  const violations: RpcValidationViolation[] = [];
  for (const item of raw) {
    if (violations.length >= MAX_VALIDATION_VIOLATIONS) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as { field?: unknown; description?: unknown };
    const field = sanitizeViolationField(record.field);
    const description = sanitizeViolationDescription(record.description);
    if (!field || !description) continue;
    violations.push({ field, description });
  }
  return violations;
}

/**
 * Extract proto/sebuf `ValidationError.violations` from a sibling 400 body.
 * Malformed JSON, HTML, and oversized leftovers are dropped; whatever parses
 * is projected through {@link parseSafeRpcViolations}.
 */
export async function extractSafeRpcViolations(
  response: ToolFetchResponse,
): Promise<readonly RpcValidationViolation[]> {
  const type = (response.headers?.get('Content-Type') ?? '').toLowerCase();
  if (type.includes('html')) return [];

  const detail = await readBoundedResponseText(response, MAX_VALIDATION_BODY_BYTES);
  if (!detail) return [];

  try {
    return parseSafeRpcViolations(JSON.parse(detail));
  } catch {
    return [];
  }
}

/**
 * Standard non-ok handling for tool `_execute` gateway fetches: billing
 * denials become typed errors dispatch can re-emit faithfully; proto 400
 * bodies with safe field violations become RpcValidationError; everything
 * else keeps the existing `<label> HTTP <status>` Error contract.
 *
 * HTTP 400 response bodies are consumed only to classify violations. Callers
 * must await this helper — a forgotten await would let execution continue
 * and treat the 400 as success.
 */
export async function assertToolFetchOk(response: ToolFetchResponse, label: string): Promise<void> {
  if (response.ok) return;
  throwIfBillingDenial(response, label);
  if (response.status === 400) {
    const violations = await extractSafeRpcViolations(response);
    if (violations.length > 0) {
      throw new RpcValidationError(label, violations);
    }
  }
  throw new Error(`${label} HTTP ${response.status}`);
}
