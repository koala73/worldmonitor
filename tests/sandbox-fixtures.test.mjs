import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_OPERATIONS, buildSandboxFixtures } from '../scripts/generate-sandbox-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The sandbox (public/sandbox/, docs/sandbox.mdx) advertises deterministic
// sample responses derived from the generated OpenAPI examples. This guard
// regenerates the fixtures in-memory and compares byte-for-byte against the
// committed files, so a proto/example regeneration can never leave the
// sandbox drifted from the published contract.
describe('sandbox fixtures (public/sandbox/)', () => {
  const files = buildSandboxFixtures(ROOT);

  it('committed fixtures match a fresh regeneration byte-for-byte', () => {
    for (const [rel, content] of Object.entries(files)) {
      let committed;
      assert.doesNotThrow(
        () => {
          committed = readFileSync(join(ROOT, rel), 'utf8');
        },
        `${rel} missing — run: node scripts/generate-sandbox-fixtures.mjs`,
      );
      assert.equal(
        committed,
        content,
        `${rel} drifted — run: node scripts/generate-sandbox-fixtures.mjs`,
      );
    }
  });

  it('index.json lists every curated operation with a resolvable fixture file', () => {
    const index = JSON.parse(readFileSync(join(ROOT, 'public/sandbox/index.json'), 'utf8'));
    assert.equal(index.kind, 'sandbox-index');
    assert.equal(index.operations.length, SANDBOX_OPERATIONS.length);
    for (const op of index.operations) {
      assert.ok(SANDBOX_OPERATIONS.includes(op.path), `unexpected sandbox operation ${op.path}`);
      const slug = op.path.split('/').at(-1);
      assert.equal(op.fixture, `https://www.worldmonitor.app/sandbox/${slug}.json`);
      const fixture = JSON.parse(readFileSync(join(ROOT, `public/sandbox/${slug}.json`), 'utf8'));
      assert.equal(fixture.sandbox, true, `${slug}: fixtures must self-identify as sandbox data`);
      assert.equal(fixture.operation.path, op.path);
      assert.equal(fixture.response.status, 200);
      assert.ok(
        fixture.response.body && typeof fixture.response.body === 'object',
        `${slug}: fixture must carry a non-empty example body`,
      );
    }
  });
});
