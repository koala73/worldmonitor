/**
 * Agent feedback channel (#8721): the one write path both doors share.
 *
 * REST `POST /api/feedback/v1/submit-report` and the MCP `report_issue` tool
 * both call `submitAgentFeedback`, so a caller has one budget across both and
 * every report is parsed, sanitized, redacted, and hashed the same way.
 *
 * Read docs/architecture/agent-feedback-threat-model.md before changing a
 * bound, a bucket, or what a response carries. Every text field is
 * attacker-controlled: it is stored as data and never logged, echoed in an
 * error, or interpolated into a prompt.
 */

import type { Duration } from '@upstash/ratelimit';
import { SENSITIVE_URL_PARAM_RE, scrubUrl } from '../../shared/sensitive-url-params';
import { stripNotificationControlChars, URL_TOKEN_PATTERN } from './notify-fields';
import { checkScopedRateLimit } from './rate-limit';
import { rateLimitKeyForIp } from './client-ip';

export const FEEDBACK_KINDS = ['bug', 'missing_capability', 'data_quality', 'security'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_ADVISORY_URL = 'https://github.com/koala73/worldmonitor/security/advisories/new';
export const FEEDBACK_SECURITY_NOTICE =
  `Do not send exploit details through this channel. Use the private advisory form: ${FEEDBACK_ADVISORY_URL}`;

// Bounds in code points (threat model, "The accepted input").
export const FEEDBACK_MAX_SUMMARY = 300;
export const FEEDBACK_MAX_DETAIL = 2000;
export const FEEDBACK_MAX_SURFACE_INPUT = 200;
export const FEEDBACK_MAX_SURFACE_LABEL = 80;
export const FEEDBACK_MAX_REQUEST_ID = 128;
export const FEEDBACK_MAX_CLIENT_NAME = 80;
// Decision 4: the largest valid report is ~18 KB of UTF-8 before escaping.
export const FEEDBACK_MAX_BODY_BYTES = 24 * 1024;

const REQUEST_ID_RE = /^[A-Za-z0-9:_-]+$/;
const RPC_PATH_RE = /^\/api\/[a-z0-9-]+\/v\d+\/[a-z0-9-]+$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type FeedbackSurface =
  | { type: 'mcp_tool'; name: string }
  | { type: 'rpc'; name: string }
  | { type: 'other'; name: string };

export interface FeedbackReport {
  kind: FeedbackKind;
  surface: FeedbackSurface;
  summary: string;
  expected?: string;
  actual?: string;
  requestId?: string;
  clientName?: string;
}

export interface FeedbackParseOptions {
  /** The MCP door knows its registry; REST classifies by shape only. */
  isKnownTool?: (name: string) => boolean;
}

export type FeedbackParseResult =
  | { ok: true; report: FeedbackReport }
  | { ok: false; field: string };

function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

function clipCodePoints(value: string, max: number): string {
  return codePoints(value) > max ? Array.from(value).slice(0, max).join('') : value;
}

/** Decision 7: sanitize once at ingest. Also collapses whitespace runs. */
function sanitize(value: string): string {
  return stripNotificationControlChars(value).replace(/\s+/g, ' ').trim();
}

// In u-mode a valid pair is one code point, so only a lone surrogate matches.
const LONE_SURROGATE_RE = /\p{Cs}/u;

function optionalText(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  // A lone surrogate is not valid UTF-8 and Convex refuses it: name the field.
  if (typeof raw !== 'string' || LONE_SURROGATE_RE.test(raw)) return null;
  const clean = sanitize(raw);
  return clean.length === 0 ? undefined : clean;
}

export function classifySurface(raw: string | undefined, options: FeedbackParseOptions = {}): FeedbackSurface {
  if (!raw) return { type: 'other', name: 'unspecified' };
  if (RPC_PATH_RE.test(raw) && raw.length <= 120) return { type: 'rpc', name: raw };
  if (TOOL_NAME_RE.test(raw) && raw.length <= 64 && (options.isKnownTool?.(raw) ?? true)) {
    return { type: 'mcp_tool', name: raw };
  }
  // "The tool I needed does not exist" is the signal we want: keep, never reject.
  return { type: 'other', name: clipCodePoints(raw, FEEDBACK_MAX_SURFACE_LABEL) };
}

/**
 * Parses untrusted input into a FeedbackReport. Identity is never read from
 * here. A failure names the field, never its value.
 */
export function parseFeedbackReport(
  raw: Record<string, unknown>,
  options: FeedbackParseOptions = {},
): FeedbackParseResult {
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, field: 'kind' };
  }

  const surface = optionalText(raw.surface);
  if (surface === null || (surface && codePoints(surface) > FEEDBACK_MAX_SURFACE_INPUT)) {
    return { ok: false, field: 'surface' };
  }

  const summary = optionalText(raw.summary);
  if (!summary || codePoints(summary) > FEEDBACK_MAX_SUMMARY) return { ok: false, field: 'summary' };

  const expected = optionalText(raw.expected);
  if (expected === null || (expected && codePoints(expected) > FEEDBACK_MAX_DETAIL)) {
    return { ok: false, field: 'expected' };
  }
  const actual = optionalText(raw.actual);
  if (actual === null || (actual && codePoints(actual) > FEEDBACK_MAX_DETAIL)) {
    return { ok: false, field: 'actual' };
  }

  const requestIdRaw = raw.requestId ?? raw.request_id;
  const requestId = optionalText(requestIdRaw);
  if (requestId === null || (requestId && (requestId.length > FEEDBACK_MAX_REQUEST_ID || !REQUEST_ID_RE.test(requestId)))) {
    return { ok: false, field: 'requestId' };
  }

  const clientName = optionalText(raw.clientName ?? raw.client_name);
  if (clientName === null || (clientName && codePoints(clientName) > FEEDBACK_MAX_CLIENT_NAME)) {
    return { ok: false, field: 'clientName' };
  }

  return {
    ok: true,
    report: {
      kind: kind as FeedbackKind,
      surface: classifySurface(surface, options),
      summary,
      expected,
      actual,
      requestId,
      clientName,
    },
  };
}

