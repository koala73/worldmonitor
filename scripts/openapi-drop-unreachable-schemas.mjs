/**
 * Drop component schemas that nothing in the document can reach.
 *
 * Why: the sebuf generator emits one component schema per RPC message, but a
 * GET operation spends its request message as `parameters` and never points at
 * the request schema. On the 2026-08-13 bundle that left 210 of 844 schemas —
 * 93,582 bytes, ~10% of the artifact — carried, served, and counted against the
 * ~1 MB scanner body cap while being unreachable from every operation,
 * response, parameter, header and sibling schema. The budget had 3,318 bytes
 * left at the time (#6558); this returns thirty times that.
 *
 * Why this is lossless for the OpenAPI contract: a Schema Object in
 * `components.schemas` is not itself part of any operation's contract — it
 * documents something only through the `$ref` that points at it. A schema with
 * no inbound pointer documents nothing a client, agent or scanner can arrive
 * at. Every operation, request body, response and parameter survives untouched,
 * and `tests/openapi-unreachable-schemas.test.mjs` proves it: no dangling
 * `$ref` remains, every retained schema is byte-identical, and nothing outside
 * `components.schemas` changes.
 *
 * Reachability is transitive and computed from the whole document rather than
 * from operations alone, so a schema referenced only by a hoisted
 * `components.responses` / `components.parameters` entry (the dedup passes
 * create those) survives, as does one reached through a nested JSON pointer
 * such as `#/components/schemas/Foo/properties/bar` — that pointer needs `Foo`.
 *
 * Like the dedup passes, this runs ONLY when emitting `public/openapi.json`
 * (build-openapi-json.mjs). `docs/api/worldmonitor.openapi.yaml` keeps every
 * schema, so Mintlify, the injectors and the contract tests still see the full
 * generated document.
 */

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Component-schema names referenced anywhere inside `node`.
 *
 * Takes the first pointer segment after the prefix, so a pointer *into* a
 * schema (`#/components/schemas/Foo/properties/bar`) counts as a reference to
 * `Foo` — dropping `Foo` would strand it.
 */
export function collectSchemaRefs(node, into = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) collectSchemaRefs(child, into);
    return into;
  }
  if (!node || typeof node !== 'object') return into;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
      into.add(value.slice(SCHEMA_REF_PREFIX.length).split('/')[0]);
      continue;
    }
    collectSchemaRefs(value, into);
  }
  return into;
}

/**
 * Names in `components.schemas` that nothing can reach.
 *
 * @param {object} spec
 * @returns {Set<string>}
 */
export function unreachableSchemaNames(spec) {
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return new Set();

  // Seed from everything that is NOT a component schema: paths, webhooks, and
  // the other component buckets. Seeding from the other buckets unconditionally
  // is the conservative direction — it can only keep a schema alive, never
  // strand one — and it is what makes the pass safe to run after the dedup
  // passes have hoisted responses and parameters out of the operations.
  const seeds = new Set();
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'components') continue;
    collectSchemaRefs(value, seeds);
  }
  for (const [bucket, value] of Object.entries(spec.components)) {
    if (bucket === 'schemas') continue;
    collectSchemaRefs(value, seeds);
  }

  const reachable = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop();
    // A pointer at a name that does not exist is a pre-existing dangling ref,
    // not something this pass created; ignore it rather than inventing an entry.
    if (reachable.has(name) || !Object.hasOwn(schemas, name)) continue;
    reachable.add(name);
    for (const nested of collectSchemaRefs(schemas[name])) {
      if (!reachable.has(nested)) queue.push(nested);
    }
  }

  return new Set(Object.keys(schemas).filter((name) => !reachable.has(name)));
}

/**
 * Remove unreachable component schemas. Mutates `spec` in place.
 *
 * `bytesFreed` is measured, not summed from the parts: it is the difference
 * between the serialized document before and after, so key separators and the
 * name keys themselves are all accounted for.
 *
 * @param {object} spec
 * @returns {{ dropped: number, bytesFreed: number, names: string[] }}
 */
export function dropUnreachableSchemas(spec) {
  const names = [...unreachableSchemaNames(spec)];
  if (names.length === 0) return { dropped: 0, bytesFreed: 0, names: [] };

  const before = Buffer.byteLength(JSON.stringify(spec), 'utf8');
  for (const name of names) delete spec.components.schemas[name];
  if (Object.keys(spec.components.schemas).length === 0) delete spec.components.schemas;
  const after = Buffer.byteLength(JSON.stringify(spec), 'utf8');

  return { dropped: names.length, bytesFreed: before - after, names };
}
