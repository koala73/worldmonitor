// Minimal JSON-Schema-subset validator shared by
// `tests/mcp-output-schema-coverage.test.mjs` (captured-fixture parity) and
// `tests/mcp-tool-output-contracts.test.mjs` (per-tool envelope-shape
// dispatch). Both call sites describe their schemas with the same
// constrained vocabulary the MCP TOOL_REGISTRY uses: `type` (string or
// string[]), `properties`, `items`, `required`, `additionalProperties`,
// `enum`. Adding `ajv` to test dependencies was explicitly avoided in the
// PR that introduced `outputSchema` because the vocabulary here is stable
// and a 50-LOC validator covers every key the registry actually emits;
// the same reasoning applies to the second consumer.
//
// Returns an array of error strings (empty = valid). Each error names the
// JSON path where validation failed so a failing assertion immediately
// points at the offending field.

function typeMatches(schemaType, value) {
  const list = Array.isArray(schemaType) ? schemaType : [schemaType];
  for (const t of list) {
    if (t === 'null' && value === null) return true;
    if (t === 'string' && typeof value === 'string') return true;
    if (t === 'number' && typeof value === 'number') return true;
    if (t === 'integer' && Number.isInteger(value)) return true;
    if (t === 'boolean' && typeof value === 'boolean') return true;
    if (t === 'array' && Array.isArray(value)) return true;
    if (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) return true;
  }
  return false;
}

export function validate(schema, value, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : typeof value}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (value === null || value === undefined) return errors;
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validate(schema.items, value[i], `${path}[${i}]`));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path}.${key}: required key missing`);
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in value) errors.push(...validate(subSchema, value[key], `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, val] of Object.entries(value)) {
        if (known.has(key)) continue;
        errors.push(...validate(schema.additionalProperties, val, `${path}.${key}`));
      }
    }
  }
  return errors;
}
