/**
 * Redaction for Umami collector error bodies — the SINGLE implementation shared
 * by the CI monitor (`scripts/check-analytics-collector.mjs`) and the browser
 * tracker facade (`src/services/analytics.ts`).
 *
 * Both surfaces print what this returns: the monitor into a GitHub Actions log,
 * the browser into `console.warn` and Sentry. Umami v3.1.0 puts the full Prisma
 * message, the failing argument object, and a stack into its 500 body, so this
 * must return ONLY stable database failure identifiers — never the server's
 * message, stack, or any request-adjacent payload.
 *
 * It lives here rather than being duplicated per surface because a divergence
 * between the two copies means the CI log and the browser console stop agreeing
 * on what is safe to emit, and only one side has tests.
 *
 * @typedef {{ prismaCode?: string, constraint?: string }} CollectorFailureMetadata
 */

/**
 * Prisma error codes are always `P` + 4 digits, so this bounds the value to 5
 * characters and cannot pass arbitrary text through.
 */
const PRISMA_CODE_PATTERN = /^P\d{4}$/;

/**
 * A Postgres constraint identifier: bounded length, identifier characters only,
 * and must END in `_pkey`. Anchoring BOTH ends matters — a suffix-only test
 * (`/(?:^|_)pkey$/`) passes any string that happens to end in `_pkey`, which
 * would emit an arbitrary-length attacker- or server-controlled value verbatim.
 */
const CONSTRAINT_PATTERN = /^[a-z0-9_]{1,64}_pkey$/i;

/**
 * The same bounded identifier, extracted from inside free-form prose. Used for
 * the `message` field, where Prisma embeds the constraint name in a sentence
 * that also contains the failing column values.
 */
const CONSTRAINT_IN_MESSAGE_PATTERN = /\b[a-z0-9_]{1,64}_pkey\b/i;

/**
 * Pull only stable database failure identifiers from an Umami error body.
 *
 * @param {unknown} body Raw response body text.
 * @returns {CollectorFailureMetadata} At most `prismaCode` and `constraint`.
 */
export function extractCollectorFailureMetadata(body) {
  if (typeof body !== 'string' || body.length === 0) return {};

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }

  /** @type {string | undefined} */
  let prismaCode;
  /** @type {string | undefined} */
  let constraint;

  /**
   * @param {unknown} value
   * @param {string} key
   */
  const visit = (value, key = '') => {
    if (value === null || value === undefined || (prismaCode && constraint)) return;
    if (typeof value === 'string') {
      if (!prismaCode && key === 'code' && PRISMA_CODE_PATTERN.test(value)) {
        prismaCode = value;
      }
      if (!constraint && (key === 'constraint' || key === 'target') && CONSTRAINT_PATTERN.test(value)) {
        constraint = value;
      }
      if (!constraint && key === 'message') {
        constraint = value.match(CONSTRAINT_IN_MESSAGE_PATTERN)?.[0];
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
    }
  };
  visit(parsed);

  return {
    ...(prismaCode ? { prismaCode } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

/**
 * True when a failure is the known upstream Umami v3.1 `session_data` uniqueness
 * race (umami-software/umami#4183).
 *
 * @param {CollectorFailureMetadata} metadata
 * @returns {boolean}
 */
export function isSessionDataConflict(metadata) {
  return metadata.prismaCode === 'P2002' || metadata.constraint === 'session_data_pkey';
}

/**
 * True when a 200 body is Umami's bot-filter sentinel.
 *
 * When Umami's User-Agent bot check rejects a write it answers `HTTP 200` with
 * `{"beep":"boop"}` and stores nothing — an intentional silent drop, not a
 * failure of the write path. Verified against production 2026-08-01: a
 * HeadlessChrome UA gets this 15-byte body while a real browser UA gets the
 * full `{cache, sessionId, visitId}` receipt.
 *
 * This is deliberately keyed off the PARSED `beep` property rather than a
 * substring scan of the raw body. A receipt's field values are upstream-
 * controlled strings, so `body.includes('beep')` would let one forge a
 * bot-filter verdict and mute a genuine delivery failure.
 *
 * @param {unknown} body Raw response body text.
 * @returns {boolean}
 */
export function isBotFilteredBody(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && parsed.beep === 'boop';
  } catch {
    return false;
  }
}
