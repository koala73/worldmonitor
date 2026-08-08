#!/usr/bin/env node
/**
 * Inject the production `servers` block into the generated per-service OpenAPI
 * specs.
 *
 * The sebuf `protoc-gen-openapiv3` plugin emits per-service specs
 * (docs/api/<Service>.openapi.{json,yaml}) with NO top-level `servers` field:
 * only the BUNDLE (docs/api/worldmonitor.openapi.yaml) gets one, via the
 * `bundle_server` option in proto/buf.gen.yaml. Without a per-service `servers`
 * entry the Mintlify docs site falls back to the placeholder base URL
 * `https://api.example.com`, so every rendered curl snippet points at a
 * non-existent host. This post-generation step stamps the real base URL onto
 * each per-service spec so the published contract matches runtime reality.
 * See umbrella issue #4599.
 *
 * Wired into `make generate` (runs after the other OpenAPI injectors) and
 * exposed as `npm run gen:openapi:servers`. Idempotent: re-running (or a fresh
 * regenerate followed by this step) yields byte-identical output.
 *
 * Two artifact families:
 *   1. docs/api/<Service>.openapi.json — insert a top-level `servers` key and
 *      re-serialize byte-faithfully to the generator's format (recursively
 *      sorted keys, Go-style <>&/U+2028/U+2029 escaping, no trailing newline)
 *      so the diff is additions-only.
 *   2. docs/api/<Service>.openapi.yaml — formatting-preserving surgical
 *      insertion of a top-level `servers:` block (4-space list item) before the
 *      top-level `paths:` line, mirroring how openapi-inject-security.mjs
 *      inserts its root `security:` block.
 *
 * The bundle (worldmonitor.openapi.yaml) already carries `servers` from
 * `bundle_server`, so it is intentionally left untouched.
 *
 * Like the sibling injectors this runs in the `make generate` codegen context
 * (no npm deps guaranteed), so it has no external imports: paths are enumerated
 * by text scan and all YAML writes are surgical text insertions.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, eq } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const CHECK = process.argv.includes('--check');

// The production base URL — identical to `bundle_server` in proto/buf.gen.yaml,
// which stamps the same value onto the bundle. Keep the two in sync.
const SERVER_URL = 'https://api.worldmonitor.app';
const SERVERS = [{ url: SERVER_URL }];

// ── Per-service JSON injection ──────────────────────────────────────────────
function injectJson(spec) {
  if (eq(spec.servers, SERVERS)) return false;
  spec.servers = SERVERS;
  return true;
}

// ── Per-service YAML injection (formatting-preserving) ──────────────────────
// Top-level `servers:` list — 4-space list items to match the bundle's
// `servers:` style (set via bundle_server) and openapi-inject-security.mjs.
function yamlServersBlock() {
  return [
    'servers:',
    `    - url: ${SERVER_URL}`,
  ].join('\n');
}

// A top-level key is at column 0 (no leading whitespace); its block extends
// until the next column-0 line. Mirrors findTopLevelBlock in
// openapi-inject-security.mjs.
function findTopLevelBlock(lines, key) {
  const start = lines.indexOf(key + ':');
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function injectYamlServers(text) {
  const lines = text.split('\n');
  const expected = yamlServersBlock();

  const block = findTopLevelBlock(lines, 'servers');
  if (block) {
    if (block.text === expected) return { text, changed: false };
    lines.splice(block.start, block.end - block.start, ...expected.split('\n'));
    return { text: lines.join('\n'), changed: true };
  }

  // Insert top-level `servers:` immediately before top-level `paths:`.
  const pathsIndex = lines.indexOf('paths:');
  if (pathsIndex === -1) throw new Error('yaml: could not find top-level `paths:` anchor for servers block');
  lines.splice(pathsIndex, 0, ...expected.split('\n'));
  return { text: lines.join('\n'), changed: true };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const specFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
const serviceYamlFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.yaml$/.test(f)).sort();
let wouldChange = 0;
const touched = [];

for (const file of specFiles) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (injectJson(spec)) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, serialize(spec));
  }
}

for (const file of serviceYamlFiles) {
  const path = resolve(apiDir, file);
  const raw = readFileSync(path, 'utf8');
  const result = injectYamlServers(raw);
  if (result.changed) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, result.text);
  }
}

if (CHECK) {
  if (wouldChange > 0) {
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the servers block: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:servers');
    process.exit(1);
  }
  console.log(`✓ all ${specFiles.length} JSON specs + ${serviceYamlFiles.length} YAML specs carry servers: ${SERVER_URL}`);
} else {
  console.log(
    `openapi-inject-servers: updated ${wouldChange} artifact(s) — ${specFiles.length} JSON specs, ${serviceYamlFiles.length} YAML specs scanned (bundle left untouched; it carries bundle_server)`,
  );
}
