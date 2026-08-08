import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const canonical = JSON.parse(
  await readFile(resolve(REPO_ROOT, 'shared/diplomacy-keywords.json'), 'utf8'),
);

function readFromRoot(relPath) {
  return readFile(resolve(REPO_ROOT, relPath), 'utf8');
}

function literalBlock(src, constName) {
  const re = new RegExp(
    `const\\s+${constName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as\\s+const\\s*)?;`,
  );
  const m = src.match(re);
  assert.ok(m, `expected to find \`const ${constName} = [ ... ]\` in source`);
  return m[1];
}

function parseStringArrayLiteral(src, constName) {
  const block = literalBlock(src, constName);
  const items = [...block.matchAll(/'([^']+)'/g)].map((g) => g[1]);
  assert.ok(items.length > 0, `expected at least one string in ${constName}`);
  return items;
}

function parsePairArrayLiteral(src, constName) {
  const block = literalBlock(src, constName);
  const pairs = [...block.matchAll(/\['([^']+)'\s*,\s*'([^']+)'\]/g)].map((g) => [g[1], g[2]]);
  assert.ok(pairs.length > 0, `expected at least one pair in ${constName}`);
  return pairs;
}

test('canonical JSON has the expected shape', () => {
  assert.ok(Array.isArray(canonical.diplomacyKeywords));
  assert.ok(canonical.diplomacyKeywords.length >= 10);
  assert.ok(Array.isArray(canonical.flashpointKeywords));
  assert.ok(canonical.flashpointKeywords.length >= 15);
  assert.ok(Array.isArray(canonical.diplomacyFlashpointPairs));
  assert.ok(canonical.diplomacyFlashpointPairs.length >= 15);
  for (const pair of canonical.diplomacyFlashpointPairs) {
    assert.ok(Array.isArray(pair) && pair.length === 2, 'each pair must be [string, string]');
    assert.strictEqual(typeof pair[0], 'string');
    assert.strictEqual(typeof pair[1], 'string');
  }
});

