import jmespath from 'jmespath';

/**
 * Attribution rider — the accompaniment obligation, carried by construction.
 *
 * Restricted VALUES are already redacted before anything reaches this module.
 * `requiresRedistributableProvidersForDirectRpc` (server/_shared/provider-
 * redistribution.ts) is true for every MCP call, which drives
 * `enforceCommodityRedistributionPolicy` and `decideIndicatorRawRedistribution`
 * to blank or drop whatever may not be redistributed. What survives to the
 * projection boundary is redistribution-PERMITTED. The only residual licence
 * obligation on those payloads is that the attribution travels with the values.
 *
 * A JMESPath projection can detach a value from the licence fields that sit
 * beside it in the unprojected payload. The old answer was a roster of tools
 * that refused projection outright; the roster protected two tools that carry
 * no attribution at all and missed three that do. This module replaces it: a
 * licence-bearing tool declares ONE JMESPath expression that extracts its
 * source list, and the dispatcher re-attaches that list to every projected
 * response. The projection can no longer separate the two because the rider is
 * merged AFTER `jmespath.search` — no expression can name it, reach it, or
 * remove it.
 *
 * Both surfaces import this module: `api/mcp/dispatch.ts` (keyed on the tool's
 * `_attribution`) and `server/gateway.ts` (keyed on the request pathname, via
 * `REST_ATTRIBUTION_EXPRESSIONS`).
 *
 * It lives in `shared/`, not `server/_shared/`, because `shared/` is the only
 * directory reachable from every surface that needs the policy. `api/mcp/`
 * could import `server/_shared/` — 13 of its modules already do — but the
 * Railway seeder images build with `root_dir=scripts` and package only
 * `scripts/` and `shared/`, so a relative import that escapes into `server/`
 * is `ERR_MODULE_NOT_FOUND` at runtime there (see the rule stated at length in
 * `scripts/_simulation-queue-constants.mjs` and pinned by
 * `tests/scripts-railway-nixpacks-no-escape-import.test.mts`). A licence
 * policy is exactly the kind of thing a seeder or a plain-node check will want
 * to read, so it goes where all three can load it.
 */

/**
 * Property names whose presence in a tool's `outputSchema` means the payload
 * carries attribution that a projection could strip.
 *
 * This is the detection primitive behind the build-time gate in
 * `tests/mcp-attribution-rider.test.mjs`: any tool whose outputSchema declares
 * one of these must either declare an `_attribution` extraction or appear in
 * that test's commented exemption allowlist. Adding a tool with an
 * `attribution` field and no extraction fails the build.
 */
export const LICENCE_MARKER_FIELDS: ReadonlySet<string> = new Set([
  'license',
  'licenseUrl',
  'attribution',
  'attributionUrl',
  'redistributionRestricted',
]);

export interface AttributionRider {
  required: true;
  notice: string;
  sources: Array<Record<string, unknown>>;
}

/**
 * Short and factual on purpose. The rider rides on every projected response of
 * a licence-bearing tool, so its bytes are charged against the caller's output
 * budget on every call — and an agent reading it needs the obligation, not
 * prose about it.
 */
export const ATTRIBUTION_RIDER_NOTICE =
  'The values in `data` are derived from the sources listed here. Redistribution requires this attribution block to travel with them.';

/**
 * REST parity map: request pathname → the same class of extraction expression
 * a tool declares via `_attribution`.
 *
 * Keyed on the path rather than the tool because the REST shapes are not the
 * MCP shapes: `/api/safety/v1/get-toronto-safety` serves BOTH Toronto datasets
 * from one flat response (the two MCP tools each read one cache key under a
 * cache envelope), and `get_imd_cyclone_marine` has no REST path at all
 * (`_apiPaths: []`).
 */
export const REST_ATTRIBUTION_EXPRESSIONS: Readonly<Record<string, string>> = {
  // Same payload as the get_resilience_indicators tool: its `_execute` returns
  // this endpoint's JSON verbatim, so the expression is identical.
  '/api/resilience/v1/get-resilience-indicators':
    'indicators[].sources[].{key: key, name: name, attribution: attribution, license: license, url: url, licenseUrl: licenseUrl, attributionUrl: attributionUrl}',
  // Flat response, one dataset per request (`?dataset=`), with the licence
  // assertion at the top level — see queryTorontoSafety's return shape.
  '/api/safety/v1/get-toronto-safety':
    '{attribution: attribution, source: source, sourceUrl: sourceUrl, fetchedAt: fetchedAt}',
};

