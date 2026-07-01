import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the API contracts injected by the OpenAPI post-generation scripts:
// auth/security (scripts/openapi-inject-security.mjs, #4599 root cause #1) and
// required query/body fields (scripts/openapi-inject-required.mjs, #4604 / #4599
// root cause #3). If a regenerate lands without either injection step, these
// assertions fail and flag the drop.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const protoWorldmonitorDir = resolve(root, 'proto/worldmonitor');

// Public (no-auth) RPCs — parsed from the same source of truth the injector
// uses (server/gateway.ts). These opt out of the security requirement.
function readPublicNoAuthPaths() {
  const src = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
  const block = src.match(/PUBLIC_NO_AUTH_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not parse PUBLIC_NO_AUTH_RPC_PATHS from server/gateway.ts');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function readEndpointEntitlementPaths() {
  const src = readFileSync(resolve(root, 'server/_shared/entitlement-check.ts'), 'utf8');
  const block = src.match(/ENDPOINT_ENTITLEMENTS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, 'could not parse ENDPOINT_ENTITLEMENTS from server/_shared/entitlement-check.ts');
  return [...block[1].matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
}

function readPremiumRpcPaths() {
  const src = readFileSync(resolve(root, 'src/shared/premium-paths.ts'), 'utf8');
  const block = src.match(/PREMIUM_RPC_PATHS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not parse PREMIUM_RPC_PATHS from src/shared/premium-paths.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const PUBLIC_PATHS = readPublicNoAuthPaths();
const BEARER_AUTH_PATHS = new Set([...readEndpointEntitlementPaths(), ...readPremiumRpcPaths()]);

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

describe('OpenAPI security contract', () => {
  it('audits at least the full known service surface', () => {
    assert.ok(serviceSpecs.length >= 34, `expected >= 34 service specs, found ${serviceSpecs.length}`);
  });

  it('parses the bearer-auth path sources from gateway-adjacent code', () => {
    assert.ok(BEARER_AUTH_PATHS.size > 0, 'expected at least one bearer-auth path');
    assert.ok(BEARER_AUTH_PATHS.has('/api/market/v1/analyze-stock'), 'expected tier-gated market path');
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
    });
  }

  it('bundle (worldmonitor.openapi.yaml) carries global API-key security + schemes', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertSecurityNames(bundle.security, API_KEY_SECURITY_NAMES, 'bundle: root');
    const schemes = bundle.components?.securitySchemes ?? {};
    assertSchemeFields(schemes, API_KEY_SCHEMES, 'bundle');
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
