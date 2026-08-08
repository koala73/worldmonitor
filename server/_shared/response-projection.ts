import jmespath from 'jmespath';

// Universal REST response projection — the gateway applies an optional
// `?jmespath=<expr>` query parameter to any JSON GET response, mirroring the
// `jmespath` argument the MCP server already exposes on every tool
// (api/mcp/jmespath.ts). Agents reuse the SAME expressions across MCP and REST
// to project/reduce a payload server-side before it crosses the wire.
//
// The byte caps are kept identical to the MCP contract (JMESPATH_MAX_EXPR_BYTES
// and JMESPATH_MAX_OUTPUT_BYTES) so an expression and its projected output have
// the same acceptance envelope on both surfaces.

// Mirrors api/mcp/constants.ts `JMESPATH_MAX_EXPR_BYTES`. Duplicated as a plain
// constant so this edge-server helper stays free of MCP-module imports.
export const REST_JMESPATH_MAX_EXPR_BYTES = 1024;
export const REST_JMESPATH_MAX_OUTPUT_BYTES = 256 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Defensive snapshot of the top-level keys / shape of the unprojected value,
// echoed in the error envelope so an agent can self-correct its next request
// without refetching. Bounded at 50 keys. Matches the MCP envelope's
// `original_keys` contract (docs/mcp-error-catalog).
function originalKeys(value: unknown): string[] {
  if (Array.isArray(value)) return [`<array length=${value.length}>`];
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object);
    if (keys.length <= 50) return keys;
    return [...keys.slice(0, 50), `...<${keys.length - 50} more>`];
  }
  return [`<${typeof value}>`];
}

export interface JmespathErrorEnvelope {
  _jmespath_error: string;
  original_keys: string[];
}

export type ProjectJsonResult =
  | { ok: true; body: string }
  | { ok: false; envelope: JmespathErrorEnvelope };

// Apply a JMESPath expression to an already-serialized JSON response body.
// Returns the projected JSON string on success, or an error envelope (same
// shape as the MCP `_jmespath_error` contract) the caller serves as a 400.
// Never throws. If the body is not parseable JSON (should not happen for a
// declared application/json response) the original body is returned unchanged
// so a serialization quirk can never turn a 200 into a client error.
export function projectJsonResponse(bodyStr: string, expr: string): ProjectJsonResult {
  const exprBytes = utf8ByteLength(expr);
  if (exprBytes > REST_JMESPATH_MAX_EXPR_BYTES) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {
      /* keep parsed = null; original_keys degrades to `<object>` */
    }
    return {
      ok: false,
      envelope: {
        _jmespath_error: `expression_too_long: ${exprBytes} > ${REST_JMESPATH_MAX_EXPR_BYTES}`,
        original_keys: originalKeys(parsed),
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(bodyStr);
  } catch {
    return { ok: true, body: bodyStr };
  }

  let projected: unknown;
  try {
    projected = jmespath.search(value, expr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      envelope: {
        _jmespath_error: `invalid_expression: ${message}`,
        original_keys: originalKeys(value),
      },
    };
  }

  const text = JSON.stringify(projected);
  // `jmespath.search` returns `undefined` when a path misses; JSON.stringify of
  // that is the JS value `undefined`, not a document — coerce to `null` so the
  // wire payload is always valid JSON.
  const body = text === undefined ? 'null' : text;
  const outputBytes = utf8ByteLength(body);
  if (outputBytes > REST_JMESPATH_MAX_OUTPUT_BYTES) {
    return {
      ok: false,
      envelope: {
        _jmespath_error: `projection_too_large: ${outputBytes} > ${REST_JMESPATH_MAX_OUTPUT_BYTES}`,
        original_keys: originalKeys(value),
      },
    };
  }
  return { ok: true, body };
}
