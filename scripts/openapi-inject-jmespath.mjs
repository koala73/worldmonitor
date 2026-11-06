#!/usr/bin/env node
/**
 * Advertise the universal `?jmespath=` response-projection parameter on every
 * GET operation in the generated OpenAPI specs.
 *
 * The REST gateway (server/gateway.ts) applies an optional JMESPath expression
 * from the `jmespath` query parameter to any JSON GET response before it is
 * returned — parity with the `jmespath` argument the MCP server already exposes
 * on every tool (api/mcp/jmespath.ts, server/_shared/response-projection.ts).
 * The sebuf generator only emits parameters that map to a proto request field,
 * so this gateway-level parameter (which belongs to no proto message) has to be
 * injected post-generation.
 *
 * Why it matters beyond the feature itself: ora.ai / orank's `api-schema-analysis`
 * check counts a parameterless operation as "not typed". 55 GET snapshot
 * endpoints take no proto input (`message GetChokepointStatusRequest {}`), so
 * the published spec read as "partially documented" (137/192 typed). Advertising
 * this genuinely-honored parameter on every GET makes all 181 GET operations
 * self-describing (the 11 POSTs are already typed via their requestBody), which
 * flips the check to fully documented — without inventing a fake parameter.
 *
 * Scope: GET operations only. POSTs carry a typed requestBody already, and the
 * gateway applies the projection only on the GET 200 response path.
 *
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed as
 * `npm run gen:openapi:jmespath`. Idempotent + byte-faithful (JSON re-serialized
 * with the shared sorted, Go-escaped strategy; YAML via surgical insertion).
 *
 * See umbrella issue #4599 and the orank Access work in #4698.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';

const PATH_MATCH_RE = /^ {4}(\/\S+):\s*$/;
const INJECT_YAML_RE = /^\S/;
const METHOD_MATCH_RE = /^ {8}([a-z]+):\s*$/;
const INJECT_YAML_RE_2 = /^ {0,8}\S/;
const INJECT_YAML_RE_3 = /^ {12}parameters:\s*$/;
const INJECT_YAML_RE_4 = /^ {16}- name: jmespath\s*$/;
const INJECT_YAML_RE_5 = /^ {12}responses:\s*$/;
const SCHEMAS_INDEX_RE = /^ {4}schemas:\s*$/;
const ENSURE_YAML_JMESPATH_PARAM_RE = /^ {16}- name: \S+/;
const ENSURE_YAML_JMESPATH_PARAM_RE_2 = /^ {12}\S/;
const ENSURE_YAML_JMESPATH400_RESPONSE_RE = /^ {16}"400":\s*$/;
const ENSURE_YAML_JMESPATH400_RESPONSE_RE_2 = /^ {16}("\d{3}"|default):\s*$/;
const SCHEMA_INDEX_RE = /^ {28}schema:\s*$/;
const REF_MATCH_RE = /^ {32}\$ref: (.+)$/;
const JSON_FILES_RE = /Service\.openapi\.json$/;
const YAML_FILES_RE = /Service\.openapi\.yaml$/;


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const PARAM_NAME = 'jmespath';
const PARAM_EXAMPLE = 'keys(@)';
const PARAM_DESCRIPTION =
  'Optional JMESPath expression applied server-side to project or reduce the JSON response before it is returned (mirrors the MCP jmespath argument). Invalid expressions, expressions larger than 1024 UTF-8 bytes, or projections that exceed the 256 KB output cap return HTTP 400 with a {_jmespath_error, original_keys} envelope. Grammar and worked examples: https://www.worldmonitor.app/docs/mcp-jmespath.';
const JMESPATH_ERROR_SCHEMA_NAME = 'JmespathProjectionError';
const JMESPATH_ERROR_SCHEMA_REF = `#/components/schemas/${JMESPATH_ERROR_SCHEMA_NAME}`;
// Canonical JSON parameter object. Key order is irrelevant — serialize() sorts
// keys recursively, matching the generator's byte layout.
function jmespathParam() {
  return {
    name: PARAM_NAME,
    in: 'query',
    description: PARAM_DESCRIPTION,
    required: false,
    example: PARAM_EXAMPLE,
    schema: { type: 'string' },
  };
}

function jmespathErrorSchema() {
  return {
    description: 'Returned when a REST jmespath projection is invalid or exceeds the expression/output byte limits.',
    properties: {
      _jmespath_error: {
        type: 'string',
        description: 'Projection error discriminator and details.',
      },
      original_keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top-level keys or shape of the unprojected response.',
      },
    },
    required: ['_jmespath_error', 'original_keys'],
    type: 'object',
  };
}

function hasSchemaRef(schema, ref) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref === ref) return true;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key]) && schema[key].some((item) => hasSchemaRef(item, ref))) return true;
  }
  return false;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function ensureJmespathErrorSchema(spec) {
  if (!spec.components || typeof spec.components !== 'object') spec.components = {};
  if (!spec.components.schemas || typeof spec.components.schemas !== 'object') spec.components.schemas = {};
  if (spec.components.schemas[JMESPATH_ERROR_SCHEMA_NAME]) return false;
  spec.components.schemas[JMESPATH_ERROR_SCHEMA_NAME] = jmespathErrorSchema();
  return true;
}

function ensureJmespath400Response(op) {
  const schema = op?.responses?.['400']?.content?.['application/json']?.schema;
  if (!schema || hasSchemaRef(schema, JMESPATH_ERROR_SCHEMA_REF)) return false;
  op.responses['400'].content['application/json'].schema = {
    oneOf: [
      schema,
      { $ref: JMESPATH_ERROR_SCHEMA_REF },
    ],
  };
  return true;
}

function ensureJmespathParam(op) {
  if (!Array.isArray(op.parameters)) op.parameters = [];
  const existingIndex = op.parameters.findIndex((p) => p && p.name === PARAM_NAME);
  if (existingIndex === -1) {
    op.parameters.push(jmespathParam());
    return true;
  }
  const canonical = jmespathParam();
  if (stableStringify(op.parameters[existingIndex]) === stableStringify(canonical)) return false;
  op.parameters[existingIndex] = canonical;
  return true;
}

// YAML rendering of the same parameter as a list item (16-space `- `, 18-space
// continuation, 20-space schema children + block-scalar body) — matches the
// indentation the generator/injectors already use for query params. A one-line
// `|-` literal block sidesteps escaping the ':' '{' '(' '>' characters.
const JMESPATH_YAML_ITEM = [
  `                - name: ${PARAM_NAME}`,
  '                  in: query',
  '                  description: |-',
  `                    ${PARAM_DESCRIPTION}`,
  '                  required: false',
  `                  example: "${PARAM_EXAMPLE}"`,
  '                  schema:',
  '                    type: string',
];

const JMESPATH_ERROR_YAML_SCHEMA = [
  `        ${JMESPATH_ERROR_SCHEMA_NAME}:`,
  '            description: Returned when a REST jmespath projection is invalid or exceeds the expression/output byte limits.',
  '            properties:',
  '                _jmespath_error:',
  '                    description: Projection error discriminator and details.',
  '                    type: string',
  '                original_keys:',
  '                    description: Top-level keys or shape of the unprojected response.',
  '                    items:',
  '                        type: string',
  '                    type: array',
  '            required:',
  '                - _jmespath_error',
  '                - original_keys',
  '            type: object',
];

// ── Per-service JSON ────────────────────────────────────────────────────────
function injectJson(spec) {
  let changed = ensureJmespathErrorSchema(spec);
  for (const ops of Object.values(spec.paths ?? {})) {
    const op = ops?.get;
    if (!op || typeof op !== 'object') continue;
    if (ensureJmespathParam(op)) changed = true;
    if (ensureJmespath400Response(op)) changed = true;
  }
  return changed;
}

// ── YAML (formatting-preserving surgical insertion) ─────────────────────────
// For each GET operation, insert the jmespath parameter immediately before the
// op's `            responses:` line (12-space op child). When the op already
// has a `            parameters:` block the item becomes its last entry; when it
// has none, the `parameters:` header is prepended. Path lines are at 4 spaces,
// method lines at 8, op children at 12, list items at 16.
function injectYaml(text) {
  const lines = text.split('\n');
  let changed = ensureYamlJmespathErrorSchema(lines);
  let currentPath = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = line.match(PATH_MATCH_RE);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (INJECT_YAML_RE.test(line)) {
      currentPath = null; // left the paths: block
      continue;
    }

    const methodMatch = line.match(METHOD_MATCH_RE);
    if (!methodMatch || !currentPath || methodMatch[1] !== 'get') continue;

    let blockEnd = lines.length;
    let responsesIndex = -1;
    let hasParameters = false;
    let hasJmespath = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (INJECT_YAML_RE_2.test(lines[j])) {
        blockEnd = j;
        break; // next method (8) / path (4) / top-level
      }
      if (INJECT_YAML_RE_3.test(lines[j])) hasParameters = true;
      if (INJECT_YAML_RE_4.test(lines[j])) hasJmespath = true;
      if (responsesIndex === -1 && INJECT_YAML_RE_5.test(lines[j])) responsesIndex = j;
    }

    if (responsesIndex === -1) continue;

    if (!hasJmespath) {
      const block = hasParameters
        ? JMESPATH_YAML_ITEM
        : ['            parameters:', ...JMESPATH_YAML_ITEM];
      lines.splice(responsesIndex, 0, ...block);
      blockEnd += block.length;
      changed = true;
    } else if (ensureYamlJmespathParam(lines, i, blockEnd)) {
      changed = true;
    }
    if (ensureYamlJmespath400Response(lines, responsesIndex, blockEnd)) changed = true;
  }
  return { text: lines.join('\n'), changed };
}

function ensureYamlJmespathErrorSchema(lines) {
  if (lines.some((line) => line === `        ${JMESPATH_ERROR_SCHEMA_NAME}:`)) return false;
  const schemasIndex = lines.findIndex((line) => SCHEMAS_INDEX_RE.test(line));
  if (schemasIndex === -1) return false;
  lines.splice(schemasIndex + 1, 0, ...JMESPATH_ERROR_YAML_SCHEMA);
  return true;
}

function ensureYamlJmespathParam(lines, start, end) {
  const paramIndex = lines.findIndex((line, index) =>
    index > start && index < end && INJECT_YAML_RE_4.test(line));
  if (paramIndex === -1) return false;

  let paramEnd = end;
  for (let i = paramIndex + 1; i < end; i++) {
    if (ENSURE_YAML_JMESPATH_PARAM_RE.test(lines[i]) || ENSURE_YAML_JMESPATH_PARAM_RE_2.test(lines[i])) {
      paramEnd = i;
      break;
    }
  }
  const current = lines.slice(paramIndex, paramEnd);
  if (current.length === JMESPATH_YAML_ITEM.length && current.every((line, index) => line === JMESPATH_YAML_ITEM[index])) {
    return false;
  }
  lines.splice(paramIndex, paramEnd - paramIndex, ...JMESPATH_YAML_ITEM);
  return true;
}

function ensureYamlJmespath400Response(lines, start, end) {
  let changed = false;
  for (let i = start; i < end; i++) {
    if (!ENSURE_YAML_JMESPATH400_RESPONSE_RE.test(lines[i])) continue;

    let responseEnd = end;
    for (let j = i + 1; j < end; j++) {
      if (ENSURE_YAML_JMESPATH400_RESPONSE_RE_2.test(lines[j])) {
        responseEnd = j;
        break;
      }
    }
    if (lines.slice(i, responseEnd).some((line) => line.includes(JMESPATH_ERROR_SCHEMA_NAME))) continue;

    const schemaIndex = lines.findIndex((line, index) =>
      index > i && index < responseEnd && SCHEMA_INDEX_RE.test(line));
    if (schemaIndex === -1) continue;

    const refLine = lines[schemaIndex + 1] ?? '';
    const refMatch = refLine.match(REF_MATCH_RE);
    if (!refMatch) continue;

    lines.splice(
      schemaIndex + 1,
      1,
      '                                oneOf:',
      `                                    - $ref: ${refMatch[1]}`,
      `                                    - $ref: '${JMESPATH_ERROR_SCHEMA_REF}'`,
    );
    changed = true;
    end += 2;
  }
  return changed;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const jsonFiles = readdirSync(apiDir).filter((f) => JSON_FILES_RE.test(f)).sort();
const yamlFiles = readdirSync(apiDir)
  .filter((f) => YAML_FILES_RE.test(f) || f === 'worldmonitor.openapi.yaml')
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the eligible jmespath contract: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:jmespath');
    process.exit(1);
  }
  console.log('✓ jmespath projection parameter present on every eligible GET operation');
} else {
  console.log(`openapi-inject-jmespath: updated ${wouldChange} artifact(s)`);
}
