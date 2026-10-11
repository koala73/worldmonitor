// Size-bounded JSON serialization for caller-shaped values.
//
// A JMESPath projection can return a value whose nodes are shared references
// (multiselect and pipe stages reuse the same sub-object), so a tiny result
// graph can serialize to an exponentially large string. Checking the byte cap
// after `JSON.stringify` is too late: the expansion has already cost the CPU and
// memory. `stringifyWithinBudget` walks the value first with a running character
// budget and gives up as soon as the serialized form would exceed it, so the
// walk itself is bounded by the cap rather than by the expanded size.

export type BoundedStringifyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large'; minBytes: number };
// `minBytes` is a lower bound on the serialized size when the walk stopped
// early, or the exact UTF-8 size when the full string was built.

// Returns the serialized length (UTF-16 code units, a lower bound on UTF-8
// bytes), stopping early with a partial count above `budget` once the budget is
// exceeded. Mirrors JSON.stringify for the plain JSON values that JSON.parse
// and jmespath produce.
function measure(value: unknown, budget: number, used: number, inArray: boolean): number {
  if (used > budget) return used;
  if (value === null) return used + 4;
  switch (typeof value) {
    case 'string':
      // Fast lower bound first so a huge string never gets re-encoded.
      if (used + value.length + 2 > budget) return used + value.length + 2;
      return used + JSON.stringify(value).length;
    case 'number':
      return used + (Number.isFinite(value) ? String(value).length : 4);
    case 'boolean':
      return used + (value ? 4 : 5);
    case 'undefined':
    case 'function':
    case 'symbol':
      // Omitted from objects by the caller; serialized as null inside arrays.
      return inArray ? used + 4 : used;
    case 'bigint':
      // JSON.stringify throws on bigint; let the real serializer surface it.
      return used;
    default:
      break;
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    // Mirror JSON.stringify: measure what toJSON returns, still within budget.
    return measure(toJSON.call(value), budget, used, inArray);
  }
  if (Array.isArray(value)) {
    used += 2;
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) used += 1;
      used = measure(value[i], budget, used, true);
      if (used > budget) return used;
    }
    return used;
  }
  const record = value as Record<string, unknown>;
  used += 2;
  let first = true;
  for (const key of Object.keys(record)) {
    const child = record[key];
    const t = typeof child;
    if (t === 'undefined' || t === 'function' || t === 'symbol') continue;
    if (!first) used += 1;
    first = false;
    used += JSON.stringify(key).length + 1;
    used = measure(child, budget, used, false);
    if (used > budget) return used;
  }
  return used;
}

export function stringifyWithinBudget(value: unknown, maxBytes: number): BoundedStringifyResult {
  const measured = measure(value, maxBytes, 0, false);
  if (measured > maxBytes) return { ok: false, reason: 'too_large', minBytes: measured };
  // The walk counted UTF-16 code units, so the real UTF-8 size can still be up
  // to 3x the cap; build the string (now bounded) and check the exact bytes.
  const text = JSON.stringify(value) ?? 'null';
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) return { ok: false, reason: 'too_large', minBytes: bytes };
  return { ok: true, text };
}
