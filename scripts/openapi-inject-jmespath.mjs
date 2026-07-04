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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const PARAM_NAME = 'jmespath';
const PARAM_EXAMPLE = 'keys(@)';
const PARAM_DESCRIPTION =
  'Optional JMESPath expression applied server-side to project or reduce the JSON response before it is returned (mirrors the MCP jmespath argument). Invalid or oversized (> 1024-byte) expressions return HTTP 400 with a {_jmespath_error, original_keys} envelope. Grammar and worked examples: https://www.worldmonitor.app/docs/mcp-jmespath.';

// Canonical JSON parameter object. Key order is irrelevant — serialize() sorts
// keys recursively, matching the generator's byte layout.
function jmespathParam() {
  return {
    name: PARAM_NAME,
    in: 'query',
    description: PARAM_DESCRIPTION,
    required: false,
    example: PARAM_EXAMPLE,
    schema: { type: 'string', maxLength: 1024 },
  };
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
  '                    maxLength: 1024',
];

// ── Per-service JSON ────────────────────────────────────────────────────────
function injectJson(spec) {
  let changed = false;
  for (const ops of Object.values(spec.paths ?? {})) {
    const op = ops?.get;
    if (!op || typeof op !== 'object') continue;
    if (!Array.isArray(op.parameters)) op.parameters = [];
    if (op.parameters.some((p) => p && p.name === PARAM_NAME)) continue;
    op.parameters.push(jmespathParam());
    changed = true;
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
  let changed = false;
  let currentPath = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = line.match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (/^\S/.test(line)) {
      currentPath = null; // left the paths: block
      continue;
    }

    const methodMatch = line.match(/^ {8}([a-z]+):\s*$/);
    if (!methodMatch || !currentPath || methodMatch[1] !== 'get') continue;

    let responsesIndex = -1;
    let hasParameters = false;
    let hasJmespath = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {0,8}\S/.test(lines[j])) break; // next method (8) / path (4) / top-level
      if (/^ {12}parameters:\s*$/.test(lines[j])) hasParameters = true;
      if (/^ {16}- name: jmespath\s*$/.test(lines[j])) hasJmespath = true;
      if (responsesIndex === -1 && /^ {12}responses:\s*$/.test(lines[j])) responsesIndex = j;
    }

    if (hasJmespath || responsesIndex === -1) continue;

    const block = hasParameters
      ? JMESPATH_YAML_ITEM
      : ['            parameters:', ...JMESPATH_YAML_ITEM];
    lines.splice(responsesIndex, 0, ...block);
    changed = true;
  }
  return { text: lines.join('\n'), changed };
}

// ── Run ──────────────────────────────────────────────────────────────────────
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the jmespath parameter: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:jmespath');
    process.exit(1);
  }
  console.log('✓ jmespath projection parameter present on every GET operation');
} else {
  console.log(`openapi-inject-jmespath: updated ${wouldChange} artifact(s)`);
}
