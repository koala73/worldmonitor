import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const seederSource = readFileSync(resolve(here, '../scripts/seed-forecasts.mjs'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = seederSource.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = seederSource.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return seederSource.slice(startIndex, endIndex);
}

test('market implications defines an error seed-meta writer keyed for /api/health', () => {
  assert.match(
    seederSource,
    /const MARKET_IMPLICATIONS_META_KEY = 'seed-meta:intelligence:market-implications'/,
    'meta key must match api/health.js SEED_META.marketImplications',
  );
  assert.match(seederSource, /async function writeMarketImplicationsFailureMeta\(reason\)/);

  const writerRegion = sourceBetween(
    'async function writeMarketImplicationsFailureMeta(reason)',
    'async function buildAndSeedMarketImplications(inputs)',
  );
  // status:'error' is what api/health.js readSeedMeta promotes to seedError ->
  // classifyKey emits SEED_ERROR (warn) instead of a silently-frozen EMPTY.
  assert.match(writerRegion, /status: 'error'/);
  assert.match(writerRegion, /errorReason: marketImplicationsMetaErrorReason\(reason\)/);
  assert.match(writerRegion, /recordCount: 0/);
  // Last-good canonical cards are preserved across the LLM outage via EXPIRE.
  assert.match(writerRegion, /\['EXPIRE', MARKET_IMPLICATIONS_KEY, String\(MARKET_IMPLICATIONS_TTL\)\]/);
});

test('all three LLM-failure guards write an error seed-meta before returning', () => {
  const buildRegion = sourceBetween(
    'async function buildAndSeedMarketImplications(inputs)',
    'export function declareRecords(data)',
  );

  // Guard 1: LLM returned no response.
  assert.match(
    buildRegion,
    /if \(!result\?\.text\) \{[\s\S]*?await writeMarketImplicationsFailureMeta\('llm_no_response'\);\s*return;/,
  );
  // Guard 2: no parseable cards.
  assert.match(
    buildRegion,
    /rawCards\.length === 0\) \{[\s\S]*?await writeMarketImplicationsFailureMeta\('no_parseable_cards'\);\s*return;/,
  );
  // Guard 3: all cards failed validation.
  assert.match(
    buildRegion,
    /cards\.length === 0\) \{[\s\S]*?await writeMarketImplicationsFailureMeta\('all_cards_failed_validation'\);\s*return;/,
  );
});

test('market implications success path still writes a healthy seed-meta', () => {
  const buildRegion = sourceBetween(
    'async function buildAndSeedMarketImplications(inputs)',
    'export function declareRecords(data)',
  );
  assert.match(buildRegion, /recordCount: cards\.length, status: 'ok'/);
  assert.match(buildRegion, /await redisSet\(url, token, MARKET_IMPLICATIONS_META_KEY, meta, MARKET_IMPLICATIONS_META_TTL\)/);
});
