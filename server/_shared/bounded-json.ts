// Size-bounded JSON serialization for caller-shaped values.
//
// A JMESPath projection can return a value whose nodes are shared references
// (multiselect and pipe stages reuse the same sub-object), so a tiny result
// graph can serialize to an exponentially large string. Checking the byte cap
// after `JSON.stringify` is too late: the expansion has already cost the CPU and
// memory. `stringifyWithinBudget` serializes in a single pass with a running
// character budget and gives up as soon as the output would exceed it, so the
// work is bounded by the cap rather than by the expanded size. Each `toJSON` is
// called once and its result is what gets written, so a value cannot pass the
// budget and then serialize to something larger.

export type BoundedStringifyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large'; minBytes: number };
// `minBytes` is a lower bound on the serialized size when serialization stopped
// early, or the exact UTF-8 size when the full string was built.

class BudgetExceeded extends Error {}

class BoundedWriter {
  parts: string[] = [];
  length = 0;
  constructor(readonly budget: number) {}

  // `length` is UTF-16 code units, a lower bound on UTF-8 bytes.
  write(text: string): void {
    this.length += text.length;
    if (this.length > this.budget) throw new BudgetExceeded();
    this.parts.push(text);
  }

  mark(): [number, number] {
    return [this.parts.length, this.length];
  }

  rollback([parts, length]: [number, number]): void {
    this.parts.length = parts;
    this.length = length;
  }
}

// Mirrors JSON.stringify's SerializeJSONProperty for one holder[key] value.
// Returns false when the value is omitted (undefined, function, symbol).
function writeValue(out: BoundedWriter, key: string, input: unknown, ancestors: Set<object>): boolean {
  let value = input;
  if (value !== null && (typeof value === 'object' || typeof value === 'bigint')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, key);
  }
  if (value instanceof Number) value = Number(value);
  else if (value instanceof String) value = String(value);
  else if (value instanceof Boolean) value = value.valueOf();

  if (value === null) {
    out.write('null');
    return true;
  }
  switch (typeof value) {
    case 'string':
      // Lower bound first so a huge string is never re-encoded.
      if (out.length + value.length + 2 > out.budget) {
        out.length += value.length + 2;
        throw new BudgetExceeded();
      }
      out.write(JSON.stringify(value));
      return true;
    case 'number':
      out.write(Number.isFinite(value) ? String(value) : 'null');
      return true;
    case 'boolean':
      out.write(value ? 'true' : 'false');
      return true;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'undefined':
    case 'function':
    case 'symbol':
      return false;
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError('Converting circular structure to JSON');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      out.write('[');
      for (let i = 0; i < object.length; i += 1) {
        if (i > 0) out.write(',');
        if (!writeValue(out, String(i), object[i], ancestors)) out.write('null');
      }
      out.write(']');
      return true;
    }
    const record = object as Record<string, unknown>;
    out.write('{');
    let first = true;
    for (const name of Object.keys(record)) {
      // The key is written before the value; an omitted value rolls it back.
      const before = out.mark();
      out.write(`${first ? '' : ','}${JSON.stringify(name)}:`);
      if (writeValue(out, name, record[name], ancestors)) first = false;
      else out.rollback(before);
    }
    out.write('}');
    return true;
  } finally {
    ancestors.delete(object);
  }
}

export function stringifyWithinBudget(value: unknown, maxBytes: number): BoundedStringifyResult {
  const out = new BoundedWriter(maxBytes);
  try {
    if (!writeValue(out, '', value, new Set())) return { ok: true, text: 'null' };
  } catch (err) {
    if (err instanceof BudgetExceeded) return { ok: false, reason: 'too_large', minBytes: out.length };
    throw err;
  }
  // The budget counted UTF-16 code units, so the UTF-8 size can still be up to
  // 3x the cap; the string is already bounded, so check the exact bytes.
  const text = out.parts.join('');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) return { ok: false, reason: 'too_large', minBytes: bytes };
  return { ok: true, text };
}
