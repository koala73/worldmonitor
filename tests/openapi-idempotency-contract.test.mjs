import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the Idempotency-Key header parameter injected by
// scripts/openapi-inject-idempotency.mjs onto every POST (mutation) operation.
// The gateway (server/_shared/idempotency.ts) honors the header at runtime;
// this test keeps the published contract in sync so agents (and the ora.ai /
// orank scanner, which falls back to the spec for auth-gated routes) always
// see the documented support. A fresh `make generate` must re-run the injector.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const serviceJson = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

function idempotencyParam(op) {
  return (op?.parameters ?? []).find(
    (p) => p && p.in === 'header' && String(p.name).toLowerCase() === 'idempotency-key',
  );
}

function postOps(spec) {
  const out = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (ops && typeof ops === 'object' && ops.post && typeof ops.post === 'object') {
      out.push([path, ops.post]);
    }
  }
  return out;
}

describe('OpenAPI Idempotency-Key contract', () => {
  it('has at least one POST operation to protect', () => {
    const total = serviceJson.reduce(
      (n, f) => n + postOps(JSON.parse(readFileSync(resolve(apiDir, f), 'utf8'))).length,
      0,
    );
    assert.ok(total > 0, 'expected POST operations in the generated specs');
  });

  for (const file of serviceJson) {
    it(`${file}: every POST documents an Idempotency-Key header`, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      for (const [path, op] of postOps(spec)) {
        const param = idempotencyParam(op);
        assert.ok(param, `${file} ${path} POST is missing the Idempotency-Key header parameter`);
        assert.equal(param.name, 'Idempotency-Key', `${file} ${path} exact header name`);
        assert.equal(param.required, false, `${file} ${path} Idempotency-Key must be optional`);
        assert.equal(param.schema?.type, 'string', `${file} ${path} Idempotency-Key schema type`);
        assert.equal(param.schema?.maxLength, 255, `${file} ${path} Idempotency-Key maxLength`);
      }
    });
  }

  it('bundle (worldmonitor.openapi.yaml → /openapi.json) covers every POST', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const ops = postOps(bundle);
    assert.ok(ops.length > 0, 'bundle has POST operations');
    for (const [path, op] of ops) {
      assert.ok(
        idempotencyParam(op),
        `bundle ${path} POST is missing the Idempotency-Key header parameter`,
      );
    }
  });

  it('specs are in sync with the injector (make generate would not change them)', () => {
    // Fails closed if a regenerate/rebase dropped the injected parameter.
    execFileSync('node', ['scripts/openapi-inject-idempotency.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
