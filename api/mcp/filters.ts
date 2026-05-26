// ---------------------------------------------------------------------------
// Cache-tool filter + summary helpers
//
// Shared by the `_postFilter` bodies in the registry. Every helper is
// defensive: a missing/wrong-typed argument or an unexpected payload shape
// degrades to a no-op, so a `tools/call` carrying junk arguments still returns
// the full payload instead of erroring. This is what keeps the filter contract
// strictly ADDITIVE — omit all arguments and the response is byte-identical to
// the pre-filter behaviour.
// ---------------------------------------------------------------------------

// Coerce an argument to a lowercase, trimmed string list. Accepts a single
// string or an array; anything else → []. For multi-value filters (symbols,
// countries, dataset, ...).
export function argStrList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return raw.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
}

// Coerce an argument to a finite number, or null when absent/unparseable.
export function argNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Coerce an argument to a single lowercase, trimmed string ('' when absent).
export function argStr(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().trim() : '';
}

// Coerce an argument to a boolean (accepts true / "true" / 1 / "1").
export function argBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// Drop undefined/empty entries from a string list — used after mapping a
// friendly `dataset` enum value through a per-tool alias table (a typo'd enum
// value maps to undefined and is silently dropped).
export function compact(arr: (string | undefined)[]): string[] {
  return arr.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// Case-insensitive substring test, tolerant of non-string haystacks. For
// free-text fields (country names, titles, place strings).
export function ciIncludes(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle);
}

// True when `value` — a scalar code or an array of codes — matches any entry
// in `codes` (case-insensitive exact). Empty `codes` → true (no filter active).
// Handles both scalar ISO fields (item.countryCode) and array ISO fields
// (item.cc, item.countryCodes, event.countries).
export function matchesCode(value: unknown, codes: string[]): boolean {
  if (codes.length === 0) return true;
  const pool = Array.isArray(value) ? value : [value];
  return pool.some((v) => typeof v === 'string' && codes.includes(v.toLowerCase()));
}

// In-place: replace the array at data[label] with its filtered subset.
// No-op when data[label] is not an array (e.g. a flat-array payload like
// sanctions:entities whose label-walked value IS the array).
export function narrowArray(
  data: Record<string, unknown>,
  label: string,
  pred: (item: Record<string, unknown>) => boolean,
): void {
  const arr = data[label];
  if (Array.isArray(arr)) data[label] = (arr as Record<string, unknown>[]).filter(pred);
}

// In-place: replace the array at data[label][child] with its filtered subset.
// Handles the dominant cache shape — a payload object wrapping one array
// (e.g. data['ucdp-events'].events, data['stocks-bootstrap'].quotes).
export function narrowNested(
  data: Record<string, unknown>,
  label: string,
  child: string,
  pred: (item: Record<string, unknown>) => boolean,
): void {
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const arr = (parent as Record<string, unknown>)[child];
    if (Array.isArray(arr)) {
      (parent as Record<string, unknown>)[child] = (arr as Record<string, unknown>[]).filter(pred);
    }
  }
}

// Return a copy of an entity-keyed object map keeping only keys in `codes`
// (case-insensitive). Empty `codes` or a non-object → returned unchanged. A
// request that matches NOTHING also returns the original — additive: a typo'd
// country code must not collapse the payload to empty.
export function pickMapKeys(obj: unknown, codes: string[]): unknown {
  if (codes.length === 0 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    if (codes.includes(k.toLowerCase())) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : obj;
}

// In-place: narrow an entity-keyed map nested at data[label][child] (e.g. the
// IMF `data.macro.countries` / Eurostat `data['house-prices'].countries` maps).
export function pickNestedMap(data: Record<string, unknown>, label: string, child: string, codes: string[]): void {
  const node = data[label];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    (node as Record<string, unknown>)[child] = pickMapKeys((node as Record<string, unknown>)[child], codes);
  }
}

