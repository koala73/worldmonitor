#!/usr/bin/env node
/**
 * Inject the auth security contract into the generated OpenAPI specs.
 *
 * The sebuf `protoc-gen-openapiv3` plugin (proto/buf.gen.yaml) has no option or
 * annotation for describing authentication, so every generated spec omits
 * `components.securitySchemes`, a root `security` requirement, and the `401`
 * response — even though every non-public WorldMonitor RPC is authenticated at
 * the gateway (server/gateway.ts). This post-generation step adds them so the
 * published contract matches runtime reality. See umbrella issue #4599 (root
 * cause #1).
 *
 * Wired into `make generate` (runs after `buf generate`) and exposed as
 * `npm run gen:openapi:security`. Idempotent: re-running (or a fresh regenerate
 * followed by this step) yields byte-identical output.
 *
 * Two artifact families:
 *   1. docs/api/<Service>.openapi.json — full injection (schemes + root
 *      API-key security + per-operation bearer overrides where the gateway
 *      accepts Clerk bearer auth + per-operation 401 + entitlement/public 403
 *      responses/notes). Re-serialized byte-faithfully to the generator's
 *      format (recursively sorted keys, Go-style <>&/U+2028/U+2029 escaping, no
 *      trailing newline) so the diff is additions-only.
 *   2. docs/api/<Service>.openapi.yaml and docs/api/worldmonitor.openapi.yaml —
 *      docs-facing YAML (the bundle is copied to public/openapi.yaml at build).
 *      The generator's YAML emitter cannot be reproduced by js-yaml (a re-dump
 *      reformats ~100% of 21k lines), so YAML gets formatting-preserving
 *      surgical insertions. Each YAML artifact receives the SAME contract its
 *      JSON sibling carries (#4650): top-level securitySchemes (2 or 3 by
 *      bearer-path presence) + root API-key security + the UnauthorizedError
 *      schema + per-operation 401 / public security:[] opt-outs / bearer
 *      stamping, then per-operation entitlement/public 403 responses and notes.
 *      Like the sibling injectors this runs in the `make generate` codegen
 *      context (no npm deps guaranteed), so it has no external imports: paths
 *      are enumerated by text scan and all writes are surgical text insertions.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const bundlePath = resolve(apiDir, 'worldmonitor.openapi.yaml');
const gatewayPath = resolve(root, 'server/gateway.ts');
const entitlementPath = resolve(root, 'server/_shared/entitlement-check.ts');
const premiumPathsPath = resolve(root, 'src/shared/premium-paths.ts');

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

// Bearer auth is not a universal replacement for an API key. The gateway only
// resolves Clerk bearer sessions for endpoint-entitlement gates and legacy Pro
// paths, so stamp BearerAuth at operation level only for those exact paths.
function readEndpointEntitlements() {
  const src = readFileSync(entitlementPath, 'utf8');
  const block = src.match(/ENDPOINT_ENTITLEMENTS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error(`could not locate ENDPOINT_ENTITLEMENTS in ${entitlementPath}`);
  const entries = [...block[1].matchAll(/'([^']+)'\s*:\s*(\d+)/g)]
    .map((m) => [m[1], Number(m[2])]);
  if (entries.length === 0) throw new Error('ENDPOINT_ENTITLEMENTS parsed as empty — refusing to run');
  return new Map(entries);
}

function readPremiumRpcPaths() {
  const src = readFileSync(premiumPathsPath, 'utf8');
  const block = src.match(/PREMIUM_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error(`could not locate PREMIUM_RPC_PATHS in ${premiumPathsPath}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const ENDPOINT_ENTITLEMENTS = readEndpointEntitlements();
const ENDPOINT_ENTITLEMENT_PATHS = new Set(ENDPOINT_ENTITLEMENTS.keys());
const BEARER_AUTH_PATHS = new Set([...ENDPOINT_ENTITLEMENT_PATHS, ...readPremiumRpcPaths()]);
if (BEARER_AUTH_PATHS.size === 0) {
  throw new Error('bearer-auth path sources parsed as empty — refusing to run');
}

// Public RPCs can still have documented 403 gates. Lead capture intentionally
// opts out of API-key auth at the gateway, then fails closed in the handler when
// Cloudflare Turnstile verification fails.
const PUBLIC_FORBIDDEN_GATES = new Map([
  ['/api/leads/v1/submit-contact', {
    note: 'Turnstile-gated. Missing or invalid Cloudflare Turnstile token returns 403 Bot verification failed.',
    response: {
      description: 'Bot verification failed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  }],
]);

// ── Contract definitions ──────────────────────────────────────────────────
// Header names mirror the gateway's accepted public API-key headers
// (server/gateway.ts: X-WorldMonitor-Key / X-Api-Key) and docs/api-platform.mdx.
const API_KEY_SECURITY_SCHEMES = {
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
};

const SECURITY_SCHEMES = {
  ...API_KEY_SECURITY_SCHEMES,
  BearerAuth: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Bearer token: a Clerk-issued JWT for browser session flows, passed as Authorization: Bearer <token>.',
  },
};

// Root requirement — any ONE API-key scheme satisfies it (OpenAPI OR
// semantics). BearerAuth is narrower and is stamped only on operations the
// gateway actually accepts bearer sessions for.
const ROOT_SECURITY = [
  { WorldMonitorKey: [] },
  { ApiKeyHeader: [] },
];

const BEARER_OPERATION_SECURITY = [
  ...ROOT_SECURITY,
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

const FORBIDDEN_SCHEMA = {
  type: 'object',
  description:
    'Returned when a PRO-gated endpoint denies access because the caller has no resolved authenticated user, entitlements cannot be verified, or the caller lacks the required entitlement tier.',
  properties: {
    error: { type: 'string', description: 'Human-readable entitlement failure reason.' },
    requiredTier: {
      type: 'integer',
      format: 'int32',
      description: 'Minimum entitlement tier required for this endpoint.',
    },
    currentTier: {
      type: 'integer',
      format: 'int32',
      description: 'Caller entitlement tier when known.',
    },
    planKey: { type: 'string', description: 'Caller plan key when known.' },
  },
  required: ['error'],
};

const FORBIDDEN_RESPONSE = {
  description: 'PRO entitlement access denied.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ForbiddenError' },
    },
  },
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function entitlementNote(requiredTier) {
  return `PRO-gated. Requires entitlement tier >= ${requiredTier}.`;
}

function appendEntitlementNote(description, requiredTier) {
  const note = entitlementNote(requiredTier);
  const text = String(description ?? '').trim();
  if (!text) return note;
  if (/Requires entitlement tier >= \d+/i.test(text)) return text;
  if (/PRO-gated/i.test(text)) return `${text} Requires entitlement tier >= ${requiredTier}.`;
  return `${text} ${note}`;
}

function appendGateNote(description, note) {
  const text = String(description ?? '').trim();
  if (!text) return note;
  if (text.includes(note)) return text;
  return `${text} ${note}`;
}

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

  const hasBearerAuthPath = Object.keys(spec.paths ?? {}).some((path) => BEARER_AUTH_PATHS.has(path));
  const expectedSecuritySchemes = hasBearerAuthPath ? SECURITY_SCHEMES : API_KEY_SECURITY_SCHEMES;
  if (!eq(spec.components.securitySchemes, expectedSecuritySchemes)) {
    spec.components.securitySchemes = expectedSecuritySchemes;
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
  const hasEntitlementPath = Object.keys(spec.paths ?? {}).some((path) => ENDPOINT_ENTITLEMENTS.has(path));
  if (hasEntitlementPath && !eq(spec.components.schemas.ForbiddenError, FORBIDDEN_SCHEMA)) {
    spec.components.schemas.ForbiddenError = FORBIDDEN_SCHEMA;
    changed = true;
  }
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const isPublic = PUBLIC_PATHS.has(path);
    const requiredTier = ENDPOINT_ENTITLEMENTS.get(path);
    const isEntitlementGated = requiredTier !== undefined;
    const publicForbiddenGate = PUBLIC_FORBIDDEN_GATES.get(path);
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      op.responses ||= {};
      if (isPublic) {
        // Public RPC: override the root requirement with an empty security
        // (marks the operation as unauthenticated) and carry no 401-for-missing-key.
        if (!eq(op.security, [])) { op.security = []; changed = true; }
        if (op.responses['401'] !== undefined) { delete op.responses['401']; changed = true; }
        if (publicForbiddenGate) {
          const nextDescription = appendGateNote(op.description, publicForbiddenGate.note);
          if (op.description !== nextDescription) {
            op.description = nextDescription;
            changed = true;
          }
          if (!eq(op.responses['403'], publicForbiddenGate.response)) {
            op.responses['403'] = publicForbiddenGate.response;
            changed = true;
          }
        }
      } else {
        if (BEARER_AUTH_PATHS.has(path)) {
          if (!eq(op.security, BEARER_OPERATION_SECURITY)) {
            op.security = BEARER_OPERATION_SECURITY;
            changed = true;
          }
        } else if (op.security !== undefined) {
          delete op.security;
          changed = true;
        }
        if (!eq(op.responses['401'], UNAUTHORIZED_RESPONSE)) {
          op.responses['401'] = UNAUTHORIZED_RESPONSE;
          changed = true;
        }
        if (isEntitlementGated) {
          const nextDescription = appendEntitlementNote(op.description, requiredTier);
          if (op.description !== nextDescription) {
            op.description = nextDescription;
            changed = true;
          }
          if (!eq(op.responses['403'], FORBIDDEN_RESPONSE)) {
            op.responses['403'] = FORBIDDEN_RESPONSE;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

// ── Shared YAML auth-contract insertion (formatting-preserving) ──────────────
// YAML artifacts use 4-space indentation with top-level keys at column 0. The
// same helpers serve both the per-service YAML files and the bundle so every
// YAML artifact reaches parity with its JSON sibling (#4650).
function yamlRootSecurityBlock() {
  // Top-level `security:` list (API-key schemes only, matching ROOT_SECURITY);
  // 4-space list items to match the bundle's `servers:` style.
  return [
    'security:',
    '    - WorldMonitorKey: []',
    '    - ApiKeyHeader: []',
  ].join('\n');
}

function yamlSecuritySchemesBlock(hasBearer) {
  // Child of top-level `components:` — 4-space key, 8-space scheme names,
  // 12-space fields. BearerAuth is appended only when the artifact has a
  // bearer-capable operation, mirroring expectedSchemesForSpec in the JSON path.
  const L = [
    '    securitySchemes:',
    '        WorldMonitorKey:',
    '            type: apiKey',
    '            in: header',
    '            name: X-WorldMonitor-Key',
    '            description: User-issued WorldMonitor API key.',
    '        ApiKeyHeader:',
    '            type: apiKey',
    '            in: header',
    '            name: X-Api-Key',
    '            description: Alias header for the WorldMonitor API key (X-WorldMonitor-Key).',
  ];
  if (hasBearer) {
    L.push(
      '        BearerAuth:',
      '            type: http',
      '            scheme: bearer',
      "            description: 'Bearer token: a Clerk-issued JWT for browser session flows, passed as Authorization: Bearer <token>.'",
    );
  }
  return L.join('\n');
}

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

function findComponentsChildBlock(lines, key) {
  const componentsIndex = lines.indexOf('components:');
  if (componentsIndex === -1) {
    return { componentsIndex, block: null };
  }
  for (let i = componentsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    if (line !== `    ${key}:`) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next && !next.startsWith(' ') && !next.startsWith('\t')) break;
      if (/^ {4}[^ ].*:/.test(next)) break;
      end++;
    }
    return { componentsIndex, block: { start: i, end, text: lines.slice(i, end).join('\n') } };
  }
  return { componentsIndex, block: null };
}

function ensureYamlRootSecurity(lines) {
  const expected = yamlRootSecurityBlock();
  const block = findTopLevelBlock(lines, 'security');
  if (block) {
    if (block.text === expected) return false;
    lines.splice(block.start, block.end - block.start, ...expected.split('\n'));
    return true;
  }
  // Insert root `security:` immediately before top-level `paths:`.
  const pathsIndex = lines.indexOf('paths:');
  if (pathsIndex === -1) throw new Error('yaml: could not find top-level `paths:` anchor for security block');
  lines.splice(pathsIndex, 0, ...expected.split('\n'));
  return true;
}

function ensureYamlSecuritySchemes(lines, hasBearer) {
  const expected = yamlSecuritySchemesBlock(hasBearer);
  const { componentsIndex, block } = findComponentsChildBlock(lines, 'securitySchemes');
  if (componentsIndex === -1) {
    throw new Error('yaml: could not find top-level `components:` anchor for securitySchemes block');
  }
  if (block) {
    if (block.text === expected) return false;
    lines.splice(block.start, block.end - block.start, ...expected.split('\n'));
    return true;
  }
  // Insert `securitySchemes:` as the first child under top-level `components:`.
  lines.splice(componentsIndex + 1, 0, ...expected.split('\n'));
  return true;
}

// ── Service/bundle YAML entitlement insertion (formatting-preserving) ────────
const YAML_METHOD_LINE_RE = /^        (get|post|put|delete|patch|options|head):$/;

const YAML_FORBIDDEN_RESPONSE = [
  '                "403":',
  '                    description: PRO entitlement access denied.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/ForbiddenError'",
];

const YAML_BOT_FORBIDDEN_RESPONSE = [
  '                "403":',
  '                    description: Bot verification failed.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/Error'",
];

const YAML_FORBIDDEN_SCHEMA = [
  '        ForbiddenError:',
  '            type: object',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable entitlement failure reason.',
  '                requiredTier:',
  '                    type: integer',
  '                    format: int32',
  '                    description: Minimum entitlement tier required for this endpoint.',
  '                currentTier:',
  '                    type: integer',
  '                    format: int32',
  '                    description: Caller entitlement tier when known.',
  '                planKey:',
  '                    type: string',
  '                    description: Caller plan key when known.',
  '            required:',
  '                - error',
  '            description: Returned when a PRO-gated endpoint denies access because the caller has no resolved authenticated user, entitlements cannot be verified, or the caller lacks the required entitlement tier.',
];

const YAML_UNAUTHORIZED_RESPONSE = [
  '                "401":',
  '                    description: Missing or invalid API key.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/UnauthorizedError'",
];

const YAML_UNAUTHORIZED_SCHEMA = [
  '        UnauthorizedError:',
  '            type: object',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable error message.',
  '            required:',
  '                - error',
  '            description: Returned when the API key is missing, malformed, or lacks current API access.',
];

// Operation-level security list items (16-space `-` under a 12-space `security:`).
const YAML_BEARER_OPERATION_SECURITY = [
  '            security:',
  '                - WorldMonitorKey: []',
  '                - ApiKeyHeader: []',
  '                - BearerAuth: []',
];

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

function findYamlOperationRange(lines, path) {
  const range = findYamlPathRange(lines, path);
  if (!range) return null;
  const methodIndex = lines.findIndex((line, index) => (
    index > range.start && index < range.end && YAML_METHOD_LINE_RE.test(line)
  ));
  if (methodIndex === -1) return null;
  return { start: methodIndex, end: range.end };
}

function yamlBlockNote(existingText, requiredTier) {
  return /PRO-gated/i.test(existingText)
    ? `Requires entitlement tier >= ${requiredTier}.`
    : entitlementNote(requiredTier);
}

function ensureYamlEntitlementDescription(lines, path, requiredTier) {
  const op = findYamlOperationRange(lines, path);
  if (!op) return false;
  const descIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            description:')
  ));

  if (descIndex === -1) {
    const operationIdIndex = lines.findIndex((line, index) => (
      index > op.start && index < op.end && line.startsWith('            operationId:')
    ));
    const insertAt = operationIdIndex === -1 ? op.start + 1 : operationIdIndex;
    lines.splice(insertAt, 0, `            description: ${entitlementNote(requiredTier)}`);
    return true;
  }

  const line = lines[descIndex];
  if (/^ {12}description:\s*[|>]/.test(line)) {
    let blockEnd = descIndex + 1;
    while (blockEnd < lines.length) {
      const next = lines[blockEnd];
      if (next && !next.startsWith('                ')) break;
      blockEnd++;
    }
    const blockText = lines.slice(descIndex, blockEnd).join('\n');
    if (/Requires entitlement tier >= \d+/i.test(blockText)) return false;
    lines.splice(blockEnd, 0, `                ${yamlBlockNote(blockText, requiredTier)}`);
    return true;
  }

  const prefix = '            description: ';
  if (!line.startsWith(prefix)) return false;
  const current = line.slice(prefix.length);
  const next = appendEntitlementNote(current, requiredTier);
  if (next === current) return false;
  lines[descIndex] = prefix + next;
  return true;
}

function ensureYamlGateDescription(lines, path, note) {
  const op = findYamlOperationRange(lines, path);
  if (!op) return false;
  const descIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            description:')
  ));

  if (descIndex === -1) {
    const operationIdIndex = lines.findIndex((line, index) => (
      index > op.start && index < op.end && line.startsWith('            operationId:')
    ));
    const insertAt = operationIdIndex === -1 ? op.start + 1 : operationIdIndex;
    lines.splice(insertAt, 0, `            description: ${note}`);
    return true;
  }

  const line = lines[descIndex];
  if (/^ {12}description:\s*[|>]/.test(line)) {
    let blockEnd = descIndex + 1;
    while (blockEnd < lines.length) {
      const next = lines[blockEnd];
      if (next && !next.startsWith('                ')) break;
      blockEnd++;
    }
    const blockText = lines.slice(descIndex, blockEnd).join('\n');
    if (blockText.includes(note)) return false;
    lines.splice(blockEnd, 0, `                ${note}`);
    return true;
  }

  const prefix = '            description: ';
  if (!line.startsWith(prefix)) return false;
  const current = line.slice(prefix.length);
  const next = appendGateNote(current, note);
  if (next === current) return false;
  lines[descIndex] = prefix + next;
  return true;
}

function findYamlResponseRange(lines, op, statusLine) {
  const start = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === statusLine
  ));
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

function ensureYamlForbiddenResponse(lines, path, responseLines = YAML_FORBIDDEN_RESPONSE) {
  const op = findYamlOperationRange(lines, path);
  if (!op) return false;

  const expected = responseLines.join('\n');
  const existing = findYamlResponseRange(lines, op, '                "403":');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...responseLines);
    return true;
  }

  const responsesIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === '            responses:'
  ));
  if (responsesIndex === -1) return false;

  let responseEnd = responsesIndex + 1;
  while (responseEnd < op.end) {
    const line = lines[responseEnd];
    if (line && !line.startsWith('                ')) break;
    responseEnd++;
  }

  const defaultIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                default:'
  ));
  const insertAt = defaultIndex === -1 ? responseEnd : defaultIndex;
  lines.splice(insertAt, 0, ...responseLines);
  return true;
}
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

function ensureYamlForbiddenSchema(lines) {
  const existing = findYamlSchemaRange(lines, 'ForbiddenError');
  if (existing) {
    const expected = YAML_FORBIDDEN_SCHEMA.join('\n');
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...YAML_FORBIDDEN_SCHEMA);
    return true;
  }
  const schemasIndex = lines.indexOf('    schemas:');
  if (schemasIndex === -1) return false;

  const errorIndex = lines.findIndex((line, index) => index > schemasIndex && line === '        Error:');
  if (errorIndex === -1) {
    lines.splice(schemasIndex + 1, 0, ...YAML_FORBIDDEN_SCHEMA);
    return true;
  }

  let insertAt = errorIndex + 1;
  while (insertAt < lines.length) {
    const line = lines[insertAt];
    if (line && /^ {8}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('            ')) break;
    insertAt++;
  }
  lines.splice(insertAt, 0, ...YAML_FORBIDDEN_SCHEMA);
  return true;
}

function injectYamlEntitlementContract(text) {
  const lines = text.split('\n');
  let changed = false;
  let matchedEntitlementPath = false;

  for (const [path, requiredTier] of ENDPOINT_ENTITLEMENTS) {
    if (!findYamlPathRange(lines, path)) continue;
    matchedEntitlementPath = true;
    changed = ensureYamlEntitlementDescription(lines, path, requiredTier) || changed;
    changed = ensureYamlForbiddenResponse(lines, path) || changed;
  }

  if (matchedEntitlementPath) {
    changed = ensureYamlForbiddenSchema(lines) || changed;
  }

  for (const [path, gate] of PUBLIC_FORBIDDEN_GATES) {
    if (!findYamlPathRange(lines, path)) continue;
    changed = ensureYamlGateDescription(lines, path, gate.note) || changed;
    changed = ensureYamlForbiddenResponse(lines, path, YAML_BOT_FORBIDDEN_RESPONSE) || changed;
  }

  return { text: lines.join('\n'), changed };
}

function ensureYamlUnauthorizedSchema(lines) {
  const existing = findYamlSchemaRange(lines, 'UnauthorizedError');
  if (existing) {
    const expected = YAML_UNAUTHORIZED_SCHEMA.join('\n');
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...YAML_UNAUTHORIZED_SCHEMA);
    return true;
  }
  const schemasIndex = lines.indexOf('    schemas:');
  if (schemasIndex === -1) return false;
  lines.splice(schemasIndex + 1, 0, ...YAML_UNAUTHORIZED_SCHEMA);
  return true;
}

// Method-scoped operation range (a path may carry more than one HTTP method,
// e.g. /api/v2/shipping/webhooks has both get and post).
function findYamlOperationRangeForMethod(lines, path, method) {
  const range = findYamlPathRange(lines, path);
  if (!range) return null;
  const methodLine = `        ${method}:`;
  const methodIndex = lines.findIndex((line, index) => (
    index > range.start && index < range.end && line === methodLine
  ));
  if (methodIndex === -1) return null;
  let end = range.end;
  for (let i = methodIndex + 1; i < range.end; i++) {
    if (YAML_METHOD_LINE_RE.test(lines[i])) { end = i; break; }
  }
  return { start: methodIndex, end };
}

function ensureYamlUnauthorizedResponse(lines, path, method) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;

  const expected = YAML_UNAUTHORIZED_RESPONSE.join('\n');
  const existing = findYamlResponseRange(lines, op, '                "401":');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...YAML_UNAUTHORIZED_RESPONSE);
    return true;
  }

  const responsesIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === '            responses:'
  ));
  if (responsesIndex === -1) return false;

  let responseEnd = responsesIndex + 1;
  while (responseEnd < op.end) {
    const line = lines[responseEnd];
    if (line && !line.startsWith('                ')) break;
    responseEnd++;
  }

  // Insert 401 before the 403 when present, else before `default:`. Anchoring
  // on 403 makes the pass order-independent: whether the entitlement 403 is
  // already present (running over an injected baseline) or added afterwards
  // (fresh `make generate`, security-first), the order stays 2xx → 401 → 403 →
  // default, so a hand-run and a full regenerate produce identical bytes.
  const forbiddenIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                "403":'
  ));
  const defaultIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                default:'
  ));
  const insertAt = forbiddenIndex !== -1
    ? forbiddenIndex
    : (defaultIndex === -1 ? responseEnd : defaultIndex);
  lines.splice(insertAt, 0, ...YAML_UNAUTHORIZED_RESPONSE);
  return true;
}

function findYamlOperationSecurityRange(lines, op) {
  const start = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            security:')
  ));
  if (start === -1) return null;
  // `security: []` is a single inline line; the bearer form is a block of
  // 16-space list items.
  if (lines[start] === '            security: []') return { start, end: start + 1 };
  let end = start + 1;
  while (end < op.end) {
    const line = lines[end];
    if (line && !line.startsWith('                ')) break;
    end++;
  }
  return { start, end };
}

// kind: 'public' → `security: []` (opt out); 'bearer' → API-key + BearerAuth list.
function ensureYamlOperationSecurity(lines, path, method, kind) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const desired = kind === 'public' ? ['            security: []'] : YAML_BEARER_OPERATION_SECURITY;

  const existing = findYamlOperationSecurityRange(lines, op);
  if (existing) {
    if (lines.slice(existing.start, existing.end).join('\n') === desired.join('\n')) return false;
    lines.splice(existing.start, existing.end - existing.start, ...desired);
    return true;
  }

  const operationIdIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            operationId:')
  ));
  const insertAt = operationIdIndex === -1 ? op.start + 1 : operationIdIndex + 1;
  lines.splice(insertAt, 0, ...desired);
  return true;
}

// Enumerate operations by text scan (no YAML parser): a path is a 4-space key
// beginning with `/`; its methods are the 8-space HTTP-verb keys inside the
// path block (which ends at the next path or any shallower-indented line,
// matching findYamlPathRange). Handles multi-method paths.
function enumerateYamlOperations(lines) {
  const operations = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {4}(\/\S+):$/);
    if (!match) continue;
    const methods = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line && !line.startsWith('        ')) break;
      const methodMatch = line.match(YAML_METHOD_LINE_RE);
      if (methodMatch) methods.push(methodMatch[1]);
    }
    if (methods.length > 0) operations.push({ path: match[1], methods });
  }
  return operations;
}

// Full auth contract for a YAML artifact (per-service YAML or the bundle),
// mirroring injectJson: top-level securitySchemes (2 or 3 by bearer-path
// presence) + root API-key security + UnauthorizedError schema + per-operation
// 401 / public security:[] opt-outs / bearer stamping.
function injectYamlAuthContract(text) {
  const lines = text.split('\n');
  let changed = false;

  const operations = enumerateYamlOperations(lines);
  const hasBearer = operations.some(({ path }) => BEARER_AUTH_PATHS.has(path));

  changed = ensureYamlRootSecurity(lines) || changed;
  changed = ensureYamlSecuritySchemes(lines, hasBearer) || changed;
  changed = ensureYamlUnauthorizedSchema(lines) || changed;

  for (const { path, methods } of operations) {
    for (const method of methods) {
      if (PUBLIC_PATHS.has(path)) {
        // Public RPC: opt out of the root requirement, carry no 401.
        changed = ensureYamlOperationSecurity(lines, path, method, 'public') || changed;
      } else {
        changed = ensureYamlUnauthorizedResponse(lines, path, method) || changed;
        if (BEARER_AUTH_PATHS.has(path)) {
          changed = ensureYamlOperationSecurity(lines, path, method, 'bearer') || changed;
        }
      }
    }
  }

  return { text: lines.join('\n'), changed };
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
  const authResult = injectYamlAuthContract(raw);
  const entitlementResult = injectYamlEntitlementContract(authResult.text);
  if (authResult.changed || entitlementResult.changed) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, entitlementResult.text);
  }
}

// Bundle (optional — only if present)
let bundleChanged = false;
try {
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  const authResult = injectYamlAuthContract(bundleRaw);
  const entitlementResult = injectYamlEntitlementContract(authResult.text);
  bundleChanged = authResult.changed || entitlementResult.changed;
  if (bundleChanged) {
    wouldChange++;
    touched.push('worldmonitor.openapi.yaml');
    if (!CHECK) writeFileSync(bundlePath, entitlementResult.text);
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
  console.log(`✓ all ${specFiles.length} JSON specs, ${serviceYamlFiles.length} YAML specs + bundle carry the security contract`);
} else {
  console.log(
    `openapi-inject-security: updated ${wouldChange} artifact(s) — ${specFiles.length} JSON specs, ${serviceYamlFiles.length} YAML specs scanned, bundle ${bundleChanged ? 'updated' : 'unchanged'}`,
  );
}
