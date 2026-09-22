import type { AttributionRider } from '../../shared/attribution-rider';

// ---------------------------------------------------------------------------
// `structuredContent` + the schema it is advertised under (#8328)
//
// A strict MCP client — the official SDK, and hosts built on it such as Grok
// Bot's — enforces two rules once a tool advertises `outputSchema`:
//
//   1. a `tools/call` result MUST carry `structuredContent` (unless `isError`),
//      else the CLIENT throws -32600 before the model sees anything;
//   2. that `structuredContent` MUST validate against the advertised schema,
//      else it throws -32602.
//
// Rule 2 is why the payload cannot just be copied across. A tool's declared
// schema describes its documented shape, with `required` keys, and three
// responses are legitimately not that shape: a payload the caller reshaped
// (`jmespath`, or `summary: true`), the `_jmespath_error` envelope and the
// `_budget_exceeded` envelope. So the schema that goes on the wire says so:
// `anyOf [documented shape, those shapes]`.
//
// `content[0].text` is untouched by any of this — lenient clients, the CLI and
// the SDKs read the same bytes they always did.
// ---------------------------------------------------------------------------

// The shapes a response can take besides the tool's documented one. Each is
// identified by a key the documented shapes never use at their root.
const NON_DOCUMENTED_BRANCHES: readonly object[] = [
  // The payload as reshaped by the caller: a `jmespath` projection, or a cache
  // tool's `summary: true` (lists become `{count, sample}`). A projection can
  // be any JSON value and `structuredContent` must be an object, so both are
  // carried under one key.
  { required: ['projection'] },
  // A projection from a licence-bearing tool: the attribution rider already
  // wraps it (`mergeAttributionRider`), so it is sent as it appears in the text.
  { required: ['data', '_attribution'] },
  { required: ['_budget_exceeded'] },
  { required: ['_jmespath_error'] },
];

/** The `outputSchema` to advertise for a tool whose documented shape is `documented`. */
export function advertisedOutputSchema(documented: object): object {
  return { type: 'object', anyOf: [documented, ...structuredClone(NON_DOCUMENTED_BRANCHES)] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `structuredContent` for a successful dispatch.
 *
 * `value` is the document `content[0].text` serializes before any rider is
 * spliced on (`applyJmespath().value`). An unprojected payload and the
 * soft-fail envelope are objects and go out as they are; a reshaped payload
 * is wrapped, as is any payload that is not a JSON object, because the field
 * must be one.
 */
export function buildStructuredContent(
  value: unknown,
  opts: { reshaped: boolean; rider: AttributionRider | null },
): Record<string, unknown> {
  if (opts.rider !== null) return { data: value ?? null, _attribution: opts.rider };
  if (!opts.reshaped && isPlainObject(value)) return value;
  return { projection: value ?? null };
}
