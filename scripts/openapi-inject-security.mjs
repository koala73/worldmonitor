#!/usr/bin/env node
/**
 * Inject the API-key security contract into the generated OpenAPI specs.
 *
 * The sebuf `protoc-gen-openapiv3` plugin (proto/buf.gen.yaml) has no option or
 * annotation for describing authentication, so every generated spec omits
 * `components.securitySchemes`, a root `security` requirement, and the `401`
 * response — even though every WorldMonitor RPC is API-key-enforced at the
 * gateway (server/gateway.ts). This post-generation step adds them so the
 * published contract matches runtime reality. See umbrella issue #4599 (root
 * cause #1).
 *
 * Wired into `make generate` (runs after `buf generate`) and exposed as
 * `npm run gen:openapi:security`. Idempotent: re-running (or a fresh regenerate
 * followed by this step) yields byte-identical output.
 *
 * Two artifacts:
 *   1. docs/api/<Service>.openapi.json — full injection (schemes + root
 *      security + per-operation 401). Re-serialized byte-faithfully to the
 *      generator's format (recursively sorted keys, Go-style <>&/U+2028/U+2029
 *      escaping, no trailing newline) so the diff is additions-only.
 *   2. docs/api/worldmonitor.openapi.yaml — the bundle copied to
 *      public/openapi.yaml at build time. The generator's YAML emitter cannot
 *      be reproduced by js-yaml (a re-dump reformats ~100% of 21k lines), so
 *      the bundle gets a formatting-preserving surgical insertion of the two
 *      top-level blocks that convey global auth (`security` +
 *      `components.securitySchemes`). Per-operation detail in the bundle (the
 *      401 response and the `security: []` override on the handful of public
 *      RPCs) is intentionally left to native plugin support (tracked in #4599);
 *      the per-service specs carry the precise per-operation contract, and the
 *      bundle's root `security` documents the authenticated default.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const bundlePath = resolve(apiDir, 'worldmonitor.openapi.yaml');
const gatewayPath = resolve(root, 'server/gateway.ts');

const CHECK = process.argv.includes('--check');

// Genuinely public RPCs (no API key) — sourced from the single source of truth
// in server/gateway.ts so the two can never drift. These operations opt out of
// the root security requirement (security: []) and carry no 401. Fails closed:
// if the set can't be parsed, we refuse to run rather than mislabel a public
// endpoint as authenticated (or vice-versa).
function readPublicNoAuthPaths() {
  const src = readFileSync(gatewayPath, 'utf8');
  const block = src.match(/PUBLIC_NO_AUTH_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error(`could not locate PUBLIC_NO_AUTH_RPC_PATHS in ${gatewayPath}`);
  const paths = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error('PUBLIC_NO_AUTH_RPC_PATHS parsed as empty — refusing to run');
  return new Set(paths);
}
const PUBLIC_PATHS = readPublicNoAuthPaths();

// ── Contract definitions ──────────────────────────────────────────────────
// Header names mirror the gateway's accepted auth headers (server/gateway.ts:
// Authorization / X-WorldMonitor-Key / X-Api-Key) and docs/api-platform.mdx.
const SECURITY_SCHEMES = {
  WorldMonitorKey: {
    type: 'apiKey',
    in: 'header',
    name: 'X-WorldMonitor-Key',
    description: 'User-issued WorldMonitor API key.',
  },
  ApiKeyHeader: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Api-Key',
    description: 'Alias header for the WorldMonitor API key (X-WorldMonitor-Key).',
  },
  BearerAuth: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Bearer token: a Clerk-issued JWT (web sessions) or the relay shared secret, passed as Authorization: Bearer <token>.',
  },
};

// Root requirement — any ONE scheme satisfies it (OpenAPI OR semantics).
const ROOT_SECURITY = [
  { WorldMonitorKey: [] },
  { ApiKeyHeader: [] },
  { BearerAuth: [] },
];

const UNAUTHORIZED_SCHEMA = {
  type: 'object',
  description:
    'Returned when the API key is missing, malformed, or lacks current API access.',
  properties: {
    error: { type: 'string', description: 'Human-readable error message.' },
  },
  required: ['error'],
};

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid API key.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/UnauthorizedError' },
    },
  },
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

// ── Byte-faithful serializer (matches protoc-gen-openapiv3 JSON output) ─────
const sortRec = (x) =>
  Array.isArray(x)
    ? x.map(sortRec)
    : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortRec(x[k])]))
      : x;

const goEscape = (s) => {
  let r = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    r += c === 0x3c || c === 0x3e || c === 0x26 || c === 0x2028 || c === 0x2029
      ? '\\u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return r;
};

const serialize = (obj) => goEscape(JSON.stringify(sortRec(obj)));

// Order-insensitive deep-equal (keys are sorted before compare) so change
// detection is stable across the sort-on-write round-trip.
const eq = (a, b) => JSON.stringify(sortRec(a)) === JSON.stringify(sortRec(b));

// ── Per-service JSON injection ──────────────────────────────────────────────
function injectJson(spec) {
  let changed = false;
  spec.components ||= {};
  spec.components.schemas ||= {};

  if (!eq(spec.components.securitySchemes, SECURITY_SCHEMES)) {
    spec.components.securitySchemes = SECURITY_SCHEMES;
    changed = true;
  }
  if (!eq(spec.security, ROOT_SECURITY)) {
    spec.security = ROOT_SECURITY;
    changed = true;
  }
  if (!eq(spec.components.schemas.UnauthorizedError, UNAUTHORIZED_SCHEMA)) {
    spec.components.schemas.UnauthorizedError = UNAUTHORIZED_SCHEMA;
    changed = true;
  }
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const isPublic = PUBLIC_PATHS.has(path);
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      op.responses ||= {};
      if (isPublic) {
        // Public RPC: override the root requirement with an empty security
        // (marks the operation as unauthenticated) and carry no 401-for-missing-key.
        if (!eq(op.security, [])) { op.security = []; changed = true; }
        if (op.responses['401'] !== undefined) { delete op.responses['401']; changed = true; }
      } else {
        if (!eq(op.responses['401'], UNAUTHORIZED_RESPONSE)) {
          op.responses['401'] = UNAUTHORIZED_RESPONSE;
          changed = true;
        }
      }
    }
  }
  return changed;
}

// ── Bundle YAML surgical insertion (formatting-preserving) ───────────────────
// The bundle uses 4-space indentation with top-level keys at column 0.
function bundleSecurityBlock() {
  // Top-level `security:` list, 4-space list items to match `servers:` style.
  return [
    'security:',
    '    - WorldMonitorKey: []',
    '    - ApiKeyHeader: []',
    '    - BearerAuth: []',
  ].join('\n');
}

function bundleSecuritySchemesBlock() {
  // Child of top-level `components:` — 4-space key, 8-space scheme names,
  // 12-space fields. Field order kept stable for idempotency.
  const L = [];
  L.push('    securitySchemes:');
  L.push('        WorldMonitorKey:');
  L.push('            type: apiKey');
  L.push('            in: header');
  L.push('            name: X-WorldMonitor-Key');
  L.push('            description: User-issued WorldMonitor API key.');
  L.push('        ApiKeyHeader:');
  L.push('            type: apiKey');
  L.push('            in: header');
  L.push('            name: X-Api-Key');
  L.push('            description: Alias header for the WorldMonitor API key (X-WorldMonitor-Key).');
  L.push('        BearerAuth:');
  L.push('            type: http');
  L.push('            scheme: bearer');
  L.push(
    '            description: \'Bearer token: a Clerk-issued JWT (web sessions) or the relay shared secret, passed as Authorization: Bearer <token>.\'',
  );
  return L.join('\n');
}

function injectBundle(text) {
  const hasSecurity = /^security:$/m.test(text);
  const hasSchemes = /^    securitySchemes:$/m.test(text);
  if (hasSecurity && hasSchemes) return { text, changed: false };

  const lines = text.split('\n');
  const out = [];
  let insertedSchemes = hasSchemes;
  let insertedSecurity = hasSecurity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Insert root `security:` immediately before top-level `paths:`.
    if (!insertedSecurity && line === 'paths:') {
      out.push(bundleSecurityBlock());
      insertedSecurity = true;
    }
    out.push(line);
    // Insert `securitySchemes:` as the first child under top-level `components:`.
    if (!insertedSchemes && line === 'components:') {
      out.push(bundleSecuritySchemesBlock());
      insertedSchemes = true;
    }
  }

  if (!insertedSecurity) throw new Error('bundle: could not find top-level `paths:` anchor for security block');
  if (!insertedSchemes) throw new Error('bundle: could not find top-level `components:` anchor for securitySchemes block');
  return { text: out.join('\n'), changed: true };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const specFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
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

// Bundle (optional — only if present)
let bundleChanged = false;
try {
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  const { text, changed } = injectBundle(bundleRaw);
  bundleChanged = changed;
  if (changed) {
    wouldChange++;
    touched.push('worldmonitor.openapi.yaml');
    if (!CHECK) writeFileSync(bundlePath, text);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

if (CHECK) {
  if (wouldChange > 0) {
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the security contract: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:security');
    process.exit(1);
  }
  console.log(`✓ all ${specFiles.length} specs + bundle carry the security contract`);
} else {
  console.log(
    `openapi-inject-security: updated ${wouldChange} artifact(s) — ${specFiles.length} specs scanned, bundle ${bundleChanged ? 'updated' : 'unchanged'}`,
  );
}
