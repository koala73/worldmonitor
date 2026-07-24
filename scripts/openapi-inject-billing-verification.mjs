#!/usr/bin/env node
/**
 * Document the billing-verification failures emitted by the gateway and
 * entitlement checks. Runtime handlers return retryable 503s with a machine-
 * readable code, Retry-After, and X-Billing-Verification; generated OpenAPI
 * otherwise only sees the proto-declared success and validation responses.
 *
 * This pass is deliberately separate from auth/security injection so it has an
 * independent freshness check and can be run after a clean buf generation.
 * JSON is serialized byte-faithfully; YAML is edited with formatting-preserving
 * surgical insertions. Both paths are idempotent.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  eq,
  serialize,
  readPublicNoAuthPaths,
  readBillingVerificationCodes,
} from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = process.env.WM_OPENAPI_API_DIR
  ? resolve(process.env.WM_OPENAPI_API_DIR)
  : resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const PUBLIC_PATHS = readPublicNoAuthPaths();
const BILLING_CODES = readBillingVerificationCodes();
const RETRYABLE_BILLING_CODES = BILLING_CODES.filter((code) => code !== 'subscription_lapsed');
const BILLING_CODE_PROPERTY = {
  type: 'string',
  enum: BILLING_CODES,
  description: 'Machine-readable billing verification status when access is denied because of subscription state.',
};

if (RETRYABLE_BILLING_CODES.length === 0) {
  throw new Error('billing verification retryable code set is empty — refusing to run');
}

const BILLING_VERIFICATION_SCHEMA = {
  type: 'object',
  description: 'Returned when billing or entitlement verification is temporarily unavailable.',
  properties: {
    error: {
      type: 'string',
      description: 'Human-readable billing verification failure reason.',
    },
    code: {
      type: 'string',
      enum: RETRYABLE_BILLING_CODES,
      description: 'Machine-readable retryable billing verification status.',
    },
    requiredTier: {
      type: 'integer',
      format: 'int32',
      description: 'Minimum entitlement tier required for this endpoint when known.',
    },
  },
  required: ['error', 'code'],
};

const BILLING_VERIFICATION_RESPONSE = {
  description: 'Billing verification temporarily unavailable. Retry after the indicated delay.',
  headers: {
    'Retry-After': {
      description: 'Seconds to wait before retrying the request (1-60).',
      schema: { type: 'string' },
    },
    'X-Billing-Verification': {
      description: 'Billing verification failure status.',
      schema: { type: 'string', enum: RETRYABLE_BILLING_CODES },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/BillingVerificationError' },
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function operationEntries(spec) {
  const entries = [];
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations ?? {})) {
      if (HTTP_METHODS.has(method) && operation && typeof operation === 'object') {
        entries.push({ path, method, operation });
      }
    }
  }
  return entries;
}

function injectJson(spec) {
  let changed = false;
  const operations = operationEntries(spec);
  const hasNonPublicOperation = operations.some(({ path }) => !PUBLIC_PATHS.has(path));
  spec.components ||= {};
  spec.components.schemas ||= {};

  if (hasNonPublicOperation) {
    if (!eq(spec.components.schemas.BillingVerificationError, BILLING_VERIFICATION_SCHEMA)) {
      spec.components.schemas.BillingVerificationError = clone(BILLING_VERIFICATION_SCHEMA);
      changed = true;
    }
    const forbidden = spec.components.schemas.ForbiddenError;
    if (!forbidden) throw new Error('ForbiddenError schema missing — run the security injector before billing injection');
    if (!eq(forbidden.properties?.code, BILLING_CODE_PROPERTY)) {
      forbidden.properties ||= {};
      forbidden.properties.code = clone(BILLING_CODE_PROPERTY);
      changed = true;
    }
  } else if (spec.components.schemas.BillingVerificationError !== undefined) {
    delete spec.components.schemas.BillingVerificationError;
    changed = true;
  }

  for (const { path, operation } of operations) {
    operation.responses ||= {};
    if (PUBLIC_PATHS.has(path)) {
      if (operation.responses['503'] !== undefined) {
        delete operation.responses['503'];
        changed = true;
      }
      continue;
    }
    if (!eq(operation.responses['503'], BILLING_VERIFICATION_RESPONSE)) {
      operation.responses['503'] = clone(BILLING_VERIFICATION_RESPONSE);
      changed = true;
    }
  }
  return changed;
}

const YAML_BILLING_SCHEMA = [
  '        BillingVerificationError:',
  '            type: object',
  '            description: Returned when billing or entitlement verification is temporarily unavailable.',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable billing verification failure reason.',
  '                code:',
  '                    type: string',
  '                    enum:',
  ...RETRYABLE_BILLING_CODES.map((code) => `                        - ${code}`),
  '                    description: Machine-readable retryable billing verification status.',
  '                requiredTier:',
  '                    type: integer',
  '                    format: int32',
  '                    description: Minimum entitlement tier required for this endpoint when known.',
  '            required:',
  '                - error',
  '                - code',
];

const YAML_FORBIDDEN_CODE_PROPERTY = [
  '                code:',
  '                    type: string',
  '                    enum:',
  ...BILLING_CODES.map((code) => `                        - ${code}`),
  '                    description: Machine-readable billing verification status when access is denied because of subscription state.',
];

const YAML_BILLING_RESPONSE = [
  '                "503":',
  '                    description: Billing verification temporarily unavailable. Retry after the indicated delay.',
  '                    headers:',
  '                        Retry-After:',
  '                            description: Seconds to wait before retrying the request (1-60).',
  '                            schema:',
  '                                type: string',
  '                        X-Billing-Verification:',
  '                            description: Billing verification failure status.',
  '                            schema:',
  '                                type: string',
  '                                enum:',
  ...RETRYABLE_BILLING_CODES.map((code) => `                                    - ${code}`),
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/BillingVerificationError'",
];

const YAML_METHOD_RE = /^ {8}(get|post|put|delete|patch|options|head):$/;

function findYamlSchemaRange(lines, name) {
  const start = lines.indexOf(`        ${name}:`);
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
  lines.splice(schemasIndex + 1, 0, ...block);
  return true;
}

function removeYamlSchema(lines, name) {
  const existing = findYamlSchemaRange(lines, name);
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  return true;
}

function ensureYamlForbiddenCode(lines) {
  const schema = findYamlSchemaRange(lines, 'ForbiddenError');
  if (!schema) throw new Error('yaml: ForbiddenError schema missing — run the security injector before billing injection');
  const expected = YAML_FORBIDDEN_CODE_PROPERTY.join('\n');
  const codeStart = lines.findIndex((line, index) => (
    index >= schema.start && index < schema.end && line === '                code:'
  ));
  if (codeStart !== -1) {
    let codeEnd = codeStart + 1;
    while (codeEnd < schema.end && !/^                [^ ].*:/.test(lines[codeEnd])) codeEnd++;
    const existing = lines.slice(codeStart, codeEnd).join('\n');
    if (existing === expected) return false;
    lines.splice(codeStart, codeEnd - codeStart, ...YAML_FORBIDDEN_CODE_PROPERTY);
    return true;
  }
  const errorDescription = lines.findIndex((line, index) => (
    index > schema.start
      && index < schema.end
      && line === '                    description: Human-readable entitlement failure reason.'
  ));
  if (errorDescription === -1) throw new Error('yaml: ForbiddenError.error anchor missing');
  lines.splice(errorDescription + 1, 0, ...YAML_FORBIDDEN_CODE_PROPERTY);
  return true;
}

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
  const pathRange = findYamlPathRange(lines, path);
  if (!pathRange) return null;
  const start = lines.findIndex((line, index) => (
    index > pathRange.start && index < pathRange.end && line === `        ${method}:`
  ));
  if (start === -1) return null;
  let end = pathRange.end;
  for (let i = start + 1; i < pathRange.end; i++) {
    if (YAML_METHOD_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function enumerateYamlOperations(lines) {
  const operations = [];
  let currentPath = null;
  for (const line of lines) {
    const pathMatch = line.match(/^ {4}(\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (/^\S/.test(line)) {
      currentPath = null;
      continue;
    }
    const methodMatch = line.match(/^ {8}(get|post|put|delete|patch|options|head):\s*$/);
    if (currentPath && methodMatch) operations.push({ path: currentPath, method: methodMatch[1] });
  }
  return operations;
}

function findYamlResponseRange(lines, operation, statusLine) {
  const start = lines.findIndex((line, index) => (
    index > operation.start && index < operation.end && line === statusLine
  ));
  if (start === -1) return null;
  let end = start + 1;
  while (end < operation.end) {
    const line = lines[end];
    if (line && /^ {16}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('                    ')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function findYamlResponsesEnd(lines, operation) {
  const responsesIndex = lines.findIndex((line, index) => (
    index > operation.start && index < operation.end && line === '            responses:'
  ));
  if (responsesIndex === -1) return null;
  let end = responsesIndex + 1;
  while (end < operation.end) {
    const line = lines[end];
    if (line && !line.startsWith('                ')) break;
    end++;
  }
  return { responsesIndex, end };
}

function ensureYamlResponse(lines, operation, block) {
  const existing = findYamlResponseRange(lines, operation, '                "503":');
  const expected = block.join('\n');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...block);
    return true;
  }
  const responses = findYamlResponsesEnd(lines, operation);
  if (!responses) return false;
  const defaultIndex = lines.findIndex((line, index) => (
    index > responses.responsesIndex && index < responses.end && line === '                default:'
  ));
  lines.splice(defaultIndex === -1 ? responses.end : defaultIndex, 0, ...block);
  return true;
}

function removeYamlResponse(lines, operation) {
  const existing = findYamlResponseRange(lines, operation, '                "503":');
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  return true;
}

function injectYaml(text) {
  const lines = text.split('\n');
  let changed = false;
  const operations = enumerateYamlOperations(lines);
  const hasNonPublicOperation = operations.some(({ path }) => !PUBLIC_PATHS.has(path));
  changed = hasNonPublicOperation
    ? ensureYamlSchema(lines, 'BillingVerificationError', YAML_BILLING_SCHEMA) || changed
    : removeYamlSchema(lines, 'BillingVerificationError') || changed;
  if (hasNonPublicOperation) changed = ensureYamlForbiddenCode(lines) || changed;

  for (const { path, method } of operations) {
    let operation = findYamlOperationRange(lines, path, method);
    if (!operation) continue;
    if (PUBLIC_PATHS.has(path)) {
      changed = removeYamlResponse(lines, operation) || changed;
    } else {
      changed = ensureYamlResponse(lines, operation, YAML_BILLING_RESPONSE) || changed;
    }
  }
  return { text: lines.join('\n'), changed };
}

const jsonFiles = readdirSync(apiDir).filter((file) => /Service\.openapi\.json$/.test(file)).sort();
const yamlFiles = readdirSync(apiDir)
  .filter((file) => /Service\.openapi\.yaml$/.test(file) || file === 'worldmonitor.openapi.yaml')
  .sort();
let changedArtifacts = 0;
const touched = [];

for (const file of jsonFiles) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (injectJson(spec)) {
    changedArtifacts++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, serialize(spec));
  }
}

for (const file of yamlFiles) {
  const path = resolve(apiDir, file);
  const result = injectYaml(readFileSync(path, 'utf8'));
  if (result.changed) {
    changedArtifacts++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, result.text);
  }
}

if (CHECK) {
  if (changedArtifacts > 0) {
    console.error(`✗ ${changedArtifacts} OpenAPI artifact(s) missing billing-verification contracts: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:billing');
    process.exit(1);
  }
  console.log('✓ billing-verification contracts present on every authenticated OpenAPI operation');
} else {
  console.log(`openapi-inject-billing-verification: updated ${changedArtifacts} artifact(s)`);
}
