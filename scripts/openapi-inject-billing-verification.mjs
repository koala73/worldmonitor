#!/usr/bin/env node
/**
 * Inject the billing-verification 503 contract into OpenAPI (#5447 wire contract).
 *
 * Every authenticated (non-public) REST operation can be answered by the
 * gateway or an entitlement gate with a retryable 503 while paid access is
 * being re-confirmed with the billing provider (renewal_verification_pending /
 * renewal_verification_failed) or while the entitlement backend is unreachable
 * (entitlement_verification_unavailable). The response carries Retry-After
 * (1-60s), an X-Billing-Verification header mirroring the body `code`, and an
 * {error, code, requiredTier?} JSON body. protoc-gen-openapiv3 cannot express
 * this, so it is stamped post-generation like the sibling injectors.
 * Idempotent and byte-faithful for JSON; YAML uses formatting-preserving
 * surgical replacement. Order-independent vs the other openapi-inject-* passes:
 * no other injector writes a 503 response or the BillingVerificationError
 * schema, and this one writes nothing else.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, serialize, readPublicNoAuthPaths, readRetryableBillingCodes } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = process.env.WM_OPENAPI_API_DIR
  ? resolve(process.env.WM_OPENAPI_API_DIR)
  : resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const PUBLIC_PATHS = readPublicNoAuthPaths();
const RETRYABLE_BILLING_CODES = readRetryableBillingCodes();

const BILLING_VERIFICATION_ERROR_SCHEMA = {
  type: 'object',
  description:
    'Returned with HTTP 503 when paid access cannot be confirmed right now: the billing provider is re-verifying a recently expired subscription, or the entitlement backend is unreachable. Retryable — honor Retry-After.',
  properties: {
    error: {
      type: 'string',
      description: 'Human-readable billing-verification failure reason.',
    },
    code: {
      type: 'string',
      enum: RETRYABLE_BILLING_CODES,
      description: 'Machine-readable billing-verification state, mirrored in the X-Billing-Verification response header.',
    },
    requiredTier: {
      type: 'integer',
      format: 'int32',
      description: 'Minimum entitlement tier required for this endpoint, when the denial came from a tier gate.',
    },
  },
  required: ['error', 'code'],
};

const BILLING_VERIFICATION_RESPONSE = {
  description:
    'Service unavailable. Billing-verification responses include code and X-Billing-Verification; other gateway infrastructure failures use the generic GatewayError shape.',
  headers: {
    'Retry-After': {
      description: 'Seconds to wait before retrying (1-60).',
      schema: { type: 'string' },
    },
    'X-Billing-Verification': {
      description: 'Billing-verification state that produced this response (matches the body `code`).',
      schema: { type: 'string' },
    },
    'X-Validation-Mode': {
      description: 'Present with value degraded when user API-key validation is temporarily unavailable.',
      schema: { type: 'string' },
    },
    'X-RateLimit-Mode': {
      description: 'Present with value degraded when a fail-closed rate-limit dependency is unavailable.',
      schema: { type: 'string' },
    },
  },
  content: {
    'application/json': {
      schema: {
        oneOf: [
          { $ref: '#/components/schemas/BillingVerificationError' },
          { $ref: '#/components/schemas/GatewayError' },
        ],
      },
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Per-service JSON injection ──────────────────────────────────────────────
function injectJson(spec) {
  let changed = false;
  // BillingVerificationError backs the 503 that only NON-public ops carry —
  // gate the shared schema on the spec having at least one, mirroring how the
  // security injector gates ForbiddenError/UnauthorizedError so all-public
  // specs (Leads/Natural/Seismology/Unrest) don't grow an orphaned schema.
  const hasNonPublicOp = Object.keys(spec.paths ?? {}).some((path) => !PUBLIC_PATHS.has(path));
  if (hasNonPublicOp) {
    spec.components ||= {};
    spec.components.schemas ||= {};
    if (!eq(spec.components.schemas.BillingVerificationError, BILLING_VERIFICATION_ERROR_SCHEMA)) {
      spec.components.schemas.BillingVerificationError = clone(BILLING_VERIFICATION_ERROR_SCHEMA);
      changed = true;
    }
  }
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (PUBLIC_PATHS.has(path) || !ops || typeof ops !== 'object') continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      op.responses ||= {};
      if (!eq(op.responses['503'], BILLING_VERIFICATION_RESPONSE)) {
        op.responses['503'] = clone(BILLING_VERIFICATION_RESPONSE);
        changed = true;
      }
    }
  }
  return changed;
}

// ── YAML injection (formatting-preserving, mirrors sibling injectors) ────────
const YAML_BILLING_VERIFICATION_SCHEMA = [
  '        BillingVerificationError:',
  '            type: object',
  '            description: "Returned with HTTP 503 when paid access cannot be confirmed right now: the billing provider is re-verifying a recently expired subscription, or the entitlement backend is unreachable. Retryable — honor Retry-After."',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable billing-verification failure reason.',
  '                code:',
  '                    type: string',
  '                    enum:',
  ...RETRYABLE_BILLING_CODES.map((code) => `                        - ${code}`),
  '                    description: Machine-readable billing-verification state, mirrored in the X-Billing-Verification response header.',
  '                requiredTier:',
  '                    type: integer',
  '                    format: int32',
  '                    description: Minimum entitlement tier required for this endpoint, when the denial came from a tier gate.',
  '            required:',
  '                - error',
  '                - code',
];

const YAML_503_RESPONSE = [
  '                "503":',
  '                    description: Service unavailable. Billing-verification responses include code and X-Billing-Verification; other gateway infrastructure failures use the generic GatewayError shape.',
  '                    headers:',
  '                        Retry-After:',
  '                            description: Seconds to wait before retrying (1-60).',
  '                            schema:',
  '                                type: string',
  '                        X-Billing-Verification:',
  '                            description: Billing-verification state that produced this response (matches the body `code`).',
  '                            schema:',
  '                                type: string',
  '                        X-Validation-Mode:',
  '                            description: Present with value degraded when user API-key validation is temporarily unavailable.',
  '                            schema:',
  '                                type: string',
  '                        X-RateLimit-Mode:',
  '                            description: Present with value degraded when a fail-closed rate-limit dependency is unavailable.',
  '                            schema:',
  '                                type: string',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  '                                oneOf:',
  "                                    - $ref: '#/components/schemas/BillingVerificationError'",
  "                                    - $ref: '#/components/schemas/GatewayError'",
];

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

const YAML_METHOD_LINE_RE = /^ {8}(get|post|put|delete|patch|options|head):$/;

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

function ensureYaml503Response(lines, op) {
  const existing = findYamlResponseRange(lines, op, '                "503":');
  const expected = YAML_503_RESPONSE.join('\n');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...YAML_503_RESPONSE);
    return true;
  }
  const responses = findYamlResponsesEnd(lines, op);
  if (!responses) return false;
  const beforeIndex = lines.findIndex((line, index) =>
    index > responses.responsesIndex && index < responses.end && line === '                default:');
  const insertAt = beforeIndex === -1 ? responses.end : beforeIndex;
  lines.splice(insertAt, 0, ...YAML_503_RESPONSE);
  return true;
}

function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;
  const nonPublicOps = enumerateYamlOperations(lines).filter(({ path }) => !PUBLIC_PATHS.has(path));
  if (nonPublicOps.length > 0) {
    changed = ensureYamlSchema(lines, 'BillingVerificationError', YAML_BILLING_VERIFICATION_SCHEMA) || changed;
  }
  for (const { path, method } of nonPublicOps) {
    const op = findYamlOperationRange(lines, path, method);
    if (!op) continue;
    changed = ensureYaml503Response(lines, op) || changed;
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
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the billing-verification 503 contract: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:billing-verification');
    process.exit(1);
  }
  console.log('✓ billing-verification 503 contract present on every authenticated OpenAPI operation');
} else {
  console.log(`openapi-inject-billing-verification: updated ${wouldChange} artifact(s)`);
}