// ---------------------------------------------------------------------------
// Redaction (Decision 9)
// ---------------------------------------------------------------------------

const FEEDBACK_EXTRA_URL_PARAM_RE = /^(key|api_key|apikey|secret|password|sig|signature|code|x-amz-[a-z0-9-]*)$/i;

// URL_TOKEN_PATTERN needs a scheme or a dotted host, so a relative path
// ("GET /api/x?api_key=..."), a bare "api_key=...&symbol=AAPL", or "x?key=..."
// never reaches the URL scrub. These passes catch a credential field anywhere,
// however a report pastes it: name=value, name="value", `name=value`, a JSON
// body ("api_key": "...") or a config line (api_key: ...). They are limited to
// credential names. After "=" any value goes except an all-digit one
// ("code=500"). After ":" the next word is often prose ("token: expired"), so
// only a token-shaped value goes, the same rule as a bare "Authorization:".
const BARE_CREDENTIAL_PARAM_RE = /^(token|access_token|id_token|refresh_token|auth_token|api_key|apikey|key|secret|client_secret|password|passwd|sig|signature|code|license_key|x-amz-[a-z0-9-]*)$/i;
const FIELD_LEAD = String.raw`(^|[\s"'(\[{?&#;,\x60])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\2`;
const FIELD_VALUE = String.raw`(["']?)([^\s&"'<>#;,)}\]\x60]+)`;
const BARE_QUERY_FIELD_RE = new RegExp(`${FIELD_LEAD}(=)${FIELD_VALUE}`, 'g');
const COLON_FIELD_RE = new RegExp(`${FIELD_LEAD}(\\s*:\\s*)${FIELD_VALUE}`, 'g');

// After "Bearer" or "Authorization:" the next word is often prose ("the bearer
// token is rejected", "Authorization: missing"). A full header line, with a
// scheme after "Authorization:", is unambiguous: any token value of 6+ goes.
// Otherwise only a credential-shaped value goes: 8+ token characters with a
// digit, a token symbol, or a capital past the first character, or an
// all-lowercase run of 16+, which prose rarely produces.
const TOKEN_CHARS_RE = /^[A-Za-z0-9._~+/=-]+$/;

function isHeaderValue(value: string): boolean {
  return value.length >= 6 && TOKEN_CHARS_RE.test(value);
}

function isTokenShaped(value: string): boolean {
  if (value.length < 8 || !TOKEN_CHARS_RE.test(value)) return false;
  return /[0-9._~+/=-]|.[A-Z]/.test(value) || value.length >= 16;
}

