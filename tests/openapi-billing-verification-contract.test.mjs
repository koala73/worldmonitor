import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readBillingVerificationCodes,
  readPublicNoAuthPaths,
} from '../scripts/lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const script = resolve(root, 'scripts/openapi-inject-billing-verification.mjs');
const publicPaths = readPublicNoAuthPaths();
const billingCodes = readBillingVerificationCodes();
const retryableCodes = billingCodes.filter((code) => code !== 'subscription_lapsed');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const serviceJson = requireFiles(/Service\.openapi\.json$/);
const serviceYaml = requireFiles(/Service\.openapi\.yaml$/);

function requireFiles(pattern) {
  return readFileNames().filter((file) => pattern.test(file)).sort();
}

function readFileNames() {
  return readdirSync(apiDir);
}

function operations(spec) {
  const result = [];
  for (const [path, pathOperations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathOperations ?? {})) {
      if (HTTP_METHODS.has(method) && operation && typeof operation === 'object') {
        result.push({ path, method, operation });
      }
    }
  }
  return result;
}

function assertBillingSchema(spec, label) {
  const schema = spec.components?.schemas?.BillingVerificationError;
  assert.ok(schema, `${label}: BillingVerificationError schema missing`);
  assert.deepEqual(schema.required, ['error', 'code'], `${label}: billing schema required fields`);
  assert.deepEqual(schema.properties?.code?.enum, retryableCodes, `${label}: billing code enum drift`);
}

function assertForbiddenSchema(spec, label) {
  const schema = spec.components?.schemas?.ForbiddenError;
  assert.ok(schema, `${label}: ForbiddenError schema missing`);
  assert.deepEqual(schema.properties?.code?.enum, billingCodes, `${label}: ForbiddenError code enum drift`);
}

function assertOperation({ path, method, operation }, label) {
  const operationLabel = `${label}: ${method.toUpperCase()} ${path}`;
  if (publicPaths.has(path)) {
    assert.equal(operation.responses?.['503'], undefined, `${operationLabel}: public operation must not advertise billing 503`);
    return;
  }

  const response = operation.responses?.['503'];
  assert.ok(response, `${operationLabel}: billing 503 response missing`);
  assert.equal(
    response.content?.['application/json']?.schema?.$ref,
    '#/components/schemas/BillingVerificationError',
    `${operationLabel}: 503 response schema mismatch`,
  );
  assert.equal(response.headers?.['Retry-After']?.schema?.type, 'string', `${operationLabel}: Retry-After header missing`);
  assert.deepEqual(
    response.headers?.['X-Billing-Verification']?.schema?.enum,
    retryableCodes,
    `${operationLabel}: X-Billing-Verification enum mismatch`,
  );
}

function assertYamlContract(text, expected503Count, label) {
  if (expected503Count > 0) {
    assert.match(text, /BillingVerificationError:/, `${label}: billing schema missing`);
    assert.match(text, /ForbiddenError:/, `${label}: forbidden schema missing`);
    assert.match(text, /- entitlement_verification_unavailable/, `${label}: unavailable billing code missing`);
    assert.match(text, /X-Billing-Verification:/, `${label}: billing header missing`);
  } else {
    assert.doesNotMatch(text, /BillingVerificationError:/, `${label}: public-only spec has orphaned billing schema`);
  }
  const responseCount = (text.match(/^                "503":$/gm) ?? []).length;
  assert.equal(responseCount, expected503Count, `${label}: 503 operation count mismatch`);
}

describe('OpenAPI billing-verification contracts', () => {
  it('audits every generated service and the source-of-truth status union', () => {
    assert.ok(billingCodes.includes('subscription_lapsed'));
    assert.ok(billingCodes.includes('renewal_verification_pending'));
    assert.ok(billingCodes.includes('renewal_verification_failed'));
    assert.ok(billingCodes.includes('entitlement_verification_unavailable'));
    assert.ok(serviceJson.length >= 35, `expected at least 35 service specs, found ${serviceJson.length}`);
  });

  for (const file of serviceJson) {
    it(`${file}: every operation documents billing verification`, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const ops = operations(spec);
      if (ops.some(({ path }) => !publicPaths.has(path))) {
        assertBillingSchema(spec, file);
        assertForbiddenSchema(spec, file);
      }
      for (const operation of ops) assertOperation(operation, file);
    });
  }

  for (const file of serviceYaml) {
    it(`${file}: YAML documents billing verification`, () => {
      const text = readFileSync(resolve(apiDir, file), 'utf8');
      const jsonFile = file.replace(/\.yaml$/, '.json');
      const jsonSpec = JSON.parse(readFileSync(resolve(apiDir, jsonFile), 'utf8'));
      const expected503Count = operations(jsonSpec).filter(({ path }) => !publicPaths.has(path)).length;
      assertYamlContract(text, expected503Count, file);
    });
  }

  it('keeps the published YAML bundle in parity', () => {
    const text = readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8');
    const expected503Count = serviceJson.reduce((total, file) => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      return total + operations(spec).filter(({ path }) => !publicPaths.has(path)).length;
    }, 0);
    assertYamlContract(text, expected503Count, 'worldmonitor.openapi.yaml');
  });

  it('has an idempotent, fail-closed freshness check', () => {
    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'worldmonitor-openapi-billing-'));
    try {
      cpSync(resolve(apiDir, 'AviationService.openapi.json'), resolve(fixtureDir, 'AviationService.openapi.json'));
      cpSync(resolve(apiDir, 'AviationService.openapi.yaml'), resolve(fixtureDir, 'AviationService.openapi.yaml'));
      const env = { ...process.env, WM_OPENAPI_API_DIR: fixtureDir };
      execFileSync(process.execPath, [script], { cwd: root, env, stdio: 'pipe' });
      execFileSync(process.execPath, [script, '--check'], { cwd: root, env, stdio: 'pipe' });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
