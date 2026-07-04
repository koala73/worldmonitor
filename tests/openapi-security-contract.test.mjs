import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  readPublicNoAuthPaths,
  readEndpointEntitlements,
  readPremiumRpcPaths,
  PUBLIC_FORBIDDEN_GATES,
} from '../scripts/lib/openapi-codegen.mjs';

// Guards the API contracts injected by the OpenAPI post-generation scripts:
// auth/security (scripts/openapi-inject-security.mjs, #4599 root cause #1) and
// required query/body fields (scripts/openapi-inject-required.mjs, #4604 / #4599
// root cause #3). If a regenerate lands without either injection step, these
// assertions fail and flag the drop.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const protoWorldmonitorDir = resolve(root, 'proto/worldmonitor');

// Source-of-truth sets/maps are imported from scripts/lib/openapi-codegen.mjs —
// the SAME module the injector uses — so the contract test can't drift from the
// injector via a divergent private regex, and asserting the specs against these
// values catches any regenerate that drops an injection.
const PUBLIC_PATHS = readPublicNoAuthPaths();
const ENDPOINT_ENTITLEMENTS = readEndpointEntitlements();
const BEARER_AUTH_PATHS = new Set([...ENDPOINT_ENTITLEMENTS.keys(), ...readPremiumRpcPaths()]);
// Legacy-Pro-gated paths NOT covered by the newer ENDPOINT_ENTITLEMENTS tier
// map. These carry a "Pro subscription required" 403 (gateway
// needsLegacyProBearerGate). Entitlement paths are subtracted so the stricter
// entitlement 403 wins for any path in both sets — mirrors PREMIUM_ONLY_PATHS
// in scripts/openapi-inject-security.mjs.
const PREMIUM_ONLY_PATHS = new Set(readPremiumRpcPaths().filter((p) => !ENDPOINT_ENTITLEMENTS.has(p)));
const PREMIUM_FORBIDDEN_NOTE = 'PRO-gated. Requires an active Pro subscription.';
const GATED_DESCRIPTION_PATHS = new Set([
  ...ENDPOINT_ENTITLEMENTS.keys(),
  ...PREMIUM_ONLY_PATHS,
  ...PUBLIC_FORBIDDEN_GATES.keys(),
]);

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
const protoRequiredRequestFields = readProtoRequiredRequestFields();

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
        String(r403.description ?? ''),
        gate.response.description,
        opLabel + ': 403 description must match the documented public gate',
      );
      assert.equal(
        r403.content?.['application/json']?.schema?.$ref,
        gate.response.content?.['application/json']?.schema?.$ref,
        opLabel + ': 403 must reference the documented error schema',
      );
    }
  }
}

function assertPremiumForbiddenGateContract(spec, label) {
  let sawPremiumPath = false;
  for (const path of PREMIUM_ONLY_PATHS) {
    const ops = spec.paths?.[path];
    if (!ops) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      sawPremiumPath = true;
      const opLabel = label + ': ' + method.toUpperCase() + ' ' + path;
      assert.ok(
        String(op.description ?? '').includes(PREMIUM_FORBIDDEN_NOTE),
        opLabel + ': description must document the legacy Pro-subscription gate',
      );
      const r403 = op.responses?.['403'];
      assert.ok(r403, opLabel + ': missing 403 response');
      assert.match(
        String(r403.description ?? ''),
        /Pro subscription required/i,
        opLabel + ': 403 description must state Pro subscription required',
      );
      assert.equal(
        r403.content?.['application/json']?.schema?.$ref,
        '#/components/schemas/ForbiddenError',
        opLabel + ': 403 must reference ForbiddenError',
      );
    }
  }
  // A premium-only 403 references ForbiddenError, so the schema must be defined
  // even in services that carry no ENDPOINT_ENTITLEMENTS path (e.g. Intelligence,
  // Resilience). Guards the broadened schema-injection trigger.
  if (sawPremiumPath) {
    const s = spec.components?.schemas?.ForbiddenError;
    assert.ok(s, label + ': ForbiddenError schema must be defined for premium 403s');
    assert.ok(
      Array.isArray(s.required) && s.required.includes('error'),
      label + ": ForbiddenError must require 'error'",
    );
  }
}

