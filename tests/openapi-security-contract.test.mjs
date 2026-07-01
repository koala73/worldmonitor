import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the API security contract injected by
// scripts/openapi-inject-security.mjs (umbrella #4599, root cause #1). The
// sebuf generator emits no auth metadata, so if a regenerate lands without the
// post-generation injection step, these assertions fail and flag the drop.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

// Public (no-auth) RPCs — parsed from the same source of truth the injector
// uses (server/gateway.ts). These opt out of the security requirement.
function readPublicNoAuthPaths() {
  const src = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
  const block = src.match(/PUBLIC_NO_AUTH_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not parse PUBLIC_NO_AUTH_RPC_PATHS from server/gateway.ts');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function readEndpointEntitlements() {
  const src = readFileSync(resolve(root, 'server/_shared/entitlement-check.ts'), 'utf8');
  const block = src.match(/ENDPOINT_ENTITLEMENTS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, 'could not parse ENDPOINT_ENTITLEMENTS from server/_shared/entitlement-check.ts');
  return new Map([...block[1].matchAll(/'([^']+)'\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
}

function readPremiumRpcPaths() {
  const src = readFileSync(resolve(root, 'src/shared/premium-paths.ts'), 'utf8');
  const block = src.match(/PREMIUM_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not parse PREMIUM_RPC_PATHS from src/shared/premium-paths.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function readPublicForbiddenGates() {
  const src = readFileSync(resolve(root, 'scripts/openapi-inject-security.mjs'), 'utf8');
  const block = src.match(/PUBLIC_FORBIDDEN_GATES\s*=\s*new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'could not parse PUBLIC_FORBIDDEN_GATES from scripts/openapi-inject-security.mjs');
  const gates = [...block[1].matchAll(/\['([^']+)'\,\s*\{[\s\S]*?note:\s*'([^']+)'[\s\S]*?schema:\s*\{\s*\$ref:\s*'([^']+)'\s*\}/g)]
    .map((m) => [m[1], { note: m[2], responseRef: m[3] }]);
  assert.ok(gates.length > 0, 'expected at least one public forbidden gate');
  return new Map(gates);
}

const PUBLIC_PATHS = readPublicNoAuthPaths();
const ENDPOINT_ENTITLEMENTS = readEndpointEntitlements();
const PUBLIC_FORBIDDEN_GATES = readPublicForbiddenGates();
const BEARER_AUTH_PATHS = new Set([...ENDPOINT_ENTITLEMENTS.keys(), ...readPremiumRpcPaths()]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const API_KEY_SCHEMES = {
  WorldMonitorKey: { type: 'apiKey', in: 'header', name: 'X-WorldMonitor-Key' },
  ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
};
const BEARER_SCHEME = { BearerAuth: { type: 'http', scheme: 'bearer' } };
const API_KEY_SECURITY_NAMES = Object.keys(API_KEY_SCHEMES);
const BEARER_SECURITY_NAMES = [...API_KEY_SECURITY_NAMES, 'BearerAuth'];

const serviceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

function expectedSchemesForSpec(spec) {
  const hasBearerAuthPath = Object.keys(spec.paths ?? {}).some((path) => BEARER_AUTH_PATHS.has(path));
  return hasBearerAuthPath ? { ...API_KEY_SCHEMES, ...BEARER_SCHEME } : API_KEY_SCHEMES;
}

function securityNames(security) {
  assert.ok(Array.isArray(security), 'security must be an array');
  return security.map((requirement) => Object.keys(requirement)[0]).sort();
}

function assertSecurityNames(actual, expected, label) {
  assert.deepEqual(securityNames(actual), [...expected].sort(), `${label}: security schemes mismatch`);
}

function assertSchemeFields(schemes, expected, label) {
  assert.deepEqual(Object.keys(schemes).sort(), Object.keys(expected).sort(), `${label}: securitySchemes mismatch`);
  for (const [name, fields] of Object.entries(expected)) {
    assert.ok(schemes[name], `${label}: securityScheme ${name} missing`);
    for (const [k, v] of Object.entries(fields)) {
      assert.equal(schemes[name][k], v, `${label}: ${name}.${k} should be ${v}`);
    }
    assert.ok(
      !String(schemes[name].description ?? '').includes('relay shared secret'),
      `${label}: ${name}.description must not advertise internal relay credentials`,
    );
  }
}

function assertEntitlementOperationContract(spec, label) {
  for (const [path, requiredTier] of ENDPOINT_ENTITLEMENTS) {
    const ops = spec.paths?.[path];
    if (!ops) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const opLabel = `${label}: ${method.toUpperCase()} ${path}`;
      assert.match(
        String(op.description ?? ''),
        /PRO-gated/i,
        `${opLabel}: description must state that the operation is PRO-gated`,
      );
      assert.match(
        String(op.description ?? ''),
        new RegExp(`Requires entitlement tier >= ${requiredTier}\\.`),
        `${opLabel}: description must include required entitlement tier`,
      );
      const r403 = op.responses?.['403'];
      assert.ok(r403, `${opLabel}: missing 403 response`);
      assert.match(
        String(r403.description ?? ''),
        /PRO entitlement access denied/i,
        `${opLabel}: 403 description must describe the broader entitlement gate`,
      );
      assert.equal(
        r403.content?.['application/json']?.schema?.$ref,
        '#/components/schemas/ForbiddenError',
        `${opLabel}: 403 must reference ForbiddenError`,
      );
    }
  }
}

function assertPublicForbiddenGateContract(spec, label) {
  for (const [path, gate] of PUBLIC_FORBIDDEN_GATES) {
    const ops = spec.paths?.[path];
    if (!ops) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const opLabel = label + ': ' + method.toUpperCase() + ' ' + path;
      assert.ok(
        String(op.description ?? '').includes(gate.note),
        opLabel + ': description must document the public 403 gate',
      );
      const r403 = op.responses?.['403'];
      assert.ok(r403, opLabel + ': missing 403 response');
      assert.equal(
        r403.content?.['application/json']?.schema?.$ref,
        gate.responseRef,
        opLabel + ': 403 must reference the documented error schema',
      );
    }
  }
}

describe('OpenAPI security contract', () => {
  it('audits at least the full known service surface', () => {
    assert.ok(serviceSpecs.length >= 34, `expected >= 34 service specs, found ${serviceSpecs.length}`);
  });

  it('parses the bearer-auth and entitlement path sources from gateway-adjacent code', () => {
    assert.ok(BEARER_AUTH_PATHS.size > 0, 'expected at least one bearer-auth path');
    assert.ok(ENDPOINT_ENTITLEMENTS.size >= 18, 'expected issue-scoped entitlement-gated paths');
    assert.equal(ENDPOINT_ENTITLEMENTS.get('/api/market/v1/analyze-stock'), 1, 'expected tier-gated market path');
    assert.equal(ENDPOINT_ENTITLEMENTS.get('/api/sanctions/v1/list-sanctions-pressure'), 1, 'expected sanctions pressure path');
    assert.equal(ENDPOINT_ENTITLEMENTS.get('/api/trade/v1/list-comtrade-flows'), 1, 'expected Comtrade path');
    assert.ok(PUBLIC_FORBIDDEN_GATES.has('/api/leads/v1/submit-contact'), 'expected Leads Turnstile 403 path');
    assert.ok(BEARER_AUTH_PATHS.has('/api/intelligence/v1/get-regional-brief'), 'expected legacy premium path');
  });

  for (const file of serviceSpecs) {
    describe(file, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));

      it('defines only the security schemes applicable to its operations', () => {
        const schemes = spec.components?.securitySchemes;
        assert.ok(schemes, `${file}: components.securitySchemes missing`);
        assertSchemeFields(schemes, expectedSchemesForSpec(spec), file);
      });

      it('declares a root API-key security requirement', () => {
        assertSecurityNames(spec.security, API_KEY_SECURITY_NAMES, `${file}: root`);
      });

      it('defines the UnauthorizedError schema', () => {
        const s = spec.components?.schemas?.UnauthorizedError;
        assert.ok(s, `${file}: components.schemas.UnauthorizedError missing`);
        assert.ok(
          Array.isArray(s.required) && s.required.includes('error'),
          `${file}: UnauthorizedError must require 'error'`,
        );
      });

      it('defines ForbiddenError when it has entitlement-gated paths', () => {
        const hasEntitlementPath = Object.keys(spec.paths ?? {}).some((path) => ENDPOINT_ENTITLEMENTS.has(path));
        if (!hasEntitlementPath) return;
        const s = spec.components?.schemas?.ForbiddenError;
        assert.ok(s, `${file}: components.schemas.ForbiddenError missing`);
        assert.ok(
          Array.isArray(s.required) && s.required.includes('error'),
          `${file}: ForbiddenError must require 'error'`,
        );
        assert.match(
          String(s.description ?? ''),
          /entitlements cannot be verified/i,
          `${file}: ForbiddenError must document unable-to-verify entitlement denials`,
        );
      });

      it('documents 401s, public opt-outs, and bearer-only-on-bearer-capable ops', () => {
        for (const [path, ops] of Object.entries(spec.paths ?? {})) {
          const isPublic = PUBLIC_PATHS.has(path);
          const acceptsBearer = BEARER_AUTH_PATHS.has(path);
          for (const [method, op] of Object.entries(ops)) {
            if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
            const label = `${method.toUpperCase()} ${path}`;
            if (isPublic) {
              assert.ok(
                Array.isArray(op.security) && op.security.length === 0,
                `${file}: public ${label} must set security: [] (opt out of auth)`,
              );
              assert.equal(op.responses?.['401'], undefined, `${file}: public ${label} must not carry a 401`);
              continue;
            }

            const r401 = op.responses?.['401'];
            assert.ok(r401, `${file}: ${label} missing 401 response`);
            assert.equal(
              r401.content?.['application/json']?.schema?.$ref,
              '#/components/schemas/UnauthorizedError',
              `${file}: ${label} 401 must reference UnauthorizedError`,
            );

            if (acceptsBearer) {
              assertSecurityNames(op.security, BEARER_SECURITY_NAMES, `${file}: ${label}`);
            } else {
              assert.equal(op.security, undefined, `${file}: ${label} should inherit API-key root security`);
            }
          }
        }
      });

      it('documents entitlement 403s and PRO notes from ENDPOINT_ENTITLEMENTS', () => {
        assertEntitlementOperationContract(spec, file);
      });

      it('documents public 403 gates', () => {
        assertPublicForbiddenGateContract(spec, file);
      });
    });
  }

  it('service YAML specs and bundled YAML document 403 gate notes', () => {
    for (const file of readdirSync(apiDir).filter((f) => /Service\.openapi\.yaml$/.test(f)).sort()) {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      assertEntitlementOperationContract(spec, file);
      assertPublicForbiddenGateContract(spec, file);
    }
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertEntitlementOperationContract(bundle, 'bundle');
    assertPublicForbiddenGateContract(bundle, 'bundle');
  });

  it('bundle (worldmonitor.openapi.yaml) carries global API-key security + schemes', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertSecurityNames(bundle.security, API_KEY_SECURITY_NAMES, 'bundle: root');
    const schemes = bundle.components?.securitySchemes ?? {};
    assertSchemeFields(schemes, API_KEY_SCHEMES, 'bundle');
  });
});