/**
 * Strip fields that carry no attribution (absent, or present-but-empty). A
 * JMESPath multiselect-hash fills every declared key, so an extraction over a
 * payload missing one field yields an explicit `null` for it; keeping those
 * would make the rider mostly nulls.
 */
function pruneEmpty(entry: Record<string, unknown>): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null || value === undefined || value === '') continue;
    kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * Dedupe identity. `key` is the stable source identifier on a resilience
 * source, and one source is cited by many indicators, so a flattened
 * `indicators[].sources[]` repeats it dozens of times. Everything else dedupes
 * on its full canonical form.
 */
function dedupeIdentity(entry: Record<string, unknown>): string {
  const key = entry.key;
  if (typeof key === 'string' && key !== '') return `key:${key}`;
  return `json:${JSON.stringify(entry, Object.keys(entry).sort())}`;
}

/**
 * Run a tool's declared extraction against its UNPROJECTED payload and build
 * the rider.
 *
 * Pure. Never throws — a malformed expression or a payload shape the expression
 * does not match yields `null`, never an exception that could turn a successful
 * tool call into a 5xx.
 *
 * Returns `null` when the extraction yields nothing: the payload carried no
 * licensed source values (an unavailable cache read, an empty portfolio), so
 * there is no accompaniment obligation to discharge and the caller keeps the
 * pre-rider wire shape.
 */
export function buildAttributionRider(
  payload: unknown,
  extractionExpr: string,
): AttributionRider | null {
  if (typeof extractionExpr !== 'string' || extractionExpr === '') return null;

  let extracted: unknown;
  try {
    extracted = jmespath.search(payload, extractionExpr);
  } catch {
    // A broken expression must not break the tool. The gate test proves every
    // declared expression parses and matches its schema, so reaching here in
    // production means a payload shape drifted — degrade to no rider rather
    // than failing the call.
    return null;
  }

  const candidates = Array.isArray(extracted) ? extracted : [extracted];
  const sources: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const pruned = pruneEmpty(candidate as Record<string, unknown>);
    if (pruned === null) continue;
    const identity = dedupeIdentity(pruned);
    if (seen.has(identity)) continue;
    seen.add(identity);
    sources.push(pruned);
  }

  if (sources.length === 0) return null;
  return { required: true, notice: ATTRIBUTION_RIDER_NOTICE, sources };
}

/**
 * Merge a rider onto an already-serialized projection.
 *
 * Takes the projected JSON TEXT, not a value, and splices the rider around it:
 * `{"data":<projected>,"_attribution":<rider>}`. That is the whole safety
 * argument made literal — the rider's bytes are concatenated outside the
 * document `jmespath.search` produced, so no expression can reach or remove
 * them, and there is no parse/re-stringify round trip over a payload that may
 * be a quarter of a megabyte.
 *
 * The caller passes text that is always a valid JSON document (both projection
 * helpers coerce a `stringify` of `undefined` to the literal `null`), including
 * the `{_jmespath_error, original_keys}` soft-fail envelope — a licence-bearing
 * tool's rider rides on that envelope too.
 */
export function mergeAttributionRider(projectedText: string, rider: AttributionRider): string {
  return `{"data":${projectedText},"_attribution":${JSON.stringify(rider)}}`;
}

/**
 * Walk a JSON Schema and report every licence marker it declares, as
 * dot-paths for a legible failure message. Used by the build-time gate so the
 * test cannot drift its own idea of what counts as a marker.
 */
export function findLicenceMarkerFields(schema: unknown, path = ''): string[] {
  const hits: string[] = [];
  const visit = (node: unknown, nodePath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodePath}[${index}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        (key === 'properties' || key === 'patternProperties')
        && value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
      ) {
        for (const propertyName of Object.keys(value as Record<string, unknown>)) {
          if (LICENCE_MARKER_FIELDS.has(propertyName)) hits.push(`${nodePath}.${propertyName}`);
        }
      }
      visit(value, `${nodePath}.${key}`);
    }
  };
  visit(schema, path);
  return [...new Set(hits)];
}
