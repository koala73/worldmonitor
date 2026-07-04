#!/usr/bin/env node
/**
 * Advertise Idempotency-Key support on every POST (mutation) operation in the
 * generated OpenAPI specs.
 *
 * The gateway (server/_shared/idempotency.ts, wired into server/gateway.ts)
 * honors an `Idempotency-Key` request header on POST endpoints so agents can
 * safely retry on network failure without duplicating a side effect. The sebuf
 * `protoc-gen-openapiv3` plugin has no annotation for describing a header
 * parameter, so this post-generation step stamps the parameter onto each POST
 * operation across the per-service JSON + YAML specs and the bundle. Scanners
 * (e.g. ora.ai / orank) that fall back to the published spec for auth-gated
 * routes then see the documented support.
 *
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed as
 * `npm run gen:openapi:idempotency`. Idempotent + byte-faithful (JSON
 * re-serialized with the shared sorted, Go-escaped strategy; YAML via surgical
 * insertion). See umbrella issue #4599 and the orank Access-layer work (#4698).
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const DESCRIPTION =
  'Optional client-generated idempotency key. Retrying a POST with the same key returns the original response instead of duplicating the side effect. Keys are scoped per caller and retained for 24 hours.';
const EXAMPLE = '4f8b9c2e-1a3d-4b6f-8e0a-2c5d7f9b1e34';

// ── Per-service JSON ────────────────────────────────────────────────────────
// Object-key order is irrelevant (the shared serializer sorts recursively);
// only membership + values matter for byte-faithful output.
const JSON_PARAM = {
  name: 'Idempotency-Key',
  in: 'header',
  description: DESCRIPTION,
  required: false,
  example: EXAMPLE,
  schema: { type: 'string', maxLength: 255 },
};

function isIdempotencyParam(param) {
  return (
    param &&
    typeof param === 'object' &&
    param.in === 'header' &&
    String(param.name).toLowerCase() === 'idempotency-key'
  );
}

function injectJson(spec) {
  let changed = false;
  for (const ops of Object.values(spec.paths ?? {})) {
    const post = ops && typeof ops === 'object' ? ops.post : null;
    if (!post || typeof post !== 'object') continue;
    const params = Array.isArray(post.parameters) ? post.parameters : [];
    if (params.some(isIdempotencyParam)) continue;
    post.parameters = [...params, JSON_PARAM];
    changed = true;
  }
  return changed;
}

// ── YAML (formatting-preserving surgical insertion) ─────────────────────────
// Path lines at 4 spaces, method lines at 8, op children (`parameters:`) at 12,
// list items (`- name:`) at 16, item children at 18, schema children at 20 —
// matching the generator's existing query-parameter blocks.
const YAML_ITEM = [
  '                - name: Idempotency-Key',
  '                  in: header',
  `                  description: ${DESCRIPTION}`,
  '                  required: false',
  `                  example: "${EXAMPLE}"`,
  '                  schema:',
  '                    type: string',
  '                    maxLength: 255',
];

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
    if (!currentPath || !/^ {8}post:\s*$/.test(line)) continue;

    // Op block spans until the next line at <= 8-space indent (next method /
    // path / top-level key).
    let end = i + 1;
    while (end < lines.length && !/^ {0,8}\S/.test(lines[end])) end++;

    let alreadyPresent = false;
    let paramsIndex = -1;
    for (let j = i + 1; j < end; j++) {
      if (/^ {16}- name: Idempotency-Key\s*$/.test(lines[j])) {
        alreadyPresent = true;
        break;
      }
      if (paramsIndex === -1 && /^ {12}parameters:\s*$/.test(lines[j])) paramsIndex = j;
    }
    if (alreadyPresent) continue;

    if (paramsIndex !== -1) {
      // Append to an existing parameters list (none today — future-proofing).
      lines.splice(paramsIndex + 1, 0, ...YAML_ITEM);
      i = paramsIndex + YAML_ITEM.length;
    } else {
      lines.splice(i + 1, 0, '            parameters:', ...YAML_ITEM);
      i += 1 + YAML_ITEM.length;
    }
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the Idempotency-Key parameter: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:idempotency');
    process.exit(1);
  }
  console.log('✓ Idempotency-Key parameter in sync across all POST operations');
} else {
  console.log(`openapi-inject-idempotency: updated ${wouldChange} artifact(s)`);
}
