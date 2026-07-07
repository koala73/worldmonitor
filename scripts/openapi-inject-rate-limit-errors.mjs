#!/usr/bin/env node
/**
 * Inject gateway-level rate-limit and error-envelope contracts into OpenAPI.
 *
 * protoc-gen-openapiv3 only sees proto handler shapes, but WorldMonitor's REST
 * gateway can reject any operation before a handler runs: origin/auth routing,
 * 404/405 dispatch, global/per-endpoint/per-account rate limits, and malformed
 * JSON body parsing. This post-generation pass documents those gateway-level
 * contracts once, across every generated artifact, instead of hand-editing
 * individual endpoints. Idempotent and byte-faithful for JSON; YAML uses
 * formatting-preserving surgical replacement like the sibling injectors.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = process.env.WM_OPENAPI_API_DIR
  ? resolve(process.env.WM_OPENAPI_API_DIR)
  : resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

const RATE_LIMIT_ERROR_SCHEMA = {
  type: 'object',
  description: 'Returned when a gateway or handler rate limit rejects the request.',
  properties: {
    error: {
      type: 'string',
      description: 'Human-readable rate-limit failure reason.',
    },
  },
  required: ['error'],
};

const GATEWAY_ERROR_SCHEMA = {
  type: 'object',
  description:
    'Returned by gateway infrastructure errors before an RPC handler runs, such as origin, routing, method, authentication, or quota checks.',
  properties: {
    error: {
      oneOf: [
        { type: 'string' },
        { type: 'object', additionalProperties: true },
      ],
      description: 'Gateway error reason or structured gateway failure details.',
    },
  },
  required: ['error'],
};

const INVALID_REQUEST_BODY_SCHEMA = {
  type: 'object',
  description: 'Returned when a JSON POST request body is empty or malformed.',
  properties: {
    message: {
      type: 'string',
      description: 'Invalid request body',
    },
  },
  required: ['message'],
};

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': {
    description: 'Maximum requests allowed in the active rate-limit window.',
    schema: { type: 'string' },
  },
  'X-RateLimit-Remaining': {
    description: 'Requests remaining in the active rate-limit window.',
    schema: { type: 'string' },
  },
  'X-RateLimit-Reset': {
    description: 'Unix epoch milliseconds when the active rate-limit window resets.',
    schema: { type: 'string' },
  },
  'Retry-After': {
    description: 'Seconds to wait before retrying the request.',
    schema: { type: 'string' },
  },
};

const RATE_LIMIT_RESPONSE = {
  description: 'Rate limit exceeded.',
  headers: RATE_LIMIT_HEADERS,
  content: {
    'application/json': {
      schema: {
        oneOf: [
          { $ref: '#/components/schemas/Error' },
          { $ref: '#/components/schemas/RateLimitError' },
        ],
      },
    },
  },
};

const DEFAULT_ERROR_RESPONSE = {
  description: 'Gateway or handler error response.',
  content: {
    'application/json': {
      schema: {
        oneOf: [
          { $ref: '#/components/schemas/Error' },
          { $ref: '#/components/schemas/GatewayError' },
        ],
      },
    },
  },
};

const POST_400_DESCRIPTION = 'Validation error, invalid Idempotency-Key header, or malformed JSON request body';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function schemaIncludesRef(schema, ref) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref === ref) return true;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key]) && schema[key].some((item) => schemaIncludesRef(item, ref))) return true;
  }
  return false;
}

function ensureJsonSchemas(spec) {
  let changed = false;
  spec.components ||= {};
  spec.components.schemas ||= {};
  const expected = {
    RateLimitError: RATE_LIMIT_ERROR_SCHEMA,
    GatewayError: GATEWAY_ERROR_SCHEMA,
    InvalidRequestBodyError: INVALID_REQUEST_BODY_SCHEMA,
  };
  for (const [name, schema] of Object.entries(expected)) {
    if (!eq(spec.components.schemas[name], schema)) {
      spec.components.schemas[name] = clone(schema);
      changed = true;
    }
  }
  return changed;
}

function ensureInvalidRequestBody400(op) {
  op.responses ||= {};
  const had400 = Boolean(op.responses['400']);
  const response = op.responses['400'] ?? {
    description: POST_400_DESCRIPTION,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/InvalidRequestBodyError' } } },
  };
  let changed = false;
  if (response.description !== POST_400_DESCRIPTION) {
    response.description = POST_400_DESCRIPTION;
    changed = true;
  }
  response.content ||= {};
  response.content['application/json'] ||= {};
  const existing = response.content['application/json'].schema;
  if (schemaIncludesRef(existing, '#/components/schemas/InvalidRequestBodyError')) {
    op.responses['400'] = response;
    return changed || !had400;
  }
  const nextSchema = existing?.oneOf && Array.isArray(existing.oneOf)
    ? { ...existing, oneOf: [...existing.oneOf, { $ref: '#/components/schemas/InvalidRequestBodyError' }] }
    : existing
      ? { oneOf: [existing, { $ref: '#/components/schemas/InvalidRequestBodyError' }] }
      : { $ref: '#/components/schemas/InvalidRequestBodyError' };
  response.content['application/json'].schema = nextSchema;
  op.responses['400'] = response;
  return true;
}

function injectJson(spec) {
  let changed = ensureJsonSchemas(spec);
  for (const ops of Object.values(spec.paths ?? {})) {
    if (!ops || typeof ops !== 'object') continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      op.responses ||= {};
      if (!eq(op.responses['429'], RATE_LIMIT_RESPONSE)) {
        op.responses['429'] = clone(RATE_LIMIT_RESPONSE);
        changed = true;
      }
      if (!eq(op.responses.default, DEFAULT_ERROR_RESPONSE)) {
        op.responses.default = clone(DEFAULT_ERROR_RESPONSE);
        changed = true;
      }
      if (method === 'post' && ensureInvalidRequestBody400(op)) {
        changed = true;
      }
    }
  }
  return changed;
}

const YAML_RATE_LIMIT_SCHEMA = [
  '        RateLimitError:',
  '            type: object',
  '            description: Returned when a gateway or handler rate limit rejects the request.',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable rate-limit failure reason.',
  '            required:',
  '                - error',
];

const YAML_GATEWAY_ERROR_SCHEMA = [
  '        GatewayError:',
  '            type: object',
  '            description: Returned by gateway infrastructure errors before an RPC handler runs, such as origin, routing, method, authentication, or quota checks.',
  '            properties:',
  '                error:',
  '                    oneOf:',
  '                        - type: string',
  '                        - type: object',
  '                          additionalProperties: true',
  '                    description: Gateway error reason or structured gateway failure details.',
  '            required:',
  '                - error',
];

const YAML_INVALID_REQUEST_BODY_SCHEMA = [
  '        InvalidRequestBodyError:',
  '            type: object',
  '            description: Returned when a JSON POST request body is empty or malformed.',
  '            properties:',
  '                message:',
  '                    type: string',
  '                    description: Invalid request body',
  '            required:',
  '                - message',
];

const YAML_429_RESPONSE = [
  '                "429":',
  '                    description: Rate limit exceeded.',
  '                    headers:',
  '                        X-RateLimit-Limit:',
  '                            description: Maximum requests allowed in the active rate-limit window.',
  '                            schema:',
  '                                type: string',
  '                        X-RateLimit-Remaining:',
  '                            description: Requests remaining in the active rate-limit window.',
  '                            schema:',
  '                                type: string',
  '                        X-RateLimit-Reset:',
  '                            description: Unix epoch milliseconds when the active rate-limit window resets.',
  '                            schema:',
  '                                type: string',
  '                        Retry-After:',
  '                            description: Seconds to wait before retrying the request.',
  '                            schema:',
  '                                type: string',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                oneOf:',
  "                                    - $ref: '#/components/schemas/Error'",
  "                                    - $ref: '#/components/schemas/RateLimitError'",
];

const YAML_DEFAULT_RESPONSE = [
  '                default:',
  '                    description: Gateway or handler error response.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                oneOf:',
  "                                    - $ref: '#/components/schemas/Error'",
  "                                    - $ref: '#/components/schemas/GatewayError'",
];

const YAML_POST_400_RESPONSE = [
  '                "400":',
  '                    description: Validation error, invalid Idempotency-Key header, or malformed JSON request body',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                oneOf:',
  "                                    - $ref: '#/components/schemas/ValidationError'",
  '                                    - type: object',
  '                                      required:',
  '                                        - error',
  '                                        - message',
  '                                      properties:',
  '                                        error:',
  '                                            type: string',
  '                                        message:',
  '                                            type: string',
  "                                    - $ref: '#/components/schemas/InvalidRequestBodyError'",
];

const YAML_METHOD_LINE_RE = /^        (get|post|put|delete|patch|options|head):$/;

function findYamlSchemaRange(lines, schemaName) {
  const start = lines.indexOf(`        ${schemaName}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && /^ {8}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('            ')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function ensureYamlSchema(lines, name, block) {
  const existing = findYamlSchemaRange(lines, name);
  const expected = block.join('\n');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...block);
    return true;
  }
  const schemasIndex = lines.indexOf('    schemas:');
  if (schemasIndex === -1) throw new Error('yaml: could not find components.schemas block');
  const errorIndex = lines.findIndex((line, index) => index > schemasIndex && line === '        Error:');
  let insertAt = errorIndex === -1 ? schemasIndex + 1 : errorIndex + 1;
  if (errorIndex !== -1) {
    while (insertAt < lines.length) {
      const line = lines[insertAt];
      if (line && /^ {8}[^ ].*:/.test(line)) break;
      if (line && !line.startsWith('            ')) break;
      insertAt++;
    }
  }
  lines.splice(insertAt, 0, ...block);
  return true;
}

function findYamlPathRange(lines, path) {
  const start = lines.indexOf(`    ${path}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && !line.startsWith('        ')) break;
    end++;
  }
  return { start, end };
}

function findYamlOperationRange(lines, path, method) {
  const range = findYamlPathRange(lines, path);
  if (!range) return null;
  const start = lines.findIndex((line, index) => (
    index > range.start && index < range.end && line === `        ${method}:`
  ));
  if (start === -1) return null;
  let end = range.end;
  for (let i = start + 1; i < range.end; i++) {
    if (YAML_METHOD_LINE_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function enumerateYamlOperations(lines) {
  const operations = [];
  let currentPath = null;
  for (let i = 0; i < lines.length; i++) {
    const pathMatch = lines[i].match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (/^\S/.test(lines[i])) {
      currentPath = null;
      continue;
    }
    const methodMatch = lines[i].match(/^ {8}(get|post|put|delete|patch|options|head):\s*$/);
    if (!currentPath || !methodMatch) continue;
    operations.push({ path: currentPath, method: methodMatch[1] });
  }
  return operations;
}

function findYamlResponseRange(lines, op, statusLine) {
  const start = lines.findIndex((line, index) => index > op.start && index < op.end && line === statusLine);
  if (start === -1) return null;
  let end = start + 1;
  while (end < op.end) {
    const line = lines[end];
    if (line && /^ {16}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('                    ')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function findYamlResponsesEnd(lines, op) {
  const responsesIndex = lines.findIndex((line, index) => index > op.start && index < op.end && line === '            responses:');
  if (responsesIndex === -1) return null;
  let end = responsesIndex + 1;
  while (end < op.end) {
    const line = lines[end];
    if (line && !line.startsWith('                ')) break;
    end++;
  }
  return { responsesIndex, end };
}

function ensureYamlResponse(lines, op, statusLine, block, beforeStatusLine = '                default:') {
  const existing = findYamlResponseRange(lines, op, statusLine);
  const expected = block.join('\n');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...block);
    return true;
  }
  const responses = findYamlResponsesEnd(lines, op);
  if (!responses) return false;
  const beforeIndex = lines.findIndex((line, index) =>
    index > responses.responsesIndex && index < responses.end && line === beforeStatusLine);
  const insertAt = beforeIndex === -1 ? responses.end : beforeIndex;
  lines.splice(insertAt, 0, ...block);
  return true;
}

function ensureYamlPost400Response(lines, op) {
  const existing = findYamlResponseRange(lines, op, '                "400":');
  if (!existing) {
    const responses = findYamlResponsesEnd(lines, op);
    if (!responses) return false;
    const beforeIndex = lines.findIndex((line, index) =>
      index > responses.responsesIndex && index < responses.end && line === '                "401":');
    const insertAt = beforeIndex === -1 ? responses.end : beforeIndex;
    lines.splice(insertAt, 0, ...YAML_POST_400_RESPONSE);
    return true;
  }

  let changed = false;
  const descriptionLine = '                    description: Validation error, invalid Idempotency-Key header, or malformed JSON request body';
  let descriptionIndex = -1;
  for (let i = existing.start + 1; i < existing.end; i++) {
    if (/^ {20}description:/.test(lines[i])) {
      descriptionIndex = i;
      break;
    }
  }
  if (descriptionIndex === -1) {
    lines.splice(existing.start + 1, 0, descriptionLine);
    existing.end++;
    changed = true;
  } else if (lines[descriptionIndex] !== descriptionLine) {
    lines[descriptionIndex] = descriptionLine;
    changed = true;
  }

  for (let i = existing.start + 1; i < existing.end; i++) {
    if (lines[i].includes("#/components/schemas/InvalidRequestBodyError")) return changed;
  }

  const oneOfIndex = lines.findIndex((line, index) =>
    index > existing.start && index < existing.end && /^ {32}oneOf:\s*$/.test(line));
  if (oneOfIndex === -1) {
    const schemaIndex = lines.findIndex((line, index) =>
      index > existing.start && index < existing.end && /^ {28}schema:\s*$/.test(line));
    if (schemaIndex === -1) {
      lines.splice(existing.start, existing.end - existing.start, ...YAML_POST_400_RESPONSE);
      return true;
    }
    let schemaEnd = schemaIndex + 1;
    while (schemaEnd < existing.end && lines[schemaEnd].startsWith('                                ')) {
      schemaEnd++;
    }
    const existingSchema = lines.slice(schemaIndex + 1, schemaEnd);
    if (existingSchema.length === 0) {
      lines.splice(existing.start, existing.end - existing.start, ...YAML_POST_400_RESPONSE);
      return true;
    }
    const wrappedSchema = existingSchema.map((line, index) => {
      if (index === 0) return `                                    - ${line.slice(32)}`;
      return `                                      ${line.slice(32)}`;
    });
    lines.splice(
      schemaIndex,
      schemaEnd - schemaIndex,
      '                            schema:',
      '                                oneOf:',
      ...wrappedSchema,
      "                                    - $ref: '#/components/schemas/InvalidRequestBodyError'",
    );
    return true;
  }

  let insertAt = oneOfIndex + 1;
  while (insertAt < existing.end && lines[insertAt].startsWith('                                    ')) {
    insertAt++;
  }
  lines.splice(insertAt, 0, "                                    - $ref: '#/components/schemas/InvalidRequestBodyError'");
  return true;
}

function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;
  changed = ensureYamlSchema(lines, 'RateLimitError', YAML_RATE_LIMIT_SCHEMA) || changed;
  changed = ensureYamlSchema(lines, 'GatewayError', YAML_GATEWAY_ERROR_SCHEMA) || changed;
  changed = ensureYamlSchema(lines, 'InvalidRequestBodyError', YAML_INVALID_REQUEST_BODY_SCHEMA) || changed;

  for (const { path, method } of enumerateYamlOperations(lines)) {
    let op = findYamlOperationRange(lines, path, method);
    if (!op) continue;
    changed = ensureYamlResponse(lines, op, '                "429":', YAML_429_RESPONSE) || changed;
    op = findYamlOperationRange(lines, path, method);
    if (!op) continue;
    changed = ensureYamlResponse(lines, op, '                default:', YAML_DEFAULT_RESPONSE) || changed;
    if (method === 'post') {
      op = findYamlOperationRange(lines, path, method);
      if (!op) continue;
      changed = ensureYamlPost400Response(lines, op) || changed;
    }
  }

  return { text: lines.join('\n'), changed };
}

const jsonFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
const yamlFiles = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f) || f === 'worldmonitor.openapi.yaml')
  .sort();
let wouldChange = 0;
const touched = [];

for (const file of jsonFiles) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (injectJson(spec)) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, serialize(spec));
  }
}

for (const file of yamlFiles) {
  const path = resolve(apiDir, file);
  const result = injectYaml(readFileSync(path, 'utf8'));
  if (result.changed) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, result.text);
  }
}

if (CHECK) {
  if (wouldChange > 0) {
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing gateway rate-limit/error contracts: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:rate-limit-errors');
    process.exit(1);
  }
  console.log('✓ gateway rate-limit/error contracts present on every OpenAPI operation');
} else {
  console.log(`openapi-inject-rate-limit-errors: updated ${wouldChange} artifact(s)`);
}
