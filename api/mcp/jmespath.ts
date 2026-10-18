import { searchBoundedJmespath } from '../../server/_shared/bounded-jmespath';
import { JMESPATH_MAX_EXPR_BYTES, JMESPATH_MAX_OUTPUT_BYTES } from './constants';
import type { ApplyJmespathResult } from './types';
import { utf8ByteLength } from './utils';
import { stringifyWithinBudget } from '../../server/_shared/bounded-json';

// ---------------------------------------------------------------------------
// JMESPath projection helpers (v1.4.0)
//
// `applyJmespath` is invoked at the dispatch boundary AFTER `_postFilter`
// and `summary` (both inside `executeTool`). Single insertion point in
// `dispatchToolsCall` covers both cache and RPC tools uniformly.
//
// The helper returns the wire-ready JSON string in `text` so dispatch can
// write it straight into `content[0].text` without re-serializing. The gates
// protect expression size, evaluation, and output size. All fail soft.
// ---------------------------------------------------------------------------

// Universal JMESPath projection (v1.4.0) — advertised on every tool (cache
// AND RPC). Description is intentionally terse (~110 bytes) to avoid ×38
// bloat across `tools/list`; the grammar URL + worked examples + limits +
// quota note live in `initialize.result.instructions` (one ~600B emit per
// session, amortised across N tool calls).
export const JMESPATH_SCHEMA = {
  type: 'string',
  description: 'Optional JMESPath projection applied to the response. See initialize.instructions for grammar and examples.',
} as const;

// Defensive snapshot of the top-level keys / shape of an unprojected value.
// Echoed inside every `_jmespath_error` envelope so the LLM can self-correct
// on its next `tools/call` without refetching the (already-paid-for) payload.
// Bounded at 50 keys to defend against pathological objects.
function jmespathOriginalKeys(v: unknown): string[] {
  if (Array.isArray(v)) return [`<array length=${v.length}>`];
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object);
    if (keys.length <= 50) return keys;
    return [...keys.slice(0, 50), `...<${keys.length - 50} more>`];
  }
  return [`<${typeof v}>`];
}

// Apply a JMESPath expression to a value. Always returns `{ text }`. Pure;
// never throws. Identity path (no `exprArg`, empty string, non-string) skips
// projection entirely and returns `JSON.stringify(value)`. See module-doc
// for the projection limits.
export function applyJmespath(value: unknown, exprArg: unknown): ApplyJmespathResult {
  if (typeof exprArg !== 'string' || exprArg.length === 0) {
    // `JSON.stringify(undefined)` returns the literal value `undefined`
    // (not a string), which would propagate up to `rpcOk(...content[0].text)`
    // and serialize the field away — clients would see a missing `text`
    // field. Same guard as the projection path: stringify-then-coerce-to-'null'.
    const text = JSON.stringify(value);
    return { text: text === undefined ? 'null' : text, value };
  }

  // Input gate — reject before parser.
  const exprBytes = utf8ByteLength(exprArg);
  if (exprBytes > JMESPATH_MAX_EXPR_BYTES) {
    const envelope = {
      _jmespath_error: `expression_too_long: ${exprBytes} > ${JMESPATH_MAX_EXPR_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), value: envelope, failed: 'expression_too_long' };
  }

  let projected: unknown;
  try {
    projected = searchBoundedJmespath(value, exprArg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const envelope = {
      _jmespath_error: `invalid_expression: ${message}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), value: envelope, failed: 'invalid_expression' };
  }

  // Output gate — measured before serializing. Projections can share
  // sub-objects, so the serialized form can be exponentially larger than the
  // value graph; a post-stringify check would already have paid for it.
  const bounded = stringifyWithinBudget(projected, JMESPATH_MAX_OUTPUT_BYTES);
  if (!bounded.ok) {
    const envelope = {
      _jmespath_error: `projection_too_large: ${bounded.minBytes} > ${JMESPATH_MAX_OUTPUT_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), value: envelope, failed: 'projection_too_large' };
  }
  const safeText = bounded.text;

  return { text: safeText, value: projected };
}
