import Ajv2020 from 'ajv/dist/2020.js';

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
    if (value !== '[truncated]' && !JSON_SCHEMA_TYPES.has(value)) {
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
    if (member !== '[truncated]' && !JSON_SCHEMA_TYPES.has(member)) {
      failures.push(`${location}[${index}]: invalid JSON Schema type ${JSON.stringify(member)}`);
    }
  }
}

function collectSentinelFailures(value, location, failures) {
  const stack = [{ value, location }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.value === '[truncated]') {
      failures.push(`${current.location}: contains the forbidden [truncated] wire sentinel`);
    } else if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], location: `${current.location}[${index}]` });
      }
    } else if (current.value !== null && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index];
        stack.push({ value: nested, location: `${current.location}.${key}` });
      }
    }
  }
}

const SCHEMA_MAP_KEYWORDS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
  'patternProperties',
  'properties',
];
const SCHEMA_VALUE_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

const schemaCompiler = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  strictRequired: false,
  validateFormats: false,
});

function collectSchemaCompilationFailure(schema, location, failures) {
  try {
    schemaCompiler.compile(schema);
  } catch (error) {
    failures.push(`${location} at $: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    schemaCompiler.removeSchema(schema);
  }
}

function collectSchemaTypeFailures(rootSchema, rootLocation, failures) {
  const stack = [{ schema: rootSchema, location: rootLocation }];
  const pushSchema = (schema, location) => {
    if (schema === true || schema === false) return;
    if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
      stack.push({ schema, location });
    }
  };
  const pushSchemaValue = (schema, location) => {
    if (Array.isArray(schema)) {
      for (let index = schema.length - 1; index >= 0; index -= 1) {
        pushSchema(schema[index], `${location}[${index}]`);
      }
    } else {
      pushSchema(schema, location);
    }
  };

  while (stack.length > 0) {
    const { schema, location } = stack.pop();
    if (Object.prototype.hasOwnProperty.call(schema, 'type')) {
      collectTypeFailures(schema.type, `${location}.type`, failures);
    }

    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const schemas = schema[keyword];
      if (schemas === null || typeof schemas !== 'object' || Array.isArray(schemas)) continue;
      for (const [name, childSchema] of Object.entries(schemas)) {
        pushSchema(childSchema, `${location}.${keyword}.${name}`);
      }
    }
    for (const keyword of SCHEMA_VALUE_KEYWORDS) {
      pushSchemaValue(schema[keyword], `${location}.${keyword}`);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const schemas = schema[keyword];
      if (!Array.isArray(schemas)) continue;
      for (let index = schemas.length - 1; index >= 0; index -= 1) {
        pushSchema(schemas[index], `${location}.${keyword}[${index}]`);
      }
    }
  }
}

export function collectRequiredCapabilityFailures(capabilities) {
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)
    || !Object.prototype.hasOwnProperty.call(capabilities, 'tools')) {
    return ['initialize.capabilities.tools: required capability is missing'];
  }
  if (capabilities.tools === null || typeof capabilities.tools !== 'object'
    || Array.isArray(capabilities.tools)) {
    return ['initialize.capabilities.tools: capability must be an object'];
  }
  return [];
}

/**
 * Return schema defects that can make a strict MCP client reject the tools/list
 * response. Focused checks identify wire corruption; AJV compiles the complete
 * schema with the same settings as the first-party catalog test
 * (tests/mcp-output-schema-coverage.test.mjs).
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
      const schemaFailures = [];
      collectSentinelFailures(schema, location, schemaFailures);
      collectSchemaTypeFailures(schema, location, schemaFailures);
      if (schemaFailures.length === 0) {
        collectSchemaCompilationFailure(schema, location, schemaFailures);
      }
      failures.push(...schemaFailures);
    }
  }
  return failures;
}
