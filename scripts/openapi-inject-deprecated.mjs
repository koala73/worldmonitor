#!/usr/bin/env node
/**
 * Mark deprecated operations in the generated OpenAPI specs.
 *
 * protoc-gen-openapiv3 (sebuf v0.11.1) does NOT propagate a method's
 * `option deprecated = true;` to the OpenAPI operation's `deprecated: true`
 * flag, so a disabled/retired RPC renders in Mintlify as a normal, usable
 * endpoint (only its prose description says "DISABLED"). This post-generation
 * step reads the proto `option deprecated` — the single source of truth — and
 * stamps `deprecated: true` on the matching operation across the per-service
 * JSON + YAML specs and the bundle. Any future RPC that gains the proto option
 * is covered automatically.
 *
 * Wired into `make generate` (after the other OpenAPI injectors) and exposed as
 * `npm run gen:openapi:deprecated`. Idempotent + byte-faithful (JSON re-serialized
 * with the shared sorted, Go-escaped strategy; YAML via surgical insertion).
 *
 * See umbrella issue #4599.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const protoDir = resolve(root, 'proto/worldmonitor');
const CHECK = process.argv.includes('--check');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

// ── Source of truth: proto RPCs carrying `option deprecated = true;` ─────────
// Split each service.proto into `rpc ... { ... }` blocks; a block that carries
// both `option deprecated = true` and an http `path: "..."` yields the exact
// generated OpenAPI path (`base_path` + RPC path). Fails closed: if a
// service.proto can't be read it is skipped, never silently marking an op
// deprecated.
function readDeprecatedPaths() {
  const paths = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'service.proto') scan(full);
    }
  };
  const scan = (file) => {
    const src = readFileSync(file, 'utf8');
    const serviceConfig = src.match(/\(sebuf\.http\.service_config\)\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const basePath = serviceConfig.match(/\bbase_path:\s*"([^"]+)"/)?.[1] ?? '';
    // Match each `rpc ... { ... }` body (non-greedy to the first closing brace at
    // the rpc's own indent).
    for (const block of src.matchAll(/\brpc\s+\w+\s*\([^)]*\)\s*returns\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/g)) {
      const body = block[1];
      if (!/option\s+deprecated\s*=\s*true\s*;/.test(body)) continue;
      const pathMatch = body.match(/path:\s*"([^"]+)"/);
      if (pathMatch) paths.add(joinOpenApiPath(basePath, pathMatch[1]));
    }
  };
  walk(protoDir);
  return paths;
}

function joinOpenApiPath(basePath, rpcPath) {
  if (!basePath) return rpcPath;
  if (rpcPath === basePath || rpcPath.startsWith(basePath + '/')) return rpcPath;
  return basePath.replace(/\/+$/, '') + '/' + rpcPath.replace(/^\/+/, '');
}

const DEPRECATED_PATHS = readDeprecatedPaths();

function isDeprecatedPath(path) {
  return DEPRECATED_PATHS.has(path);
}

// ── Per-service JSON ────────────────────────────────────────────────────────
function injectJson(spec) {
  let changed = false;
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const shouldBeDeprecated = isDeprecatedPath(path);
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      if (shouldBeDeprecated && op.deprecated !== true) {
        op.deprecated = true;
        changed = true;
      } else if (!shouldBeDeprecated && op.deprecated !== undefined) {
        delete op.deprecated;
        changed = true;
      }
    }
  }
  return changed;
}

// ── YAML (formatting-preserving surgical insertion) ─────────────────────────
// Insert `            deprecated: true` (12-space op-level indent) immediately
// after the `        <method>:` line of a deprecated op. Path lines are at 4
// spaces, method lines at 8, op children at 12.
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
    if (!methodMatch || !currentPath || !HTTP_METHODS.has(methodMatch[1])) continue;

    const shouldBeDeprecated = isDeprecatedPath(currentPath);
    let deprecatedIndex = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {0,8}\S/.test(lines[j])) break; // next method (8) or path (4) or top-level
      if (/^ {12}deprecated:/.test(lines[j])) {
        deprecatedIndex = j;
        break;
      }
    }

    if (shouldBeDeprecated) {
      if (deprecatedIndex === -1) {
        lines.splice(i + 1, 0, '            deprecated: true');
        changed = true;
        i++;
      } else if (lines[deprecatedIndex] !== '            deprecated: true') {
        lines[deprecatedIndex] = '            deprecated: true';
        changed = true;
      }
    } else if (deprecatedIndex !== -1) {
      lines.splice(deprecatedIndex, 1);
      changed = true;
    }
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing a deprecated flag: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:deprecated');
    process.exit(1);
  }
  console.log(`✓ deprecated flags in sync (${DEPRECATED_PATHS.size} deprecated RPC path(s) tracked)`);
} else {
  console.log(
    `openapi-inject-deprecated: updated ${wouldChange} artifact(s) — ${DEPRECATED_PATHS.size} deprecated RPC path(s): ${[...DEPRECATED_PATHS].join(', ') || '(none)'}`,
  );
}
