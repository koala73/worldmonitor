#!/usr/bin/env node
/**
 * Inject JSON-null legality into the generated OpenAPI specs for proto3
 * `optional` scalar fields and for nullable message-typed properties.
 *
 * protoc-gen-openapiv3 (sebuf v0.11.1) emits a proto3 `optional double`
 * as a plain non-null `{type: number}` and a message-typed field as a bare
 * `$ref` — but WorldMonitor's seeder-written payloads (passed through
 * get-forecasts with no proto decode) deliberately persist explicit JSON
 * `null` for these: a judged ResolutionSpec carries `threshold: null` (never
 * 0 — a judged spec with threshold 0 would read as a hard ">= 0" bar) and a
 * forecast that never passed the resolution enrichment pass carries
 * `resolution: null`. The specs are OpenAPI 3.1, so the honest contract is a
 * `["<type>", "null"]` type array on each optional scalar and an
 * `anyOf: [$ref, {type: "null"}]` on the nullable message property.
 *
 * Source of truth: the proto itself — every field marked `optional` inside
 * `message ResolutionSpec` (proto/worldmonitor/forecast/v1/forecast.proto)
 * becomes nullable, so a future optional field is covered automatically.
 * Fails closed: if the proto or the message can't be parsed, nothing is
 * injected.
 *
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed
 * as `npm run gen:openapi:nullable`. Idempotent + byte-faithful (JSON via the
 * shared sorted, Go-escaped serializer; YAML via surgical line replacement).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const PROTO_TYPE_TO_JSON = {
  string: 'string',
  double: 'number',
  float: 'number',
  int32: 'integer',
  bool: 'boolean',
};

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// ── Source of truth: `optional` fields inside message ResolutionSpec ────────
function readOptionalResolutionFields() {
  let proto;
  try {
    proto = readFileSync(resolve(root, 'proto/worldmonitor/forecast/v1/forecast.proto'), 'utf8');
  } catch {
    return null; // fail closed — inject nothing
  }
  const msg = proto.match(/message ResolutionSpec \{([\s\S]*?)\n\}/);
  if (!msg) return null;
  const fields = new Map();
  for (const m of msg[1].matchAll(/^\s*optional\s+(\w+)\s+(\w+)\s*=/gm)) {
    const jsonType = PROTO_TYPE_TO_JSON[m[1]];
    if (jsonType) fields.set(snakeToCamel(m[2]), jsonType);
  }
  return fields.size > 0 ? fields : null;
}

// ── JSON spec ────────────────────────────────────────────────────────────────
function injectJson(file, fields) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  const schemas = spec.components?.schemas ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (name === 'ResolutionSpec' || name.endsWith('_ResolutionSpec')) {
      for (const [field, jsonType] of fields) {
        const prop = schema.properties?.[field];
        if (prop && prop.type === jsonType) prop.type = [jsonType, 'null'];
      }
    }
    // Nullable message property: Forecast.resolution may be JSON null.
    const res = schema.properties?.resolution;
    if (res && typeof res.$ref === 'string' && res.$ref.includes('ResolutionSpec')) {
      schema.properties.resolution = { anyOf: [{ $ref: res.$ref }, { type: 'null' }] };
    }
  }
  return { path, next: serialize(spec) };
}

// ── YAML specs (formatting-preserving surgical line replacement) ────────────
// Both YAMLs use 4-space-per-level indentation. Inside a `<X>ResolutionSpec:`
// schema block, each optional field's `type: <scalar>` line becomes a
// two-item block list; a `resolution:` property whose only child is a
// `$ref: '...ResolutionSpec'` line becomes an anyOf with a null branch.
function injectYaml(file, fields) {
  const path = resolve(apiDir, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  let inSpec = false;
  let specIndent = 0;
  let pendingField = null; // field name whose `type:` line we expect next
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const schemaHead = line.match(/^(\s*)(\w*ResolutionSpec):$/);
    if (schemaHead) {
      inSpec = true;
      specIndent = schemaHead[1].length;
      out.push(line);
      continue;
    }
    if (inSpec) {
      const indent = line.match(/^(\s*)/)[1].length;
      if (line.trim() !== '' && indent <= specIndent) inSpec = false;
    }
    if (inSpec) {
      const fieldHead = line.match(/^(\s*)(\w+):$/);
      if (fieldHead && fields.has(fieldHead[2])) {
        pendingField = { name: fieldHead[2], indent: fieldHead[1].length };
        out.push(line);
        continue;
      }
      if (pendingField) {
        const jsonType = fields.get(pendingField.name);
        const typeLine = new RegExp(`^(\\s{${pendingField.indent + 4}})type: ${jsonType}$`);
        const m = line.match(typeLine);
        pendingField = null;
        if (m) {
          out.push(`${m[1]}type:`);
          out.push(`${m[1]}    - ${jsonType}`);
          out.push(`${m[1]}    - 'null'`);
          continue;
        }
      }
    }
    // Forecast.resolution: bare $ref → anyOf with null branch.
    const resHead = line.match(/^(\s*)resolution:$/);
    if (resHead && i + 1 < lines.length) {
      const refLine = lines[i + 1].match(/^(\s*)\$ref: ('#\/components\/schemas\/\w*ResolutionSpec')$/);
      if (refLine) {
        const base = resHead[1];
        out.push(line);
        out.push(`${base}    anyOf:`);
        out.push(`${base}        - $ref: ${refLine[2]}`);
        out.push(`${base}        - type: 'null'`);
        i += 1; // consume the $ref line
        continue;
      }
    }
    out.push(line);
  }
  return { path, next: out.join('\n') };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const fields = readOptionalResolutionFields();
if (!fields) {
  console.log('openapi-inject-nullable: no optional ResolutionSpec fields found — nothing to do');
  process.exit(0);
}

const results = [
  injectJson('ForecastService.openapi.json', fields),
  injectYaml('ForecastService.openapi.yaml', fields),
  injectYaml('worldmonitor.openapi.yaml', fields),
];

let changed = 0;
for (const { path, next } of results) {
  const current = readFileSync(path, 'utf8');
  if (current === next) continue;
  changed += 1;
  if (CHECK) {
    console.error(`openapi-inject-nullable --check: ${path} is stale`);
  } else {
    writeFileSync(path, next);
  }
}

if (CHECK && changed > 0) process.exit(1);
console.log(`openapi-inject-nullable: ${CHECK ? 'checked' : 'updated'} ${changed} artifact(s) (${fields.size} nullable field(s))`);
