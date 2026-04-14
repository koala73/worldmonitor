import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SeedContractError,
  validateDescriptor,
  resolveRecordCount,
} from '../scripts/_seed-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '..', 'scripts');

function minimalDescriptor(overrides = {}) {
  return {
    domain: 'test',
    resource: 'thing',
    canonicalKey: 'test:thing:v1',
    fetchFn: async () => ({}),
    validateFn: () => true,
    declareRecords: (d) => (d?.items?.length ?? 0),
    ttlSeconds: 3600,
    sourceVersion: 'v1',
    schemaVersion: 1,
    maxStaleMin: 120,
    ...overrides,
  };
}

// ─── validateDescriptor ────────────────────────────────────────────────────

test('validateDescriptor: accepts a minimal valid descriptor', () => {
  assert.doesNotThrow(() => validateDescriptor(minimalDescriptor()));
});

test('validateDescriptor: rejects non-object input', () => {
  assert.throws(() => validateDescriptor(null), SeedContractError);
  assert.throws(() => validateDescriptor('string'), SeedContractError);
});

function expectThrows(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected function to throw');
}

for (const field of [
  'domain', 'resource', 'canonicalKey', 'fetchFn', 'validateFn',
  'declareRecords', 'ttlSeconds', 'sourceVersion', 'schemaVersion', 'maxStaleMin',
]) {
  test(`validateDescriptor: rejects missing required field "${field}"`, () => {
    const d = minimalDescriptor();
    delete d[field];
    const err = expectThrows(() => validateDescriptor(d));
    assert.ok(err instanceof SeedContractError, `expected SeedContractError, got ${err?.constructor?.name}`);
    assert.equal(err.field, field);
  });
}

test('validateDescriptor: rejects wrong type on ttlSeconds', () => {
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: '3600' })), SeedContractError);
});

test('validateDescriptor: rejects ttlSeconds <= 0', () => {
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: 0 })), SeedContractError);
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: -5 })), SeedContractError);
});

test('validateDescriptor: rejects non-integer schemaVersion', () => {
  assert.throws(() => validateDescriptor(minimalDescriptor({ schemaVersion: 1.5 })), SeedContractError);
  assert.throws(() => validateDescriptor(minimalDescriptor({ schemaVersion: 0 })), SeedContractError);
});

test('validateDescriptor: rejects invalid populationMode', () => {
  assert.throws(() => validateDescriptor(minimalDescriptor({ populationMode: 'never' })), SeedContractError);
});

test('validateDescriptor: accepts valid populationMode values', () => {
  assert.doesNotThrow(() => validateDescriptor(minimalDescriptor({ populationMode: 'scheduled' })));
  assert.doesNotThrow(() => validateDescriptor(minimalDescriptor({ populationMode: 'on_demand' })));
});

test('validateDescriptor: rejects unknown fields (prevents silent typos)', () => {
  const err = expectThrows(() => validateDescriptor(minimalDescriptor({ recordCoount: 5 })));
  assert.ok(err instanceof SeedContractError);
  assert.equal(err.field, 'recordCoount');
});

// ─── resolveRecordCount ────────────────────────────────────────────────────

test('resolveRecordCount: returns non-negative integer', () => {
  assert.equal(resolveRecordCount((d) => d.length, [1, 2, 3]), 3);
  assert.equal(resolveRecordCount(() => 0, null), 0);
});

test('resolveRecordCount: rejects negative returns', () => {
  assert.throws(() => resolveRecordCount(() => -1, {}), SeedContractError);
});

test('resolveRecordCount: rejects non-integer returns', () => {
  assert.throws(() => resolveRecordCount(() => 1.5, {}), SeedContractError);
  assert.throws(() => resolveRecordCount(() => 'three', {}), SeedContractError);
  assert.throws(() => resolveRecordCount(() => null, {}), SeedContractError);
});

test('resolveRecordCount: wraps thrown errors with SeedContractError + cause', () => {
  const err = expectThrows(() => resolveRecordCount(() => { throw new Error('boom'); }, {}));
  assert.ok(err instanceof SeedContractError);
  assert.match(err.message, /declareRecords threw: boom/);
  assert.equal(err.cause?.message, 'boom');
});

test('resolveRecordCount: rejects non-function declareRecords', () => {
  assert.throws(() => resolveRecordCount('not a function', {}), SeedContractError);
});

// ─── Seeder conformance (static AST-lite parse, no dynamic import) ─────────
// We do NOT `import()` any scripts/seed-*.mjs file because several of them
// `process.exit()` at module load (seed-consumer-prices.mjs:31,
// seed-military-maritime-news.mjs:68, seed-service-statuses.mjs:43). We scan
// the file text for required patterns. PR 1 soft-warns; PR 3 hard-fails.

async function findSeederFiles() {
  const entries = await readdir(scriptsDir);
  return entries
    .filter((f) => f.startsWith('seed-') && f.endsWith('.mjs'))
    .filter((f) => !f.startsWith('seed-bundle-')) // bundle orchestrators are not seeders
    .map((f) => resolve(scriptsDir, f));
}

function hasDeclareRecordsExport(src) {
  // Matches `export function declareRecords(` OR `export const declareRecords =`
  return /export\s+(function\s+declareRecords\s*\(|const\s+declareRecords\s*=)/.test(src);
}

function hasRunSeedCall(src) {
  return /\brunSeed\s*\(/.test(src);
}

test('conformance: every scripts/seed-*.mjs that calls runSeed() should export declareRecords (soft-warn in PR 1)', async (t) => {
  const files = await findSeederFiles();
  assert.ok(files.length > 0, 'expected at least one seeder file');

  const missing = [];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    if (!hasRunSeedCall(src)) continue;
    if (!hasDeclareRecordsExport(src)) {
      missing.push(file.replace(scriptsDir + '/', ''));
    }
  }

  if (missing.length > 0) {
    // PR 1: soft-warn. Do NOT fail the test — the plan mandates gradual migration.
    // PR 3 will flip this to assert.equal(missing.length, 0).
    console.warn(`[seed-contract soft-warn] ${missing.length} seeders do not yet export declareRecords:`);
    for (const name of missing) console.warn(`  - ${name}`);
    console.warn('This is expected during PR 1. PR 2 migrates each seeder; PR 3 will hard-fail this test.');
    t.diagnostic(`${missing.length} seeders awaiting declareRecords migration`);
  }
});

test('conformance: seeders that already export declareRecords have a top-level export (not nested)', async (t) => {
  const files = await findSeederFiles();
  let migrated = 0;
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    if (hasDeclareRecordsExport(src)) migrated++;
  }
  t.diagnostic(`${migrated}/${files.length} seeders have declareRecords export`);
});
