import type { AttributionRider } from '../../shared/attribution-rider';
import { isPlainObject } from './utils';

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

export const DEPRECATION_NOTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['alias', 'replacement', 'message'],
  properties: {
    alias: { type: 'string' },
    replacement: { type: 'string' },
    message: { type: 'string' },
    limit: {
      type: 'object',
      additionalProperties: false,
      required: ['requested', 'servedAsYears', 'mismatch'],
      properties: {
        requested: { type: ['number', 'null'] },
        servedAsYears: { type: 'integer', minimum: 1, maximum: 30 },
        mismatch: {
          type: 'string',
          enum: ['omitted-was-newest-30', 'non-positive-was-full-history', 'row-cap-as-years', 'capped-at-30'],
        },
      },
    },
    moved: {
      type: 'object',
      additionalProperties: false,
      required: ['dataset', 'tool'],
      properties: {
        dataset: { type: 'string', enum: ['tariffs'] },
        tool: { type: 'string' },
      },
    },
  },
} as const;

/** The `outputSchema` to advertise for a tool whose documented shape is `documented`. */
export function advertisedOutputSchema(
  documented: object,
  opts?: { permitDeprecation?: boolean },
): object {
  const branches: object[] = [documented, ...structuredClone(NON_DOCUMENTED_BRANCHES)];
  const anyOf = opts?.permitDeprecation === true ? branches.map((branch) => permitDeprecationRoot(branch)) : branches;
  return { type: 'object', anyOf };
}

export function permitDeprecationRoot(branch: object): object {
  const record = isPlainObject(branch) ? branch : {};
  const properties = isPlainObject(record.properties) ? record.properties : {};
  return { ...record, properties: { ...properties, deprecation: DEPRECATION_NOTICE_SCHEMA } };
}

export function schemaAdmitsNotice(advertised: object): boolean {
  if (!isPlainObject(advertised) || !Array.isArray(advertised.anyOf) || advertised.anyOf.length === 0) return false;
  for (const branch of advertised.anyOf) {
    if (!isPlainObject(branch) || !isPlainObject(branch.properties)) return false;
    if (branch.properties.deprecation !== DEPRECATION_NOTICE_SCHEMA) return false;
    if (hasNestedDeprecationProperty(branch)) return false;
  }
  return true;
}

function hasNestedDeprecationProperty(root: Record<string, unknown>): boolean {
  const visit = (node: unknown, atRoot: boolean): boolean => {
    if (Array.isArray(node)) return node.some((item) => visit(item, false));
    if (!isPlainObject(node)) return false;
    if (!atRoot && isPlainObject(node.properties) && Object.prototype.hasOwnProperty.call(node.properties, 'deprecation')) {
      return true;
    }
    return Object.values(node).some((value) => visit(value, false));
  };
  return visit(root, true);
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

export function applyDeprecationNotice(
  structured: Record<string, unknown>,
  text: string,
  notice: {
    readonly alias: string;
    readonly replacement: string;
    readonly message: string;
    readonly limit?: {
      readonly requested: number | null;
      readonly servedAsYears: number;
      readonly mismatch: string;
    };
    readonly moved?: { readonly dataset: string; readonly tool: string };
  },
): { structuredContent: Record<string, unknown>; text: string } {
  const structuredContent = { ...structured, deprecation: notice };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // A scalar or array projection keeps its raw text, as a direct call returns
  // it; the notice still reaches the client through structuredContent.
  const nextText = isPlainObject(parsed) ? JSON.stringify({ ...parsed, deprecation: notice }) : text;
  return { structuredContent, text: nextText };
}
