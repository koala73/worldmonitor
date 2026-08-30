/**
 * Hoist duplicated non-2xx response objects into components.responses $refs.
 *
 * Why: the per-op error-response docs (429 rate-limit blocks, 400/401/403/
 * default envelopes) are stamped verbatim onto every operation by the
 * generator + injectors. On a 193-op spec that repetition alone is ~227 KB of
 * the minified public/openapi.json — which pushed the artifact from ~752 KB
 * past the ~1 MB body cap some agent-readiness scanners impose (ora.ai/orank's
 * function-calling check flipped from PASS to "API spec found but couldn't
 * validate function calling compatibility" the day the spec crossed the cap;
 * elevenlabs' 1.8 MB and openrouter's 1.5 MB specs fail the same check the
 * same way, while sub-800 KB specs get computed verdicts).
 *
 * $ref-ing a repeated Response Object is semantically identical OpenAPI 3.1 —
 * no information is lost, every mainstream toolchain resolves document-local
 * refs. Constraints honoured here:
 *   - 2xx responses are NEVER hoisted: orank's response checks credit only the
 *     inline `responses['200']` schema (verified 2026-07-05; see
 *     tests/openapi-json-dedup.test.mjs).
 *   - Only bodies that repeat (count >= 2) are hoisted; unique responses stay
 *     inline.
 *   - Component names are deterministic (status code + first-seen ordinal) so
 *     rebuilds are byte-stable for identical input.
 *
 * Names are the compact `E<status>` form rather than the reason phrase, because
 * the name is paid for at every REF, not once at the definition. The reason
 * phrases cost 12-14 bytes more each across 1293 refs — ~11.3 KB, or 1.2% of
 * the whole artifact — to restate information the adjacent status key already
 * carries (`"503": { "$ref": ".../E503" }` reads no worse than `.../ServiceUnavailable`).
 * That mattered the day the billing-verification 503 landed on 206 authenticated
 * operations: the spec was 936 KB of a 950 KB budget, and 12 KB of new refs put
 * it 497 bytes over. Compact names bought the headroom back without dropping a
 * single documented response.
 *
 * This runs ONLY when emitting public/openapi.json (build-openapi-json.mjs).
 * The YAML sources under docs/api/ keep their inline copies for Mintlify and
 * the contract tests.
 */

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const STATUS_NAMES = {
  400: 'E400',
  401: 'E401',
  402: 'E402',
  403: 'E403',
  404: 'E404',
  405: 'E405',
  409: 'E409',
  410: 'E410',
  412: 'E412',
  415: 'E415',
  422: 'E422',
  429: 'E429',
  500: 'E500',
  503: 'E503',
  default: 'EDEF',
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function componentName(statusCode) {
  // Unmapped statuses follow the same compact shape rather than the longer
  // `Response<code>`, so adding a status to STATUS_NAMES never changes the
  // artifact's size profile — only its readability.
  return STATUS_NAMES[statusCode] ?? `E${statusCode.replace(/[^A-Za-z0-9]/g, '')}`;
}

/**
 * Mutates `spec` in place; returns { hoisted, replacedRefs } stats.
 */
export function dedupeErrorResponses(spec) {
  const stats = { hoisted: 0, replacedRefs: 0 };
  if (!spec || typeof spec !== 'object' || !spec.paths) return stats;

  // First pass: count identical non-2xx response bodies across all operations.
  const groups = new Map(); // canonical body -> { statusCode, count, body }
  const sites = []; // { responses, statusCode, key: canonical }
  for (const pathItem of Object.values(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !op?.responses) continue;
      for (const [statusCode, response] of Object.entries(op.responses)) {
        if (/^2/.test(statusCode)) continue; // 2xx must stay inline (scanner-credited)
        if (!response || typeof response !== 'object' || response.$ref) continue;
        const key = `${statusCode}${canonical(response)}`;
        const group = groups.get(key);
        if (group) group.count += 1;
        else groups.set(key, { statusCode, count: 1, body: response });
        sites.push({ responses: op.responses, statusCode, key });
      }
    }
  }

  // Assign deterministic names to groups worth hoisting, in first-seen order.
  const existing = spec.components?.responses ?? {};
  const nameFor = new Map(); // canonical key -> component name
  const perStatusOrdinal = new Map(); // base name -> next ordinal
  for (const [key, group] of groups) {
    if (group.count < 2) continue;
    const base = componentName(group.statusCode);
    let ordinal = perStatusOrdinal.get(base) ?? 0;
    let name;
    do {
      ordinal += 1;
      // `_` before the ordinal: bare concatenation reads as a different status
      // under the compact naming above (`E429` + `2` -> `E4292`, which looks
      // like status 4292). One byte per ref on the handful of statuses that
      // carry more than one distinct body, against a name that stays legible.
      name = ordinal === 1 ? base : `${base}_${ordinal}`;
    } while (Object.hasOwn(existing, name) || [...nameFor.values()].includes(name));
    perStatusOrdinal.set(base, ordinal);
    nameFor.set(key, name);
  }
  if (nameFor.size === 0) return stats;

  // Second pass: install components and swap sites for $refs.
  spec.components ??= {};
  spec.components.responses ??= {};
  for (const [key, name] of nameFor) {
    spec.components.responses[name] = groups.get(key).body;
    stats.hoisted += 1;
  }
  for (const site of sites) {
    const name = nameFor.get(site.key);
    if (!name) continue;
    site.responses[site.statusCode] = { $ref: `#/components/responses/${name}` };
    stats.replacedRefs += 1;
  }
  return stats;
}

