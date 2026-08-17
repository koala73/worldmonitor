// Cached loader for the unified OpenAPI bundle used by the contract tests.
//
// docs/api/worldmonitor.openapi.yaml is ~2.1 MB and a YAML parse of it costs
// far more than the tens-of-milliseconds JSON.parse of the same document. The
// contract suite loads the bundle from 15 separate test processes (some files
// several times), which made the OpenAPI guards the slowest block of
// test:data. Identical bytes always parse to the identical document, so the
// parse result is cached on disk as JSON keyed by a content hash of the YAML
// source: the first process to need it pays the YAML parse once, every later
// load — in this process or any concurrent test process — replays it as a
// JSON.parse.
//
// Correctness properties:
//   - The cache key is a sha256 of the YAML bytes, so an edited spec can never
//     be served from a stale entry.
//   - Every call returns a FRESH object (JSON.parse per call), so a test that
//     mutates the returned spec cannot leak state into another test.
//   - Any cache failure (unwritable dir, corrupted entry) falls back to a
//     direct YAML.parse — the cache is an accelerator, never a dependency.
//   - The YAML→JSON round-trip is lossless for this document class: OpenAPI
//     bundles contain only JSON-representable values (no dates, anchors that
//     must stay shared, or non-finite numbers).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// js-yaml, not 'yaml': on the 2.1 MB bundle js-yaml loads roughly an order of
// magnitude faster (~8-20x across measurements), and both produce the
// identical document for this spec (verified deep-equal). The parser choice
// bounds the worst case for every cold-cache process racing to warm the same
// entry.
import { load as loadYamlSource } from 'js-yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPENAPI_HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

// JSON string per absolute source path, memoized for this process.
const jsonMemo = new Map();

/** Sorted `METHOD /path` identities for every real operation in one spec. */
export function openApiOperationIds(spec, { methods = OPENAPI_HTTP_METHODS } = {}) {
  const ids = [];
  for (const [path, pathItem] of Object.entries(spec?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!methods.has(method) || !operation || typeof operation !== 'object') continue;
      ids.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return ids.sort();
}

/**
 * Sorted `Service::METHOD /path` identities across per-service specifications.
 * The service namespace makes a same-cardinality move between service files a
 * detectable contract change, not merely a matching global route count.
 */
export function serviceOpenApiOperationIds(specsByFile, options) {
  return [...specsByFile].flatMap(([file, spec]) => {
    const service = file.replace(/\.openapi\.(?:json|yaml)$/u, '');
    return openApiOperationIds(spec, options).map((id) => `${service}::${id}`);
  }).sort();
}

function cacheDir() {
  return join(repoRoot, 'node_modules', '.cache', 'wm-openapi-spec');
}

function readCacheEntry(cachePath) {
  try {
    return readFileSync(cachePath, 'utf8');
  } catch {
    return null;
  }
}

function writeCacheEntry(cachePath, json) {
  // Atomic publish: concurrent test processes race to warm the same entry, and
  // a rename can never expose a half-written file to a concurrent reader.
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, cachePath);
  } catch {
    try {
      const fallback = join(tmpdir(), 'wm-openapi-spec', cachePath.split('/').pop());
      mkdirSync(dirname(fallback), { recursive: true });
      const tmp = `${fallback}.${process.pid}.tmp`;
      writeFileSync(tmp, json);
      renameSync(tmp, fallback);
    } catch {
      // Cache stays cold; every process pays the parse. Correct, just slower.
    }
  }
}

function jsonStringFor(absPath) {
  const source = readFileSync(absPath, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const entryName = `${absPath.split('/').pop()}.${hash}.json`;
  const candidates = [join(cacheDir(), entryName), join(tmpdir(), 'wm-openapi-spec', entryName)];

  for (const cachePath of candidates) {
    const cached = readCacheEntry(cachePath);
    if (cached !== null) {
      try {
        JSON.parse(cached);
        return cached;
      } catch {
        // Corrupted entry (e.g. a torn write from a killed process): ignore it
        // and fall through to a fresh parse that overwrites it.
      }
    }
  }

  const doc = loadYamlSource(source);
  assertJsonRepresentable(doc, absPath);
  const json = JSON.stringify(doc);
  writeCacheEntry(candidates[0], json);
  return json;
}

// The cache replays parses through JSON, so a document that only YAML can
// represent (Dates from bare timestamps, non-finite numbers, undefined) would
// silently change shape for consumers. No OpenAPI spec should contain such
// values — fail loudly if one ever does rather than serve a lossy replay.
function assertJsonRepresentable(value, absPath, path = '$') {
  if (value === undefined || value instanceof Date
    || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(
      `${absPath}: ${path} holds a non-JSON-representable value (${value}); ` +
      'openapi-spec-cache cannot replay this document losslessly',
    );
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertJsonRepresentable(value[key], absPath, `${path}.${key}`);
    }
  }
}

/**
 * Parse a large committed YAML spec with cross-process caching.
 *
 * Returns a fresh document per call — mutate freely.
 */
export function loadYamlSpecCached(absPath) {
  let json = jsonMemo.get(absPath);
  if (json === undefined) {
    json = jsonStringFor(absPath);
    jsonMemo.set(absPath, json);
  }
  return JSON.parse(json);
}

/** The unified bundle, the one spec expensive enough to need the cache. */
export function loadUnifiedOpenApiSpec() {
  return loadYamlSpecCached(resolve(repoRoot, 'docs', 'api', 'worldmonitor.openapi.yaml'));
}

/** Service declarations discovered from the authoritative proto tree. */
export function discoverProtoServiceNames() {
  const protoRoot = resolve(repoRoot, 'proto', 'worldmonitor');
  return readdirSync(protoRoot, { recursive: true })
    .filter((file) => file.endsWith('.proto'))
    .flatMap((file) => [
      ...readFileSync(resolve(protoRoot, file), 'utf8').matchAll(/^service\s+([A-Za-z0-9_]+)/gm),
    ].map((match) => match[1]))
    .sort();
}