function gatedDescriptionParityFailures(referenceSpec, candidateSpec, referenceLabel, candidateLabel) {
  const failures = [];
  for (const path of GATED_DESCRIPTION_PATHS) {
    const referenceOps = referenceSpec.paths?.[path];
    if (!referenceOps) continue;
    const candidateOps = candidateSpec.paths?.[path];
    if (!candidateOps) {
      failures.push(`${candidateLabel}: missing ${path} from ${referenceLabel}`);
      continue;
    }
    for (const [method, referenceOp] of Object.entries(referenceOps)) {
      if (!HTTP_METHODS.has(method) || !referenceOp || typeof referenceOp !== 'object') continue;
      const candidateOp = candidateOps[method];
      if (!candidateOp || typeof candidateOp !== 'object') {
        failures.push(`${candidateLabel}: missing ${method.toUpperCase()} ${path} from ${referenceLabel}`);
        continue;
      }
      const expected = String(referenceOp.description ?? '');
      const actual = String(candidateOp.description ?? '');
      if (actual !== expected) {
        failures.push(`${candidateLabel}: ${method.toUpperCase()} ${path} description must exactly match ${referenceLabel}`);
      }
    }
  }
  return failures;
}

function toSnakeName(jsonName) {
  return jsonName.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function toJsonName(protoName) {
  return protoName.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase());
}

function listProtoFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) return listProtoFiles(p);
    return entry.isFile() && entry.name.endsWith('.proto') ? [p] : [];
  });
}

function findMatchingBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced proto message block near offset ${openIndex}`);
}

function readProtoRequiredRequestFields() {
  const contracts = [];
  for (const file of listProtoFiles(protoWorldmonitorDir)) {
    const src = readFileSync(file, 'utf8');
    const messageRe = /\bmessage\s+(\w+)\s*\{/g;
    let msgMatch;
    while ((msgMatch = messageRe.exec(src))) {
      const messageName = msgMatch[1];
      const open = src.indexOf('{', msgMatch.index);
      const close = findMatchingBrace(src, open);
      if (!messageName.endsWith('Request')) {
        messageRe.lastIndex = close + 1;
        continue;
      }

      const body = src.slice(open + 1, close);
      const fieldRe = /(?:^|\n)\s*(?:optional\s+)?(?:repeated\s+)?(?:map\s*<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*\d+\s*(\[[\s\S]*?\])?\s*;/g;
      let fieldMatch;
      while ((fieldMatch = fieldRe.exec(body))) {
        const protoName = fieldMatch[1];
        const options = fieldMatch[2] ?? '';
        const queryBlock = options.match(/\(sebuf\.http\.query\)\s*=\s*\{([\s\S]*?)\}/);
        const requiredByValidate = /\(buf\.validate\.field\)\.required\s*=\s*true/.test(options);
        const requiredByQuery = queryBlock ? /\brequired\s*:\s*true\b/.test(queryBlock[1]) : false;
        if (!requiredByValidate && !requiredByQuery) continue;

        const jsonName = toJsonName(protoName);
        contracts.push({
          file,
          messageName,
          jsonName,
          protoName,
          queryName: queryBlock?.[1].match(/\bname\s*:\s*"([^"]+)"/)?.[1] ?? protoName,
        });
      }
      messageRe.lastIndex = close + 1;
    }
  }
  return contracts;
}

function schemaNameMatches(actual, expected) {
  return actual === expected || actual.endsWith(`_${expected}`);
}

function matchingRequestSchemas(spec, messageName) {
  return Object.entries(spec.components?.schemas ?? {})
    .filter(([name]) => schemaNameMatches(name, messageName));
}

function requestSchemaForOperation(spec, op) {
  const simpleName = `${op.operationId ?? ''}Request`;
  const schemas = spec.components?.schemas ?? {};
  if (schemas[simpleName]) return { name: simpleName, schema: schemas[simpleName] };
  const suffix = `_${simpleName}`;
  const matches = Object.keys(schemas).filter((name) => name.endsWith(suffix));
  assert.ok(matches.length <= 1, `${op.operationId}: ambiguous request schema matches: ${matches.join(', ')}`);
  return matches.length === 1 ? { name: matches[0], schema: schemas[matches[0]] } : null;
}

function matchingSchemaProperty(schema, paramName) {
  const props = Object.keys(schema?.properties ?? {});
  return props.find((key) => key === paramName || toSnakeName(key) === paramName) ?? null;
}

function queryRequiredContradictions(spec, label) {
  const failures = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const requestSchema = requestSchemaForOperation(spec, op);
      const required = new Set(requestSchema?.schema?.required ?? []);
      if (required.size === 0) continue;
      for (const param of op.parameters ?? []) {
        if (param?.in !== 'query') continue;
        const property = matchingSchemaProperty(requestSchema.schema, param.name);
        if (property && required.has(property) && param.required !== true) {
          failures.push(`${label}: ${method.toUpperCase()} ${path} query ${param.name} is required by ${requestSchema.name}.${property} but parameter.required is ${param.required}`);
        }
      }
    }
  }
  return failures;
}

function assertSchemaRequires(spec, schemaName, fields, label) {
  const schema = spec.components?.schemas?.[schemaName];
  assert.ok(schema, `${label}: missing ${schemaName}`);
  for (const field of fields) {
    assert.ok(
      Array.isArray(schema.required) && schema.required.includes(field),
      `${label}: ${schemaName}.required must include ${field}`,
    );
  }
}

// Full auth contract, format-agnostic (works on JSON specs or YAML-loaded
// specs): securitySchemes (2 or 3 by bearer-path presence), root API-key
// security, UnauthorizedError schema, and per-operation 401 / public opt-out /
// bearer stamping. Used to assert the per-service YAML files and the bundle
// reach parity with the per-service JSON specs (#4650).
function assertAuthContract(spec, label) {
  const schemes = spec.components?.securitySchemes;
  assert.ok(schemes, `${label}: components.securitySchemes missing`);
  assertSchemeFields(schemes, expectedSchemesForSpec(spec), label);
  assertSecurityNames(spec.security, API_KEY_SECURITY_NAMES, `${label}: root`);

  // UnauthorizedError is present iff the spec has a non-public op (which carries
  // the 401 that references it); all-public specs must NOT carry an orphan.
  const hasNonPublicOp = Object.keys(spec.paths ?? {}).some((path) => !PUBLIC_PATHS.has(path));
  const unauthorized = spec.components?.schemas?.UnauthorizedError;
  if (hasNonPublicOp) {
    assert.ok(unauthorized, `${label}: components.schemas.UnauthorizedError missing`);
    assert.ok(
      Array.isArray(unauthorized.required) && unauthorized.required.includes('error'),
      `${label}: UnauthorizedError must require 'error'`,
    );
  } else {
    assert.equal(unauthorized, undefined, `${label}: all-public spec must not carry an orphaned UnauthorizedError`);
  }

  // ForbiddenError backs the per-op 403 every non-public op now carries (the
  // account-state #4611 403, plus entitlement/premium); present iff a non-public
  // op exists, absent otherwise (no orphan).
  const forbidden = spec.components?.schemas?.ForbiddenError;
  if (hasNonPublicOp) {
    assert.ok(forbidden, `${label}: ForbiddenError schema missing`);
  } else {
    assert.equal(forbidden, undefined, `${label}: all-public spec must not carry an orphaned ForbiddenError`);
  }

  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const isPublic = PUBLIC_PATHS.has(path);
    const acceptsBearer = BEARER_AUTH_PATHS.has(path);
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const opLabel = `${label}: ${method.toUpperCase()} ${path}`;
      if (isPublic) {
        assert.ok(
          Array.isArray(op.security) && op.security.length === 0,
          `${opLabel}: public op must set security: [] (opt out of auth)`,
        );
        assert.equal(op.responses?.['401'], undefined, `${opLabel}: public op must not carry a 401`);
        continue;
      }
      const r401 = op.responses?.['401'];
      assert.ok(r401, `${opLabel}: missing 401 response`);
      assert.equal(
        r401.content?.['application/json']?.schema?.$ref,
        '#/components/schemas/UnauthorizedError',
        `${opLabel}: 401 must reference UnauthorizedError`,
      );
      if (acceptsBearer) {
        assertSecurityNames(op.security, BEARER_SECURITY_NAMES, opLabel);
      } else {
        assert.equal(op.security, undefined, `${opLabel}: should inherit API-key root security`);
      }
      // Every non-public op carries a 403 (account-state #4611, or the more
      // specific entitlement/premium gate) — all referencing ForbiddenError.
      const r403 = op.responses?.['403'];
      assert.ok(r403, `${opLabel}: missing 403 response`);
      assert.equal(
        r403.content?.['application/json']?.schema?.$ref,
        '#/components/schemas/ForbiddenError',
        `${opLabel}: 403 must reference ForbiddenError`,
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
    assert.ok(PUBLIC_FORBIDDEN_GATES.has('/api/leads/v1/register-interest'), 'expected Leads register-interest 403 gate');
    assert.ok(BEARER_AUTH_PATHS.has('/api/intelligence/v1/get-regional-brief'), 'expected legacy premium path');
    assert.ok(PREMIUM_ONLY_PATHS.has('/api/intelligence/v1/get-regional-brief'), 'expected legacy premium-only path (not entitlement-gated)');
    assert.ok(!PREMIUM_ONLY_PATHS.has('/api/market/v1/analyze-stock'), 'entitlement-gated path must not be treated as premium-only');
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

      it('defines UnauthorizedError iff it has a non-public op', () => {
        const hasNonPublicOp = Object.keys(spec.paths ?? {}).some((path) => !PUBLIC_PATHS.has(path));
        const s = spec.components?.schemas?.UnauthorizedError;
        if (hasNonPublicOp) {
          assert.ok(s, `${file}: components.schemas.UnauthorizedError missing`);
          assert.ok(
            Array.isArray(s.required) && s.required.includes('error'),
            `${file}: UnauthorizedError must require 'error'`,
          );
        } else {
          assert.equal(s, undefined, `${file}: all-public spec must not carry an orphaned UnauthorizedError`);
        }
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

      it('documents premium (legacy Pro) 403s from PREMIUM_RPC_PATHS', () => {
        assertPremiumForbiddenGateContract(spec, file);
      });
    });
  }

  it('service YAML specs and bundled YAML document 403 gate notes', () => {
    for (const file of readdirSync(apiDir).filter((f) => /Service\.openapi\.yaml$/.test(f)).sort()) {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      assertEntitlementOperationContract(spec, file);
      assertPublicForbiddenGateContract(spec, file);
      assertPremiumForbiddenGateContract(spec, file);
    }
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertEntitlementOperationContract(bundle, 'bundle');
    assertPremiumForbiddenGateContract(bundle, 'bundle');
    assertPublicForbiddenGateContract(bundle, 'bundle');
  });

  it('keeps gated operation descriptions byte-identical across JSON, YAML, and bundle', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const failures = [];
    for (const file of serviceSpecs) {
      const jsonSpec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const yamlFile = file.replace(/\.json$/, '.yaml');
      const yamlSpec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      failures.push(...gatedDescriptionParityFailures(jsonSpec, yamlSpec, file, yamlFile));
      failures.push(...gatedDescriptionParityFailures(jsonSpec, bundle, file, 'worldmonitor.openapi.yaml'));
    }
    assert.deepEqual(failures, []);
  });

  it('service YAML specs carry the full auth contract (parity with JSON)', () => {
    for (const file of readdirSync(apiDir).filter((f) => /Service\.openapi\.yaml$/.test(f)).sort()) {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      assertAuthContract(spec, file);
    }
  });

  it('bundle (worldmonitor.openapi.yaml) carries the full auth contract', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertAuthContract(bundle, 'bundle');
  });

  it('propagates request-schema required fields to matching query parameters', () => {
    const failures = [];
    for (const file of serviceSpecs) {
      const jsonSpec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      failures.push(...queryRequiredContradictions(jsonSpec, file));

      const yamlFile = file.replace(/\.json$/, '.yaml');
      const yamlSpec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      failures.push(...queryRequiredContradictions(yamlSpec, yamlFile));
    }

    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    failures.push(...queryRequiredContradictions(bundle, 'worldmonitor.openapi.yaml'));

    assert.deepEqual(failures, []);
  });

  it('propagates every proto-required request field into OpenAPI schemas and query params', () => {
    assert.ok(protoRequiredRequestFields.length > 0, 'expected proto-required request fields');

    const specs = [];
    for (const file of serviceSpecs) {
      specs.push({ label: file, spec: JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')) });

      const yamlFile = file.replace(/\.json$/, '.yaml');
      specs.push({ label: yamlFile, spec: loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8')) });
    }
    specs.push({
      label: 'worldmonitor.openapi.yaml',
      spec: loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8')),
    });

    const failures = [];
    for (const contract of protoRequiredRequestFields) {
      let schemaHits = 0;
      const queryNames = new Set([
        contract.jsonName,
        toSnakeName(contract.jsonName),
        contract.protoName,
        contract.queryName,
      ]);

      for (const { label, spec } of specs) {
        for (const [schemaName, schema] of matchingRequestSchemas(spec, contract.messageName)) {
          schemaHits++;
          if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, contract.jsonName)) {
            failures.push(`${label}: ${schemaName} missing property ${contract.jsonName} from ${contract.file}`);
            continue;
          }
          if (!Array.isArray(schema.required) || !schema.required.includes(contract.jsonName)) {
            failures.push(`${label}: ${schemaName}.required missing proto-required ${contract.jsonName} from ${contract.file}`);
          }
        }

        for (const [path, ops] of Object.entries(spec.paths ?? {})) {
          for (const [method, op] of Object.entries(ops ?? {})) {
            if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
            const requestSchema = requestSchemaForOperation(spec, op);
            if (!requestSchema || !schemaNameMatches(requestSchema.name, contract.messageName)) continue;

            for (const param of op.parameters ?? []) {
              if (param?.in !== 'query' || !queryNames.has(param.name)) continue;
              if (param.required !== true) {
                failures.push(`${label}: ${method.toUpperCase()} ${path} query ${param.name} must be required for proto-required ${contract.messageName}.${contract.jsonName}`);
              }
            }
          }
        }
      }

      if (schemaHits === 0) failures.push(`no OpenAPI schema found for proto-required ${contract.messageName}.${contract.jsonName} from ${contract.file}`);
    }

    assert.deepEqual(failures, []);
  });

  it('keeps OpenAPI-only required fields represented in schemas', () => {
    const fields = ['turnstileToken'];
    const jsonSpec = JSON.parse(readFileSync(resolve(apiDir, 'LeadsService.openapi.json'), 'utf8'));
    assertSchemaRequires(jsonSpec, 'RegisterInterestRequest', fields, 'LeadsService.openapi.json');

    const yamlSpec = loadYaml(readFileSync(resolve(apiDir, 'LeadsService.openapi.yaml'), 'utf8'));
    assertSchemaRequires(yamlSpec, 'RegisterInterestRequest', fields, 'LeadsService.openapi.yaml');

    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const matches = matchingRequestSchemas(bundle, 'RegisterInterestRequest');
    assert.equal(matches.length, 1, 'worldmonitor.openapi.yaml: expected one RegisterInterestRequest schema');
    const [[schemaName, schema]] = matches;
    assert.ok(
      Array.isArray(schema.required) && schema.required.includes('turnstileToken'),
      `worldmonitor.openapi.yaml: ${schemaName}.required must include turnstileToken`,
    );
  });

});
