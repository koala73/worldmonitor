import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards two OpenAPI completeness invariants restored by the #4599 follow-ups:
//   C — every generated operation carries a non-empty description (the sebuf
//       generator emits it from the RPC's leading proto comment; 10 RPCs had none).
//   D — an operation is marked `deprecated: true` (injected by
//       scripts/openapi-inject-deprecated.mjs from the proto `option deprecated`)
//       iff its description marks it DISABLED. The DISABLED prose and the
//       deprecated flag are two independent signals that must agree, so a regen
//       that drops the injector — or a proto that gains one signal but not the
//       other — fails here.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

const serviceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

function operationEntries(spec) {
  const entries = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      entries.push({ path, method, op });
    }
  }
  return entries;
}

describe('OpenAPI deprecated + operation-description contract', () => {
  it('gives every operation a non-empty description', () => {
    const missing = [];
    for (const file of serviceSpecs) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      for (const { path, method, op } of operationEntries(spec)) {
        if (!(op.description ?? '').trim()) missing.push(`${file} ${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(missing, [], `operations missing a description:\n${missing.join('\n')}`);
  });

  it('marks an operation deprecated iff it is documented DISABLED, in every artifact', () => {
    const yamlFiles = readdirSync(apiDir)
      .filter((f) => /Service\.openapi\.json$/.test(f))
      .sort();
    let deprecatedCount = 0;
    for (const file of yamlFiles) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      for (const { path, method, op } of operationEntries(spec)) {
        const label = `${file} ${method.toUpperCase()} ${path}`;
        const isDisabled = /\bDISABLED\b/.test(op.description ?? '');
        const isDeprecated = op.deprecated === true;
        assert.equal(
          isDeprecated,
          isDisabled,
          `${label}: deprecated=${isDeprecated} but DISABLED-in-description=${isDisabled} — the two signals must agree`,
        );
        if (isDeprecated) deprecatedCount++;
      }
    }
    assert.ok(deprecatedCount >= 1, 'expected at least one deprecated operation (the disabled company endpoints)');
  });
});