test('shared/brief-filter.js sources keywords from canonical JSON', async () => {
  const src = await readFromRoot('shared/brief-filter.js');
  assert.match(
    src,
    /import\s+diplomacyKeywordsData\s+from\s+['"]\.\/diplomacy-keywords\.json['"]/,
    'brief-filter.js must import the canonical JSON',
  );
  assert.doesNotMatch(
    src,
    /const\s+DIPLOMACY_KEYWORDS\s*=\s*\[\s*'ceasefire'/,
    'brief-filter.js must not redefine DIPLOMACY_KEYWORDS inline',
  );
  assert.doesNotMatch(
    src,
    /const\s+FLASHPOINT_KEYWORDS\s*=\s*\[\s*'iran'/,
    'brief-filter.js must not redefine FLASHPOINT_KEYWORDS inline',
  );
});

test('scripts/_clustering.mjs sources keywords from canonical JSON', async () => {
  const src = await readFromRoot('scripts/_clustering.mjs');
  // Either `./shared/diplomacy-keywords.json` (scripts/shared mirror)
  // or `../shared/diplomacy-keywords.json` (root) is acceptable.
  // _clustering.mjs uses the mirror because seed-insights.mjs deploys
  // via nixpacks with rootDirectory=scripts. The mirror is enforced
  // byte-identical by tests/edge-functions.test.mjs.
  assert.match(
    src,
    /require\(\s*['"]\.{1,2}\/shared\/diplomacy-keywords\.json['"]\s*\)/,
    '_clustering.mjs must require the canonical JSON',
  );
  assert.doesNotMatch(
    src,
    /export\s+const\s+DIPLOMACY_KEYWORDS\s*=\s*\[\s*'ceasefire'/,
    '_clustering.mjs must not redefine DIPLOMACY_KEYWORDS inline',
  );
  assert.doesNotMatch(
    src,
    /export\s+const\s+ENTITY_BIGRAMS\s*=\s*\[\s*\[\s*'iran'/,
    '_clustering.mjs must not redefine ENTITY_BIGRAMS inline',
  );
});

test('scripts/seed-digest-notifications.mjs sources keywords from canonical JSON', async () => {
  const src = await readFromRoot('scripts/seed-digest-notifications.mjs');
  // Either `./shared/...` (scripts/shared mirror) or `../shared/...`
  // (root). seed-digest-notifications runs under Dockerfile.digest-
  // notifications which COPYs root shared/ explicitly, so `../shared/`
  // is fine. Accepting both forms keeps the test robust to a future
  // Docker-vs-nixpacks repackaging.
  assert.match(
    src,
    /require\(\s*['"]\.{1,2}\/shared\/diplomacy-keywords\.json['"]\s*\)/,
    'seed-digest-notifications.mjs must require the canonical JSON',
  );
  assert.doesNotMatch(
    src,
    /const\s+DIGEST_DIPLOMACY_KEYWORDS\s*=\s*\[\s*'ceasefire'/,
    'seed-digest-notifications.mjs must not redefine DIGEST_DIPLOMACY_KEYWORDS inline',
  );
});

test('server/worldmonitor/news/v1/list-feed-digest.ts sources keywords from canonical JSON', async () => {
  const src = await readFromRoot('server/worldmonitor/news/v1/list-feed-digest.ts');
  assert.match(
    src,
    /import\s+diplomacyKeywordsData\s+from\s+['"]\.\.\/\.\.\/\.\.\/\.\.\/shared\/diplomacy-keywords\.json['"]/,
    'list-feed-digest.ts must import the canonical JSON',
  );
  assert.doesNotMatch(
    src,
    /const\s+DIPLOMACY_KEYWORDS\s*=\s*\[\s*'ceasefire'/,
    'list-feed-digest.ts must not redefine DIPLOMACY_KEYWORDS inline',
  );
});

// Drift guards for the two intentionally-untouched mirror sites.
// ais-relay.cjs is the Railway-deployed monolith (refactoring it
// would break its bundled deploy assumptions); parallel-analysis.ts
// is a client-side ML helper with a narrower scope (flashpoint only).
// They keep their inline literals — but the literals MUST match the
// canonical JSON, so future edits in either file fail this test
// unless the JSON is updated in lockstep.

test('scripts/ais-relay.cjs RELAY_* literals match canonical JSON', async () => {
  const src = await readFromRoot('scripts/ais-relay.cjs');
  assert.deepEqual(
    parseStringArrayLiteral(src, 'RELAY_DIPLOMACY_KEYWORDS'),
    canonical.diplomacyKeywords,
    'RELAY_DIPLOMACY_KEYWORDS drifted from shared/diplomacy-keywords.json',
  );
  assert.deepEqual(
    parseStringArrayLiteral(src, 'RELAY_FLASHPOINT_SCORING_KEYWORDS'),
    canonical.flashpointKeywords,
    'RELAY_FLASHPOINT_SCORING_KEYWORDS drifted from shared/diplomacy-keywords.json',
  );
  assert.deepEqual(
    parsePairArrayLiteral(src, 'RELAY_DIPLOMACY_FLASHPOINT_PAIRS'),
    canonical.diplomacyFlashpointPairs,
    'RELAY_DIPLOMACY_FLASHPOINT_PAIRS drifted from shared/diplomacy-keywords.json',
  );
});

test('src/services/parallel-analysis.ts FLASHPOINT_KEYWORDS matches canonical JSON', async () => {
  const src = await readFromRoot('src/services/parallel-analysis.ts');
  assert.deepEqual(
    parseStringArrayLiteral(src, 'FLASHPOINT_KEYWORDS'),
    canonical.flashpointKeywords,
    'parallel-analysis.ts FLASHPOINT_KEYWORDS drifted from shared/diplomacy-keywords.json',
  );
});
