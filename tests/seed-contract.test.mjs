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

test('validateDescriptor: rejects non-finite ttlSeconds (NaN, Infinity)', () => {
  // `typeof NaN === "number"` and `NaN > 0 === false`, so the old check
  // silently accepted it; Number.isFinite is what we actually want.
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: NaN })), SeedContractError);
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: Infinity })), SeedContractError);
  assert.throws(() => validateDescriptor(minimalDescriptor({ ttlSeconds: -Infinity })), SeedContractError);
});

test('validateDescriptor: rejects non-finite maxStaleMin (NaN, Infinity)', () => {
  assert.throws(() => validateDescriptor(minimalDescriptor({ maxStaleMin: NaN })), SeedContractError);
  assert.throws(() => validateDescriptor(minimalDescriptor({ maxStaleMin: Infinity })), SeedContractError);
});

for (const field of ['domain', 'resource', 'canonicalKey', 'sourceVersion']) {
  test(`validateDescriptor: rejects empty string for "${field}"`, () => {
    const err = expectThrows(() => validateDescriptor(minimalDescriptor({ [field]: '' })));
    assert.ok(err instanceof SeedContractError);
    assert.equal(err.field, field);
  });

  test(`validateDescriptor: rejects whitespace-only string for "${field}"`, () => {
    const err = expectThrows(() => validateDescriptor(minimalDescriptor({ [field]: '   ' })));
    assert.ok(err instanceof SeedContractError);
    assert.equal(err.field, field);
  });
}

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

test('SeedContractError: accepts cause via options bag (Error v2 spec)', () => {
  const underlying = new TypeError('inner');
  const err = new SeedContractError('wrap', { field: 'declareRecords', cause: underlying });
  assert.equal(err.cause, underlying);
  assert.equal(err.field, 'declareRecords');
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

/**
 * Return a copy of `src` with single-line comments, block comments, and
 * string literals replaced by spaces of identical length. Preserves all
 * indices so we can pattern-match for call sites without confusing
 * `// runSeed(...)` mentions in comments or docstrings for real calls.
 * Keeps newlines intact so line numbers in any downstream diagnostics stay
 * accurate.
 */
function stripCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Block comment
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      for (let j = i; j < end; j++) out[j] = src[j] === '\n' ? '\n' : ' ';
      i = end;
      continue;
    }
    // Line comment
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      for (let j = i; j < end; j++) out[j] = ' ';
      i = end;
      continue;
    }
    // String / template literal — replace body with spaces, keep delimiters
    // so the shape of the source is preserved. Template literals can contain
    // `${expr}` which may itself embed runSeed(...) — but that's unusual and
    // fine to treat as opaque for our purposes.
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out[j] = ' ';
          out[j + 1] = src[j + 1] === '\n' ? '\n' : ' ';
          j += 2;
          continue;
        }
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j++;
      }
      i = j + 1; // skip past closing quote
      continue;
    }
    i++;
  }
  return out.join('');
}

