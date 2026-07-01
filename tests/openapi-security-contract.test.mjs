import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the API-key security contract injected by
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
const PUBLIC_PATHS = readPublicNoAuthPaths();

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const EXPECTED_SCHEMES = {
  WorldMonitorKey: { type: 'apiKey', in: 'header', name: 'X-WorldMonitor-Key' },
  ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  BearerAuth: { type: 'http', scheme: 'bearer' },
};

const serviceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

describe('OpenAPI security contract', () => {
  it('audits at least the full known service surface', () => {
    assert.ok(serviceSpecs.length >= 34, `expected >= 34 service specs, found ${serviceSpecs.length}`);
  });

  for (const file of serviceSpecs) {
    describe(file, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));

      it('defines the three security schemes with the correct headers', () => {
        const schemes = spec.components?.securitySchemes;
        assert.ok(schemes, `${file}: components.securitySchemes missing`);
        for (const [name, expected] of Object.entries(EXPECTED_SCHEMES)) {
          assert.ok(schemes[name], `${file}: securityScheme ${name} missing`);
          for (const [k, v] of Object.entries(expected)) {
            assert.equal(schemes[name][k], v, `${file}: ${name}.${k} should be ${v}`);
          }
        }
      });

      it('declares a root security requirement (OR of the schemes)', () => {
        assert.ok(Array.isArray(spec.security), `${file}: root security must be an array`);
        const names = spec.security.map((r) => Object.keys(r)[0]);
        for (const scheme of Object.keys(EXPECTED_SCHEMES)) {
          assert.ok(names.includes(scheme), `${file}: root security missing ${scheme}`);
        }
      });

      it('defines the UnauthorizedError schema', () => {
        const s = spec.components?.schemas?.UnauthorizedError;
        assert.ok(s, `${file}: components.schemas.UnauthorizedError missing`);
        assert.ok(
          Array.isArray(s.required) && s.required.includes('error'),
          `${file}: UnauthorizedError must require 'error'`,
        );
      });

      it('documents a 401 on authenticated ops, and marks public ops security:[]', () => {
        for (const [path, ops] of Object.entries(spec.paths ?? {})) {
          const isPublic = PUBLIC_PATHS.has(path);
          for (const [method, op] of Object.entries(ops)) {
            if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
            const label = `${method.toUpperCase()} ${path}`;
            if (isPublic) {
              assert.ok(
                Array.isArray(op.security) && op.security.length === 0,
                `${file}: public ${label} must set security: [] (opt out of auth)`,
              );
              assert.equal(op.responses?.['401'], undefined, `${file}: public ${label} must not carry a 401`);
            } else {
              const r401 = op.responses?.['401'];
              assert.ok(r401, `${file}: ${label} missing 401 response`);
              assert.equal(
                r401.content?.['application/json']?.schema?.$ref,
                '#/components/schemas/UnauthorizedError',
                `${file}: ${label} 401 must reference UnauthorizedError`,
              );
            }
          }
        }
      });
    });
  }

  it('bundle (worldmonitor.openapi.yaml) carries global security + schemes', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assert.ok(Array.isArray(bundle.security) && bundle.security.length === 3, 'bundle root security missing');
    const schemes = bundle.components?.securitySchemes ?? {};
    for (const scheme of Object.keys(EXPECTED_SCHEMES)) {
      assert.ok(schemes[scheme], `bundle: securityScheme ${scheme} missing`);
    }
  });
});
