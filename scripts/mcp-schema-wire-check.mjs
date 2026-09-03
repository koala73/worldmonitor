const JSON_SCHEMA_TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'string',
  'integer',
]);

function isNonemptyObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function describePath(toolName, schemaName, path) {
  return `${toolName}.${schemaName}${path}`;
}

function collectTypeFailures(value, location, failures) {
  if (typeof value === 'string') {
    if (!JSON_SCHEMA_TYPES.has(value)) {
      failures.push(`${location}: invalid JSON Schema type ${JSON.stringify(value)}`);
    }
    return;
  }

  if (!Array.isArray(value)) {
    failures.push(`${location}: type must be a JSON Schema type string or non-empty unique array`);
    return;
  }

  if (value.length === 0) {
    failures.push(`${location}: type array must not be empty`);
    return;
  }

  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const member = value[index];
    if (typeof member !== 'string') {
      failures.push(`${location}[${index}]: invalid JSON Schema type ${JSON.stringify(member)}`);
      continue;
    }
    if (seen.has(member)) {
      failures.push(`${location}[${index}]: duplicate JSON Schema type ${JSON.stringify(member)}`);
    } else {
      seen.add(member);
    }
    if (!JSON_SCHEMA_TYPES.has(member)) {
      failures.push(`${location}[${index}]: invalid JSON Schema type ${JSON.stringify(member)}`);
    }
  }
}

function collectValueFailures(value, location, failures) {
  if (value === '[truncated]') {
    failures.push(`${location}: contains the forbidden [truncated] wire sentinel`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectValueFailures(value[index], `${location}[${index}]`, failures);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value)) {
    const nestedLocation = `${location}.${key}`;
    if (key === 'type') {
      collectTypeFailures(nested, nestedLocation, failures);
    } else {
      collectValueFailures(nested, nestedLocation, failures);
    }
  }
}

/**
 * Return every schema defect that can make a strict MCP client reject the
 * tools/list response. This stays dependency-free so the production smoke can
 * run from a clean checkout without npm install.
 */
export function collectToolSchemaWireFailures(tools) {
  const failures = [];
  if (!Array.isArray(tools)) return ['tools.$: expected a tools array'];

  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    const toolName = typeof tool?.name === 'string' && tool.name
      ? tool.name
      : `<tool-${index}>`;
    for (const schemaName of ['inputSchema', 'outputSchema']) {
      const schema = tool?.[schemaName];
      const location = describePath(toolName, schemaName, '');
      if (!isNonemptyObject(schema)) {
        failures.push(`${location} at $: expected a non-empty schema object`);
        continue;
      }
      collectValueFailures(schema, location, failures);
    }
  }
  return failures;
}