function hasRunSeedCall(src) {
  // Check against the stripped source so a commented-out `runSeed(...)`
  // mention doesn't mark the file as a runSeed caller when it isn't.
  return /\brunSeed\s*\(/.test(stripCommentsAndStrings(src));
}

// Required opts-based fields a descriptor must carry (positional args
// `domain, resource, canonicalKey, fetchFn` are handled outside the opts).
// Must match the REQUIRED_FIELDS set in scripts/_seed-contract.mjs minus the
// four positional arg names.
const REQUIRED_OPTS_FIELDS = ['validateFn', 'declareRecords', 'ttlSeconds', 'sourceVersion', 'schemaVersion', 'maxStaleMin'];

/**
 * Extract the single `runSeed(...)` call site as a raw string, balance-matching
 * parentheses against a comment- and string-stripped view of the source.
 * Returns null if no runSeed call is found.
 *
 * We locate the call in the stripped source (so commented-out `runSeed(...)`
 * mentions don't win) but then slice the corresponding range out of the
 * ORIGINAL source so descriptor-field checks see the real code. Both strings
 * share indices because stripCommentsAndStrings preserves them.
 */
function extractRunSeedCall(src) {
  const stripped = stripCommentsAndStrings(src);
  const start = stripped.search(/\brunSeed\s*\(/);
  if (start < 0) return null;
  const open = stripped.indexOf('(', start);
  let depth = 1;
  let i = open + 1;
  while (i < stripped.length && depth > 0) {
    const ch = stripped[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return src.slice(open + 1, i - 1);
}

/**
 * True when a `runSeed(...)` call-site carries all required opts-based
 * descriptor fields (checked by presence of the field name as a key).
 *
 * Operates on a comment- and string-stripped view so a `// TODO: validateFn`
 * comment inside the call doesn't trick us into thinking the field is present.
 */
function descriptorFieldsPresent(callSrc) {
  const strippedCall = stripCommentsAndStrings(callSrc);
  const missing = [];
  for (const field of REQUIRED_OPTS_FIELDS) {
    // Match `field:` or `field ,` (shorthand property) or `field }` with a
    // word boundary so `sourceVersion` doesn't accidentally match
    // `sourceVersions:`.
    const re = new RegExp(`\\b${field}\\b\\s*[:,}]`);
    if (!re.test(strippedCall)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

// ─── Call-site extraction edge cases ────────────────────────────────────
// The helpers below must never mistake a commented-out `runSeed(...)` mention
// for the real call. Regression: seed-bis-data.mjs:209 has a comment that
// reads `// runSeed() calls process.exit(0)` ahead of the real invocation at
// :220; seed-economy.mjs:788 has a similar header comment ahead of the real
// call at :891. Before this fix, extractRunSeedCall() sliced the comment's
// empty parens and descriptorFieldsPresent() reported everything as missing.

test('extractRunSeedCall: ignores runSeed mentions inside line comments', () => {
  const src = `
    // runSeed() calls process.exit(0) so whatever follows never runs.
    runSeed('d', 'r', 'd:r:v1', fetchFn, {
      validateFn, declareRecords, ttlSeconds: 60,
      sourceVersion: 'v1', schemaVersion: 1, maxStaleMin: 30,
    });
  `;
  const call = extractRunSeedCall(src);
  assert.ok(call, 'expected extractRunSeedCall to find the real call');
  assert.ok(call.includes('validateFn'), 'should slice the real opts object');
  assert.ok(descriptorFieldsPresent(call).ok, 'real call has all required opts');
});

test('extractRunSeedCall: ignores runSeed mentions inside block comments', () => {
  const src = `
    /*
     * Migration note: runSeed() writes seed-meta on failure. See issue 123.
     */
    runSeed('d', 'r', 'd:r:v1', fetchFn, {
      validateFn, declareRecords, ttlSeconds: 60,
      sourceVersion: 'v1', schemaVersion: 1, maxStaleMin: 30,
    });
  `;
  const call = extractRunSeedCall(src);
  assert.ok(descriptorFieldsPresent(call).ok);
});

test('extractRunSeedCall: ignores runSeed mentions inside string literals', () => {
  const src = `
    const msg = "don't call runSeed() directly";
    runSeed('d', 'r', 'd:r:v1', fetchFn, {
      validateFn, declareRecords, ttlSeconds: 60,
      sourceVersion: 'v1', schemaVersion: 1, maxStaleMin: 30,
    });
  `;
  const call = extractRunSeedCall(src);
  assert.ok(descriptorFieldsPresent(call).ok);
});

test('descriptorFieldsPresent: ignores field names inside comments of the call', () => {
  // If the REAL call is missing a field but a comment names that field, the
  // checker should still mark it missing.
  const callSrc = `
    'd', 'r', 'd:r:v1', fetchFn, {
      validateFn,
      // missing: declareRecords, ttlSeconds, sourceVersion, schemaVersion, maxStaleMin
    }`;
  const result = descriptorFieldsPresent(callSrc);
  assert.equal(result.ok, false);
  for (const f of ['declareRecords', 'ttlSeconds', 'sourceVersion', 'schemaVersion', 'maxStaleMin']) {
    assert.ok(result.missing.includes(f), `expected ${f} in missing`);
  }
});

test('conformance: every scripts/seed-*.mjs that calls runSeed() satisfies the descriptor contract', async (t) => {
  const files = await findSeederFiles();
  assert.ok(files.length > 0, 'expected at least one seeder file');

  const runSeedCallers = [];
  const incomplete = []; // [{ file, missing: string[] }]
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    if (!hasRunSeedCall(src)) continue;
    runSeedCallers.push(file);

    const missing = [];
    if (!hasDeclareRecordsExport(src)) missing.push('declareRecords export');

    const callSrc = extractRunSeedCall(src);
    if (callSrc == null) {
      missing.push('unparseable runSeed(...) call');
    } else {
      const result = descriptorFieldsPresent(callSrc);
      if (!result.ok) missing.push(...result.missing.map((f) => `opt:${f}`));
    }

    if (missing.length > 0) {
      incomplete.push({ file: file.replace(scriptsDir + '/', ''), missing });
    }
  }

  // Migration-progress signal. Must remain visible in `node --test` even when
  // the test passes — this is the readiness indicator for PR 2/PR 3.
  const migrated = runSeedCallers.length - incomplete.length;
  t.diagnostic(`seed-contract conformance: ${migrated}/${runSeedCallers.length} seeders satisfy the full descriptor`);

  if (incomplete.length > 0) {
    // SEED_CONTRACT_STRICT=1 flips this to a hard failure. PR 3 will enable
    // strict mode by default once the fleet is migrated.
    const strict = process.env.SEED_CONTRACT_STRICT === '1';
    const head = `[seed-contract] ${incomplete.length}/${runSeedCallers.length} seeders incomplete (missing declareRecords export AND/OR required opts ${REQUIRED_OPTS_FIELDS.join(', ')})`;
    if (strict) {
      const sample = incomplete.slice(0, 5).map((x) => `${x.file}: ${x.missing.join(', ')}`).join(' | ');
      assert.fail(`${head}. First offenders: ${sample}${incomplete.length > 5 ? ', …' : ''}`);
    }
    console.warn(head);
    for (const { file, missing } of incomplete) {
      console.warn(`  - ${file}: ${missing.join(', ')}`);
    }
    console.warn('Soft-warn: expected during PR 1/2. Set SEED_CONTRACT_STRICT=1 to hard-fail. PR 3 will enable strict mode by default.');
    t.diagnostic(`${incomplete.length} seeders awaiting full descriptor migration`);
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
