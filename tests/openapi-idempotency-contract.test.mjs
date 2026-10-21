import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';
import { readIdempotencyExemptPaths } from '../scripts/lib/openapi-codegen.mjs';

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
const serviceYaml = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();

const IDEMPOTENCY_PATTERN = '^[\\x21-\\x7E]{1,255}$';
// Read the runtime's Set, not a copy: this test is the thing that would have to CATCH a
// drift between the gateway and the two injectors, so it must not hold a third literal
// that can drift alongside them.
const IDEMPOTENCY_EXEMPT_PATHS = readIdempotencyExemptPaths();
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

function assertIdempotencyParam(param, label) {
  assert.ok(param, `${label} is missing the Idempotency-Key header parameter`);
  assert.equal(param.name, 'Idempotency-Key', `${label} exact header name`);
  assert.equal(param.required, false, `${label} Idempotency-Key must be optional`);
  assert.equal(param.schema?.type, 'string', `${label} Idempotency-Key schema type`);
  assert.equal(param.schema?.minLength, 1, `${label} Idempotency-Key minLength`);
  assert.equal(param.schema?.maxLength, 255, `${label} Idempotency-Key maxLength`);
  assert.equal(param.schema?.pattern, IDEMPOTENCY_PATTERN, `${label} Idempotency-Key pattern`);
  // The description must be precise (issue #4769): the same-body precondition +
  // the 422 mismatch, per-authenticated-caller / per-IP scoping, and that a
  // batch-read POST replays a possibly-stale cached snapshot.
  const description = param.description ?? '';
  assert.match(
    description,
    /identical request body/i,
    `${label} description must state the same-body replay precondition`,
  );
  assert.match(description, /\b422\b/, `${label} description must reference the 422 body-mismatch`);
  assert.match(
    description,
    /authenticated caller/i,
    `${label} description must state per-authenticated-caller scoping`,
  );
  assert.match(
    description,
    /source IP/i,
    `${label} description must note the per-IP fallback for unauthenticated endpoints`,
  );
  assert.match(
    description,
    /stale/i,
    `${label} description must note the batch-read replays a possibly-stale snapshot`,
  );
}

function assertIdempotencyResponses(op, label) {
  assert.ok(op.responses?.['400'], `${label} must document invalid Idempotency-Key 400`);
  assert.ok(op.responses?.['409'], `${label} must document in-flight Idempotency-Key 409`);
  assert.ok(op.responses?.['422'], `${label} must document reused Idempotency-Key 422`);
  assert.ok(
    op.responses['409'].headers?.['Retry-After'],
    `${label} 409 response must document Retry-After`,
  );
  assert.ok(
    op.responses['409'].headers?.['Idempotency-Key'],
    `${label} 409 response must document echoed Idempotency-Key`,
  );
  assert.ok(
    op.responses['422'].headers?.['Idempotency-Key'],
    `${label} 422 response must document echoed Idempotency-Key`,
  );
  // The 2xx success response must document the replay markers — the only
  // observable signal for "was this a replay?". Async-enqueue POSTs use 202;
  // every other generated success uses 200.
  const successEntries = Object.entries(op.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code));
  assert.equal(successEntries.length, 1, `${label} must document exactly one 2xx success response`);
  const [successCode, success] = successEntries[0];
  const echoed = success.headers?.['Idempotency-Key'];
  assert.ok(echoed, `${label} ${successCode} response must document the echoed Idempotency-Key header`);
  assert.equal(echoed.schema?.type, 'string', `${label} ${successCode} Idempotency-Key must be a string header`);
  const replayed = success.headers?.['Idempotent-Replayed'];
  assert.ok(replayed, `${label} ${successCode} response must document the Idempotent-Replayed marker`);
  assert.equal(
    replayed.schema?.type,
    'boolean',
    `${label} ${successCode} Idempotent-Replayed must be a boolean header`,
  );
}

function assertApplicationIdempotencyOnly(op, label) {
  assert.equal(idempotencyParam(op), undefined, `${label} must not advertise generic response replay`);
  assert.equal(op.responses?.['409'], undefined, `${label} must not advertise generic in-flight replay`);
  assert.equal(op.responses?.['422'], undefined, `${label} must not advertise generic body replay conflicts`);
  for (const [, response] of Object.entries(op.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code))) {
    assert.equal(response.headers?.['Idempotency-Key'], undefined, `${label} must not echo a generic idempotency key`);
    assert.equal(response.headers?.['Idempotent-Replayed'], undefined, `${label} must not advertise whole-response replay`);
  }
  // The parameter list and the 400 prose are written by two different injectors. Check
  // them against each other, not each against its own copy of the exempt set: an edit to
  // the rate-limit injector alone is otherwise invisible to every check in the repo.
  assert.doesNotMatch(
    op.responses?.['400']?.description ?? '',
    /Idempotency-Key/,
    `${label} 400 must not blame a header the operation does not accept`,
  );
}

function assertOperationIdempotency(path, op, label) {
  if (IDEMPOTENCY_EXEMPT_PATHS.has(path)) {
    assertApplicationIdempotencyOnly(op, label);
    return;
  }
  assertIdempotencyParam(idempotencyParam(op), label);
  assertIdempotencyResponses(op, label);
  // Mirror assertion: a non-exempt POST advertises the header, so its 400 must say so.
  assert.match(
    op.responses?.['400']?.description ?? '',
    /Idempotency-Key/,
    `${label} 400 must document the Idempotency-Key failure mode it accepts`,
  );
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
        const label = `${file} ${path} POST`;
        assertOperationIdempotency(path, op, label);
      }
    });
  }

  for (const file of serviceYaml) {
    it(`${file}: every POST documents the full Idempotency-Key contract`, () => {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      for (const [path, op] of postOps(spec)) {
        const label = `${file} ${path} POST`;
        assertOperationIdempotency(path, op, label);
      }
    });
  }

  it('bundle (worldmonitor.openapi.yaml → /openapi.json) covers every POST', () => {
    const bundle = loadUnifiedOpenApiSpec();
    const ops = postOps(bundle);
    assert.ok(ops.length > 0, 'bundle has POST operations');
    for (const [path, op] of ops) {
      const label = `bundle ${path} POST`;
      assertOperationIdempotency(path, op, label);
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
