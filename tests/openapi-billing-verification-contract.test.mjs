import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  readPublicNoAuthPaths,
  readBillingVerificationStatuses,
  readRetryableBillingCodes,
  LAPSED_BILLING_STATUS,
} from '../scripts/lib/openapi-codegen.mjs';

// Guards scripts/openapi-inject-billing-verification.mjs and the
// ForbiddenError.code addition in scripts/openapi-inject-security.mjs
// (#5447 wire contract). The billing-verification 503 and the
// subscription_lapsed 403 are emitted by the gateway/entitlement gates around
// every authenticated RPC, not by proto handlers, so a fresh `make generate`
// must re-run the injectors or the published specs lose the real retry
// semantics. The code enums are asserted against the SAME source parsers the
// injectors stamp from, mirroring how mcp-api-parity pins doc claims to
// server/_shared/entitlement-check.ts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

const PUBLIC_PATHS = readPublicNoAuthPaths();
const RETRYABLE_CODES = readRetryableBillingCodes();

const serviceJson = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const serviceYaml = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();

function operations(spec) {
  const out = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function assertBillingSchema(spec, label) {
  const schema = spec.components?.schemas?.BillingVerificationError;
  assert.ok(schema, `${label}: BillingVerificationError schema missing`);
  assert.equal(schema.properties?.error?.type, 'string', `${label}: BillingVerificationError.error must be string`);
  assert.deepEqual(
    schema.properties?.code?.enum,
    RETRYABLE_CODES,
    `${label}: BillingVerificationError.code enum must match the codes derived from server/_shared/entitlement-check.ts`,
  );
  assert.deepEqual(schema.required, ['error', 'code'], `${label}: BillingVerificationError must require error and code`);
  assert.equal(
    schema.properties?.requiredTier?.type,
    'integer',
    `${label}: BillingVerificationError.requiredTier must stay an optional integer`,
  );
}

function assertForbiddenCode(spec, label) {
  const forbidden = spec.components?.schemas?.ForbiddenError;
  assert.ok(forbidden, `${label}: ForbiddenError schema missing`);
  assert.deepEqual(
    forbidden.properties?.code?.enum,
    [LAPSED_BILLING_STATUS],
    `${label}: ForbiddenError.code enum must carry the provider-confirmed lapse code`,
  );
  assert.deepEqual(forbidden.required, ['error'], `${label}: ForbiddenError.code must stay optional (error-only required)`);
}

function assertOperationContract({ path, method, op }, label) {
  const opLabel = `${label}: ${method.toUpperCase()} ${path}`;
  const denial = op.responses?.['503'];
  if (PUBLIC_PATHS.has(path)) {
    assert.equal(denial, undefined, `${opLabel}: public operations must not document the billing-verification 503`);
    return;
  }
  assert.ok(denial, `${opLabel}: missing billing-verification 503 response`);
  assert.deepEqual(
    denial.content?.['application/json']?.schema?.oneOf,
    [
      { $ref: '#/components/schemas/BillingVerificationError' },
      { $ref: '#/components/schemas/GatewayError' },
    ],
    `${opLabel}: 503 must accept billing-verification and generic gateway errors`,
  );
  for (const header of [
    'Retry-After',
    'X-Billing-Verification',
    'X-Validation-Mode',
    'X-RateLimit-Mode',
  ]) {
    assert.ok(denial.headers?.[header], `${opLabel}: 503 must document ${header}`);
    assert.equal(denial.headers[header].schema?.type, 'string', `${opLabel}: ${header} header schema`);
  }

  // The provider-confirmed lapse answers authed routes with a 403 that carries
  // X-Billing-Verification too (ForbiddenError-backed 403 families only — the
  // public Turnstile 403 gates never send it).
  const forbidden = op.responses?.['403'];
  if (forbidden?.content?.['application/json']?.schema?.$ref === '#/components/schemas/ForbiddenError') {
    assert.ok(
      forbidden.headers?.['X-Billing-Verification'],
      `${opLabel}: ForbiddenError-backed 403 must document X-Billing-Verification`,
    );
    assert.equal(
      forbidden.headers['X-Billing-Verification'].schema?.type,
      'string',
      `${opLabel}: 403 X-Billing-Verification header schema`,
    );
  }
}

describe('OpenAPI billing-verification contracts', () => {
  it('derives the code enums from the entitlement gate source (fail-closed)', () => {
    const statuses = readBillingVerificationStatuses();
    assert.ok(statuses.includes(LAPSED_BILLING_STATUS), 'union must contain the lapse status');
    assert.ok(statuses.length >= 3, `expected the audited 3 billing statuses, found ${statuses.length}`);
    assert.ok(
      RETRYABLE_CODES.includes('entitlement_verification_unavailable'),
      'retryable enum must include the transient backend-unreachable code',
    );
    assert.ok(!RETRYABLE_CODES.includes(LAPSED_BILLING_STATUS), 'the hard-403 lapse must not be in the retryable 503 enum');
  });

  it('audits the authenticated operation surface', () => {
    let nonPublic = 0;
    let publicOps = 0;
    for (const file of serviceJson) {
      for (const { path } of operations(JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')))) {
        if (PUBLIC_PATHS.has(path)) publicOps++;
        else nonPublic++;
      }
    }
    assert.ok(nonPublic >= 150, `expected at least the audited 150 authenticated operations, found ${nonPublic}`);
    assert.ok(publicOps >= 7, `expected at least the audited 7 public operations, found ${publicOps}`);
  });

  for (const file of serviceJson) {
    it(`${file}: authenticated operations document the billing-verification 503`, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const ops = operations(spec);
      const hasNonPublicOp = ops.some(({ path }) => !PUBLIC_PATHS.has(path));
      if (hasNonPublicOp) {
        assertBillingSchema(spec, file);
        assertForbiddenCode(spec, file);
      } else {
        assert.equal(
          spec.components?.schemas?.BillingVerificationError,
          undefined,
          `${file}: all-public spec must not carry an orphaned BillingVerificationError schema`,
        );
      }
      for (const op of ops) assertOperationContract(op, file);
    });
  }

  for (const file of serviceYaml) {
    it(`${file}: authenticated operations document the billing-verification 503`, () => {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      const ops = operations(spec);
      const hasNonPublicOp = ops.some(({ path }) => !PUBLIC_PATHS.has(path));
      if (hasNonPublicOp) {
        assertBillingSchema(spec, file);
        assertForbiddenCode(spec, file);
      }
      for (const op of ops) assertOperationContract(op, file);
    });
  }

  it('the unified bundle documents the same billing-verification contracts', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertBillingSchema(bundle, 'worldmonitor.openapi.yaml');
    assertForbiddenCode(bundle, 'worldmonitor.openapi.yaml');
    for (const op of operations(bundle)) assertOperationContract(op, 'worldmonitor.openapi.yaml');
  });

  it('JSON and YAML artifacts agree on the injected schema', () => {
    for (const file of serviceJson) {
      const yamlFile = file.replace(/\.json$/, '.yaml');
      const json = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const yaml = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      assert.deepEqual(
        yaml.components?.schemas?.BillingVerificationError ?? null,
        json.components?.schemas?.BillingVerificationError ?? null,
        `${file}: BillingVerificationError must be identical in JSON and YAML`,
      );
    }
  });

  it('the injector reports the specs as in-sync', () => {
    execFileSync('node', ['scripts/openapi-inject-billing-verification.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