// In-place: cap an entity-keyed map at data[label][child] to its first `n` keys
// in insertion order. The keyed-object analogue of `capNested` (which slices
// arrays). `n` null or ≤ 0 → no-op, so callers can pass the customer-facing
// `limit: 0` opt-out value through unchanged.
export function capNestedMap(data: Record<string, unknown>, label: string, child: string, n: number | null): void {
  if (n == null || n <= 0) return;
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const map = (parent as Record<string, unknown>)[child];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const entries = Object.entries(map as Record<string, unknown>);
      if (entries.length > n) {
        (parent as Record<string, unknown>)[child] = Object.fromEntries(entries.slice(0, n));
      }
    }
  }
}

// In-place: replace data[label][child] with fn(data[label][child]). The generic
// "reach one level into a payload object and transform a value" helper, used
// for keyed-object payloads whose narrowing doesn't fit pickNestedMap.
export function mapNested(
  data: Record<string, unknown>,
  label: string,
  child: string,
  fn: (value: unknown) => unknown,
): void {
  const node = data[label];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const n = node as Record<string, unknown>;
    n[child] = fn(n[child]);
  }
}

// Return a copy of an id-keyed object map keeping only entries whose VALUE
// satisfies `pred` (for payloads keyed by an opaque id — fuel-shortages
// keyed by shortage id, disruptions keyed by event id). Non-object → unchanged.
//
// No-match → `{}` is intentional and correct: this is a VALUE PREDICATE, the
// object-map analogue of `narrowArray` / `narrowNested` — "country=DE has no
// fuel shortages" is a legitimate empty result, exactly like a country filter
// emptying an events array. It deliberately does NOT use the
// `Object.keys(out).length ? out : obj` fall-back that `pickMapKeys` has:
// `pickMapKeys` is a KEY SELECTOR where a no-match means "you named keys that
// don't exist" (a likely typo, so don't nuke the map), whereas a value
// predicate matching nothing is a real answer, not a malformed request.
export function filterMapValues(
  obj: unknown,
  pred: (value: Record<string, unknown>) => boolean,
): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object' && pred(v as Record<string, unknown>)) out[k] = v;
  }
  return out;
}

// Like pickMapKeys but matches keys by case-insensitive SUBSTRING — for the
// chokepoint keyed-object payloads whose ids vary in shape across keys
// (`hormuz_strait` vs `Strait of Hormuz`). Empty needle / no match → unchanged.
export function pickMapKeysLike(obj: unknown, needle: string): unknown {
  if (!needle || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.toLowerCase().includes(needle)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : obj;
}

// Return a copy of the `data` map keeping only the requested labels — the
// `dataset` selector shared by the multi-key bundle tools. Unknown labels are
// ignored; an empty request or one matching nothing → `data` unchanged.
export function selectDatasets(data: Record<string, unknown>, labels: string[]): Record<string, unknown> {
  if (labels.length === 0) return data;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (labels.includes(k.toLowerCase())) out[k] = data[k];
  }
  return Object.keys(out).length > 0 ? out : data;
}

// In-place: cap every top-level array in `data` to `n` items. `n` ≤ 0 or null → no-op.
export function capArrays(data: Record<string, unknown>, n: number | null): void {
  if (n == null || n <= 0) return;
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (Array.isArray(v)) data[k] = v.slice(0, n);
  }
}

// In-place: cap the nested array at data[label][child] to `n` items.
export function capNested(data: Record<string, unknown>, label: string, child: string, n: number | null): void {
  if (n == null || n <= 0) return;
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const arr = (parent as Record<string, unknown>)[child];
    if (Array.isArray(arr)) (parent as Record<string, unknown>)[child] = arr.slice(0, n);
  }
}