/**
 * Injector-stamped parameters repeat verbatim on (nearly) every operation —
 * `jmespath` alone is ~514 bytes × 200+ ops, ~100 KB of the minified
 * artifact. The high threshold keeps this pass surgical: only parameters
 * stamped fleet-wide by an injector qualify, while per-op params (whose
 * descriptions legitimately differ) always stay inline. Path params stay
 * inline. Repeated query/header params hoist into `$ref`s; `ensureInlineTypedInput`
 * then copies one Parameter Object back inline on operations that would
 * otherwise have only `$ref`s, so JSON-only scanners that skip parameter `$ref`s
 * still see typed input.
 */
// Lowered 10 -> 2 when the food-stocks operation (#6440) put the artifact 2.5 KB
// over the 950 KB budget that main was already sitting only 1.7 KB under.
// Raising the budget is explicitly not an option (tests/openapi-json-dedup.test.mjs),
// and slimming the newest operation would have meant deleting documentation
// rather than repetition — the operation contributes 4.1 KB and the whole
// overage is structural, not specific to it.
//
// 2 rather than some middle value, for two reasons:
//   - It matches the policy dedupeErrorResponses already applies one function
//     up ("Only bodies that repeat (count >= 2) are hoisted"). Two passes over
//     the same artifact using different repeat thresholds was the accident.
//   - Headroom. At 4 the artifact lands 1.2 KB under budget — tighter than what
//     main had, so the next operation to land would hit this same wall. At 2 it
//     lands ~4.2 KB under.
//
// This stays safe because the grouping key is the CANONICAL parameter object:
// only byte-identical definitions collapse, so a parameter whose description
// legitimately differs per operation never groups with another. Path params are
// still skipped. `ensureInlineTypedInput` then copies one Parameter Object
// back inline on operations whose remaining inputs would otherwise all be `$ref`s.
const PARAM_HOIST_MIN_COUNT = 2;

/**
 * Hoist identical query/header parameter objects into components.parameters
 * $refs. Mutates `spec` in place; returns { hoisted, replacedRefs } stats.
 */