const AUTH_VALUE_PATTERNS: ReadonlyArray<[RegExp, (value: string) => boolean]> = [
  [/(\bAuthorization"?\s*[:=]\s*"?(?:Bearer|Basic|Token)\s+)([^\s",;}]+)/gi, isHeaderValue],
  [/(\bAuthorization"?\s*[:=]\s*"?)([^\s",;}]+)/gi, isTokenShaped],
  [/(\bBearer\s+)([^\s",;}]+)/gi, isTokenShaped],
];

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:x-api-key|x-worldmonitor-key)"?\s*[:=]\s*"?[^\s",;}]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Real shapes only, so identifiers like wm_api_usage survive.
  /\bwm_[a-f0-9]{40}\b/gi,
  /\bwms_[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)?/g,
  /\bsntryu_[A-Za-z0-9_-]{8,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:prod|dev|preview):[A-Za-z0-9-]+\|[A-Za-z0-9+/=_-]+/g,
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const FEEDBACK_REDACTED = '[redacted]';
export const FEEDBACK_EMAIL_PLACEHOLDER = '<email>';

function redactUrlToken(token: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : `https://${token}`;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return token;
  }
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  if (scrubUrl(parsed, SENSITIVE_URL_PARAM_RE)) changed = true;
  if (scrubUrl(parsed, FEEDBACK_EXTRA_URL_PARAM_RE)) changed = true;
  if (!changed) return token;
  const out = parsed.toString();
  return absolute === token ? out : out.replace(/^https:\/\//, '');
}

/** Scrubs URL credentials, credential shapes, then email addresses, in that order. */
export function redactFeedbackText(value: string): { text: string; redacted: boolean } {
  let text = value.replace(URL_TOKEN_PATTERN, (token) => redactUrlToken(token));
  for (const [pattern, isCredential] of [
    [BARE_QUERY_FIELD_RE, (fieldValue: string) => !/^\d+$/.test(fieldValue)],
    [COLON_FIELD_RE, isTokenShaped],
  ] as const) {
    text = text.replace(
      pattern,
      (match, lead: string, nameQuote: string, name: string, separator: string, valueQuote: string, fieldValue: string) => (
        BARE_CREDENTIAL_PARAM_RE.test(name) && isCredential(fieldValue)
          ? `${lead}${nameQuote}${name}${nameQuote}${separator}${valueQuote}${FEEDBACK_REDACTED}`
          : match
      ),
    );
  }
  for (const [pattern, isCredential] of AUTH_VALUE_PATTERNS) {
    text = text.replace(pattern, (match, prefix: string, value: string) => (
      isCredential(value) ? `${prefix}${FEEDBACK_REDACTED}` : match
    ));
  }
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, FEEDBACK_REDACTED);
  text = text.replace(EMAIL_RE, FEEDBACK_EMAIL_PLACEHOLDER);
  return { text, redacted: text !== value };
}

function redactReport(report: FeedbackReport): { report: FeedbackReport; redacted: boolean } {
  let redacted = false;
  const scrub = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const result = redactFeedbackText(value);
    if (result.redacted) redacted = true;
    return result.text;
  };
  // Every classification is scrubbed: a wm_ key or sk_live_ token has the
  // same shape as a tool name. A name that changed is no longer a real one.
  const scrubbedName = scrub(report.surface.name)!;
  const surface: FeedbackSurface = scrubbedName === report.surface.name
    ? report.surface
    : { type: 'other', name: scrubbedName };
  // A request id is held to its own charset, so a credential pasted in its
  // place is dropped rather than replaced with a placeholder it cannot hold.
  let requestId = report.requestId;
  if (requestId !== undefined && redactFeedbackText(requestId).redacted) {
    requestId = undefined;
    redacted = true;
  }
  return {
    report: {
      ...report,
      surface,
      summary: scrub(report.summary)!,
      expected: scrub(report.expected),
      actual: scrub(report.actual),
      requestId,
      clientName: scrub(report.clientName),
    },
    redacted,
  };
}

// ---------------------------------------------------------------------------
// Identity and hashes (Decisions 3 and 8)
// ---------------------------------------------------------------------------

export type FeedbackCaller =
  | { authKind: 'anonymous' }
  | { authKind: 'keyed'; principalId: string };

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Per-IP bucket key: the address itself, or its /64 for IPv6 (Decision 2).
 * The outer endpoint limiter's own key, so the two can never disagree.
 */
export function feedbackIpKey(ip: string): string {
  return rateLimitKeyForIp(ip.trim());
}

/** Decision 3: one canonical encoding, absent fields written as null. */
function canonical(parts: ReadonlyArray<string | undefined>): string {
  return JSON.stringify(parts.map((p) => (p === undefined ? null : p)));
}

export function surfaceKey(surface: FeedbackSurface): string {
  return surface.type === 'other' ? `other:${surface.name}` : surface.name;
}

export function normalizeForFingerprint(summary: string): string {
  return summary.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function feedbackFingerprint(report: FeedbackReport): Promise<string> {
  return sha256Hex(canonical([report.kind, surfaceKey(report.surface), normalizeForFingerprint(report.summary)]));
}

export async function feedbackRetryKey(report: FeedbackReport, reporterKey: string): Promise<string> {
  return sha256Hex(canonical([
    reporterKey,
    report.kind,
    surfaceKey(report.surface),
    report.summary,
    report.expected,
    report.actual,
    report.requestId,
    report.clientName,
  ]));
}

// ---------------------------------------------------------------------------
// Admission (Decision 2)
// ---------------------------------------------------------------------------

interface Bucket { scope: string; limit: number; window: Duration; identifier: string; global: boolean }

export const FEEDBACK_BUCKETS = {
  anonymousPerIp: { scope: 'agent-feedback:anon-ip', limit: 5, window: '1 h' as Duration },
  keyedPerPrincipal: { scope: 'agent-feedback:keyed', limit: 30, window: '1 d' as Duration },
  globalAnonymous: { scope: 'agent-feedback:global-anon', limit: 100, window: '1 h' as Duration },
  globalKeyed: { scope: 'agent-feedback:global-keyed', limit: 500, window: '1 d' as Duration },
  globalSecurity: { scope: 'agent-feedback:global-security', limit: 30, window: '1 d' as Duration },
} as const;

export type FeedbackAdmission =
  | { admitted: true }
  | { admitted: false; status: 429 | 503 };

/**
 * Charges the caller's buckets in order and stops at the first denial. A
 * degraded check (Redis missing, erroring, or timing out) rejects with 503:
 * checkScopedRateLimit is fail-open by default, so failing closed is this
 * function's decision, not inherited.
 */
export type FeedbackLimitCheck = typeof checkScopedRateLimit;

export async function admitFeedbackReport(
  input: { kind: FeedbackKind; caller: FeedbackCaller; ipKey: string },
  check: FeedbackLimitCheck = checkScopedRateLimit,
): Promise<FeedbackAdmission> {
  const b = FEEDBACK_BUCKETS;
  const buckets: Bucket[] = [];
  if (input.caller.authKind === 'keyed') {
    buckets.push({ ...b.keyedPerPrincipal, identifier: input.caller.principalId, global: false });
  } else {
    buckets.push({ ...b.anonymousPerIp, identifier: input.ipKey, global: false });
  }
  if (input.kind === 'security') {
    buckets.push({ ...b.globalSecurity, identifier: 'all', global: true });
  } else if (input.caller.authKind === 'keyed') {
    buckets.push({ ...b.globalKeyed, identifier: 'all', global: true });
  } else {
    buckets.push({ ...b.globalAnonymous, identifier: 'all', global: true });
  }

  for (const bucket of buckets) {
    const result = await check(bucket.scope, bucket.limit, bucket.window, bucket.identifier);
    if (result.degraded) return { admitted: false, status: 503 };
    if (!result.allowed) {
      if (bucket.global) {
        // Alerted on by the phase 8 runbook. Carries no report text.
        console.warn(JSON.stringify({ event: 'agent_feedback_global_bucket_exhausted', scope: bucket.scope }));
      }
      return { admitted: false, status: 429 };
    }
  }
  return { admitted: true };
}

// ---------------------------------------------------------------------------
// Convex write
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function convexSiteUrl(): string {
  return (process.env.CONVEX_SITE_URL
    ?? (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site')).replace(/\/$/, '');
}

async function postConvex(fetchImpl: FetchLike, path: string, body: unknown): Promise<Response | null> {
  const base = convexSiteUrl();
  const secret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!base || !secret) return null;
  try {
    return await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-agent-feedback/1.0',
        'x-convex-shared-secret': secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

function isStoredResult(value: unknown): value is { reportId: string; status: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.reportId === 'string' && v.reportId.length > 0 && typeof v.status === 'string';
}

// ---------------------------------------------------------------------------
// The shared entry point
// ---------------------------------------------------------------------------

export type FeedbackOutcome =
  | {
    ok: true;
    reportId: string;
    status: string;
    advisoryUrl?: string;
    notice?: string;
  }
  | {
    ok: false;
    status: 400 | 403 | 429 | 503;
    field?: string;
    message: string;
    advisoryUrl?: string;
    notice?: string;
  };

export interface FeedbackRequestMeta {
  clientIp: string;
  userAgent: string;
}

function securityExtras(kind: unknown): { advisoryUrl?: string; notice?: string } {
  return kind === 'security' ? { advisoryUrl: FEEDBACK_ADVISORY_URL, notice: FEEDBACK_SECURITY_NOTICE } : {};
}

function failure(status: 400 | 403 | 429 | 503, message: string, kind: unknown, field?: string): FeedbackOutcome {
  const extras = securityExtras(kind);
  const text = extras.notice ? `${message} ${extras.notice}` : message;
  return { ok: false, status, message: text, ...(field ? { field } : {}), ...extras };
}

/**
 * Parse, redact, hash, absorb a retry, admit, and store one report. Never
 * throws for caller input; every outcome is a value the door maps to its own
 * transport.
 */
export async function submitAgentFeedback(
  raw: Record<string, unknown>,
  caller: FeedbackCaller,
  meta: FeedbackRequestMeta,
  deps: FeedbackParseOptions & { fetchImpl?: FetchLike; checkLimit?: FeedbackLimitCheck } = {},
): Promise<FeedbackOutcome> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  const parsed = parseFeedbackReport(raw, deps);
  if (!parsed.ok) return failure(400, `Invalid field: ${parsed.field}.`, raw.kind, parsed.field);
  const { report, redacted } = redactReport(parsed.report);

  // Decision 8: no pepper, no write. A null or unpeppered hash is never stored.
  const pepper = process.env.USAGE_UA_PEPPER;
  if (!pepper) return failure(503, 'Feedback is temporarily unavailable.', report.kind);

  const ipKey = feedbackIpKey(meta.clientIp);
  const ipHash = await sha256Hex(`${pepper}|${ipKey}`);
  const uaHash = meta.userAgent ? await sha256Hex(`${pepper}|${meta.userAgent}`) : undefined;
  const reporterKey = caller.authKind === 'keyed' ? `principal:${caller.principalId}` : `ip:${ipHash}`;
  const fingerprint = await feedbackFingerprint(report);
  const retryKey = await feedbackRetryKey(report, reporterKey);

  // Decision 3: a retry returns the earlier row and costs no budget.
  const lookup = await postConvex(fetchImpl, '/api/internal-find-feedback-retry', { retryKey });
  if (!lookup || !lookup.ok) return failure(503, 'Feedback is temporarily unavailable.', report.kind);
  const lookupBody = await lookup.json().catch(() => null) as { found?: unknown } | null;
  if (isStoredResult(lookupBody?.found)) {
    return { ok: true, reportId: lookupBody.found.reportId, status: lookupBody.found.status, ...securityExtras(report.kind) };
  }

  const admission = await admitFeedbackReport({ kind: report.kind, caller, ipKey }, deps.checkLimit);
  if (!admission.admitted) {
    return admission.status === 429
      ? failure(429, 'Too many reports; try again later.', report.kind)
      : failure(503, 'Feedback is temporarily unavailable.', report.kind);
  }

  const stored = await postConvex(fetchImpl, '/api/internal-submit-feedback', {
    kind: report.kind,
    surfaceType: report.surface.type,
    surfaceName: report.surface.name,
    summary: report.summary,
    expected: report.expected,
    actual: report.actual,
    requestId: report.requestId,
    clientName: report.clientName,
    redacted,
    fingerprint,
    retryKey,
    reporterKey,
    authKind: caller.authKind,
    principalId: caller.authKind === 'keyed' ? caller.principalId : undefined,
    ipHash: caller.authKind === 'keyed' ? undefined : ipHash,
    uaHash,
  });
  if (stored?.status === 429) return failure(429, 'Too many reports; try again later.', report.kind);
  // The account is deleted or being deleted: final, so the caller must not retry.
  if (stored?.status === 403) return failure(403, 'This account can no longer submit reports.', report.kind);
  if (!stored || !stored.ok) return failure(503, 'Feedback is temporarily unavailable.', report.kind);
  const result = await stored.json().catch(() => null);
  if (!isStoredResult(result)) return failure(503, 'Feedback is temporarily unavailable.', report.kind);
  return { ok: true, reportId: result.reportId, status: result.status, ...securityExtras(report.kind) };
}