// Summary mode (issue #3678) — collapse every array and every large entity-keyed
// object inside `data` to a count + small sample, leaving scalars and small typed
// payload objects intact. Applied AFTER `_postFilter` so it composes with the
// per-tool filters: `country: "DE", summary: true` returns counts + samples for
// DE specifically. Single-level summarisation is intentional — enough to convey
// shape/size, cheap to compute, predictable output.
const SUMMARY_SAMPLE_SIZE = 3;
const SUMMARY_MAP_THRESHOLD = 5; // an inner object with >5 keys is treated as an entity map

function summarizeMap(obj: Record<string, unknown>): { count: number; sample_keys: string[] } {
  const keys = Object.keys(obj);
  return { count: keys.length, sample_keys: keys.slice(0, SUMMARY_SAMPLE_SIZE) };
}

function summarizeField(v: unknown): unknown {
  if (Array.isArray(v)) return { count: v.length, sample: v.slice(0, SUMMARY_SAMPLE_SIZE) };
  if (v && typeof v === 'object') {
    const inner = Object.keys(v as Record<string, unknown>);
    if (inner.length > SUMMARY_MAP_THRESHOLD) return summarizeMap(v as Record<string, unknown>);
  }
  return v;
}

export function summarizeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [label, payload] of Object.entries(data)) {
    if (Array.isArray(payload)) {
      out[label] = { count: payload.length, sample: payload.slice(0, SUMMARY_SAMPLE_SIZE) };
    } else if (payload && typeof payload === 'object') {
      const keys = Object.keys(payload as Record<string, unknown>);
      const allObjValues = keys.length > 0 && keys.every((k) => {
        const v = (payload as Record<string, unknown>)[k];
        return v != null && typeof v === 'object';
      });
      if (keys.length > SUMMARY_MAP_THRESHOLD && allObjValues) {
        // Entity-keyed map at the top level (e.g. data._all = { US: {...}, ... }).
        out[label] = summarizeMap(payload as Record<string, unknown>);
      } else {
        // Typed payload object — recurse one level into its fields.
        const recursed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
          recursed[k] = summarizeField(v);
        }
        out[label] = recursed;
      }
    } else {
      out[label] = payload;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// outputSchema authoring helpers (v1.6.0)
// ---------------------------------------------------------------------------
// Every cache tool returns a uniform envelope from `executeTool`:
//
//   { cached_at: string|null, stale: boolean, data: { [label]: ... } }
//
// where each `label` is derived from one of the tool's `_cacheKeys` via the
// NON_LABEL regex in executeTool. `cacheEnvelope(dataProps)` returns the spec
// outputSchema for that envelope so the per-tool declarations stay readable
// and consistent (the load-bearing per-tool detail is the `data.properties`
// dictionary — everything else is uniform).
//
// Schema authorship rules:
//   - Source of truth is the tool's `_execute` / cache-key contract, NOT a
//     single captured fixture (an inferred schema would freeze every observed
//     enum value + required flag forever and reject valid future responses).
//   - Only the envelope (`cached_at`, `stale`, `data`) is `required`. The
//     per-label `data` properties are intentionally NOT required because any
//     single cache key may be transiently null without tripping the
//     `cache_all_null` guard (which fires only when ALL keys are null).
//   - `additionalProperties` is left implicit (true) so forward-compat fields
//     added to a payload by a producer don't suddenly fail validation.
//   - Per-array `items.properties` lists known top-level fields with types but
//     does NOT enumerate every observed key — this is the LLM's hint surface
//     for JMESPath, not an exhaustive bytecode-level contract.
export function cacheEnvelope(dataProperties: Record<string, object>): object {
  return {
    type: 'object',
    required: ['cached_at', 'stale', 'data'],
    properties: {
      cached_at: {
        type: ['string', 'null'],
        description: 'ISO-8601 timestamp of the OLDEST contributing cache key, or null when no valid seed-meta is present.',
      },
      stale: {
        type: 'boolean',
        description: 'True when any contributing cache key is older than its per-key maxStaleMin freshness budget.',
      },
      data: { type: 'object', properties: dataProperties },
    },
  };
}