export function dedupeSharedParameters(spec) {
  const stats = { hoisted: 0, replacedRefs: 0 };
  if (!spec || typeof spec !== 'object' || !spec.paths) return stats;

  const groups = new Map(); // canonical param -> { count, body, name }
  const sites = []; // { parameters, index, key }
  for (const pathItem of Object.values(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !Array.isArray(op?.parameters)) continue;
      op.parameters.forEach((param, index) => {
        if (!param || typeof param !== 'object' || param.$ref) return;
        if (param.in === 'path') return; // path params are structural, keep inline
        const key = canonical(param);
        const group = groups.get(key);
        if (group) group.count += 1;
        else groups.set(key, { count: 1, body: param, name: param.name });
        sites.push({ parameters: op.parameters, index, key });
      });
    }
  }

  const existing = spec.components?.parameters ?? {};
  const nameFor = new Map();
  const perNameOrdinal = new Map();
  for (const [key, group] of groups) {
    if (group.count < PARAM_HOIST_MIN_COUNT) continue;
    const cleaned = String(group.name ?? '').replace(/[^A-Za-z0-9]/g, '');
    const base = `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}Param`;
    let ordinal = perNameOrdinal.get(base) ?? 0;
    let name;
    do {
      ordinal += 1;
      name = ordinal === 1 ? base : `${base}${ordinal}`;
    } while (Object.hasOwn(existing, name) || [...nameFor.values()].includes(name));
    perNameOrdinal.set(base, ordinal);
    nameFor.set(key, name);
  }
  if (nameFor.size === 0) return stats;

  spec.components ??= {};
  spec.components.parameters ??= {};
  for (const [key, name] of nameFor) {
    spec.components.parameters[name] = groups.get(key).body;
    stats.hoisted += 1;
  }
  for (const site of sites) {
    const name = nameFor.get(site.key);
    if (!name) continue;
    site.parameters[site.index] = { $ref: `#/components/parameters/${name}` };
    stats.replacedRefs += 1;
  }
  return stats;
}

function schemaLooksTyped(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) return true;
  }
  if (schema.properties && typeof schema.properties === 'object' && Object.keys(schema.properties).length > 0) {
    return true;
  }
  if (schema.type === 'array') return schemaLooksTyped(schema.items);
  if (Array.isArray(schema.type)) return schema.type.length > 0;
  return typeof schema.type === 'string' && schema.type.length > 0;
}

function parameterIsInlineTyped(param) {
  if (!param || typeof param !== 'object' || param.$ref) return false;
  return schemaLooksTyped(param.schema);
}

function requestBodyIsTyped(operation) {
  const schema = operation?.requestBody?.content?.['application/json']?.schema;
  return schemaLooksTyped(schema);
}

/**
 * JSON-only scanners (ora.ai / orank) fetch `/openapi.json` and often do not
 * follow `components.parameters` `$ref`s. After fleet-wide parameter hoisting,
 * GETs whose only typed input was `jmespath` (or another repeated query param)
 * look untyped and the spec scores as "partially documented".
 *
 * Keep the `$ref`s for operations that already have an inline typed parameter
 * (path params stay inline) or a typed requestBody, and copy the first
 * referenced Parameter Object back inline for the rest. Prefers `JmespathParam`
 * when present because that is the fleet-wide typed-input stamp on GETs.
 *
 * Mutates `spec` in place; returns { inlined }.
 */
export function ensureInlineTypedInput(spec) {
  const stats = { inlined: 0 };
  if (!spec || typeof spec !== 'object' || !spec.paths) return stats;

  const components = spec.components?.parameters ?? {};
  for (const pathItem of Object.values(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== 'object') {
        continue;
      }
      if (requestBodyIsTyped(operation)) continue;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      if (parameters.some(parameterIsInlineTyped)) continue;

      const refIndexes = [];
      parameters.forEach((param, index) => {
        if (param?.$ref && String(param.$ref).startsWith('#/components/parameters/')) {
          refIndexes.push(index);
        }
      });
      if (refIndexes.length === 0) continue;

      const preferred = refIndexes.find((index) => /JmespathParam/.test(String(parameters[index].$ref)));
      const pick = preferred ?? refIndexes[0];
      const name = String(parameters[pick].$ref).replace('#/components/parameters/', '');
      const target = components[name];
      if (!target || typeof target !== 'object') continue;
      parameters[pick] = structuredClone(target);
      stats.inlined += 1;
    }
  }
  return stats;
}
