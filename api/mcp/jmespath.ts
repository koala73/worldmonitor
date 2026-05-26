import jmespath from 'jmespath';
import { JMESPATH_MAX_EXPR_BYTES, JMESPATH_MAX_OUTPUT_BYTES } from './constants';
import type { ApplyJmespathResult } from './types';
import { utf8ByteLength } from './utils';

// ---------------------------------------------------------------------------
// JMESPath projection helpers (v1.4.0)
//
// `applyJmespath` is invoked at the dispatch boundary AFTER `_postFilter`
// and `summary` (both inside `executeTool`). Single insertion point in
// `dispatchToolsCall` covers both cache and RPC tools uniformly.
//
// The helper returns the wire-ready JSON string in `text` so dispatch can
// write it straight into `content[0].text` without re-serializing. Two
// gates protect the edge function — both fail soft, never throw.
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
// for the two-gate contract.
export function applyJmespath(value: unknown, exprArg: unknown): ApplyJmespathResult {
  if (typeof exprArg !== 'string' || exprArg.length === 0) {
    // `JSON.stringify(undefined)` returns the literal value `undefined`
    // (not a string), which would propagate up to `rpcOk(...content[0].text)`
    // and serialize the field away — clients would see a missing `text`
    // field. Same guard as the projection path: stringify-then-coerce-to-'null'.
    const text = JSON.stringify(value);
    return { text: text === undefined ? 'null' : text };
  }

  // Input gate — reject before parser.
  const exprBytes = utf8ByteLength(exprArg);
  if (exprBytes > JMESPATH_MAX_EXPR_BYTES) {
    const envelope = {
      _jmespath_error: `expression_too_long: ${exprBytes} > ${JMESPATH_MAX_EXPR_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'expression_too_long' };
  }

  let projected: unknown;
  try {
    projected = jmespath.search(value, exprArg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const envelope = {
      _jmespath_error: `invalid_expression: ${message}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'invalid_expression' };
  }

  const text = JSON.stringify(projected);
  // `JSON.stringify(undefined)` returns the string "undefined" in legacy
  // contexts but actually returns `undefined` in JS — guard so the wire
  // payload is always a valid JSON document.
  const safeText = text === undefined ? 'null' : text;

  // Output gate — reject after stringify (single serialization).
  const outputBytes = utf8ByteLength(safeText);
  if (outputBytes > JMESPATH_MAX_OUTPUT_BYTES) {
    const envelope = {
      _jmespath_error: `projection_too_large: ${outputBytes} > ${JMESPATH_MAX_OUTPUT_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'projection_too_large' };
  }

  return { text: safeText };
}
