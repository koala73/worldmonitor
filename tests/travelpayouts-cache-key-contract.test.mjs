import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../server/worldmonitor/aviation/v1/_providers/travelpayouts_data.ts', import.meta.url),
  'utf8',
);

function blockBetween(start, end) {
  const startIndex = src.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = src.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing end marker after ${start}: ${end}`);
  return src.slice(startIndex, endIndex);
}

describe('Travelpayouts cache-key contract', () => {
  it('keys v3 day-precision cache by every upstream-varying request option', () => {
    const block = blockBetween('// v3: prices_for_dates', '} else if (isMonthPrecision)');

    assert.match(block, /if \(nonstopOnly\) params\.set\('direct', 'true'\)/);
    assert.match(block, /if \(market_\) params\.set\('market', market_\)/);
    assert.match(block, /limit: String\(Math\.min\(maxResults, 30\)\)/);
    assert.match(
      block,
      /const cacheKey = `tp:v3:\$\{origin\}:\$\{destination\}:\$\{departureDate\}:\$\{returnDate\}:\$\{cabin\}:\$\{currency_\}:\$\{market_\}:\$\{nonstopOnly\}:\$\{Math\.min\(maxResults, 30\)\}:v2`/,
    );
  });

  it('keeps month-matrix cache keyed only by upstream-varying options', () => {
    const block = blockBetween('// v2: month-matrix', '// v2: latest');

    assert.doesNotMatch(block, /params\.set\('direct'/);
    assert.doesNotMatch(block, /limit: String\(Math\.min\(maxResults, 30\)\)/);
    assert.match(block, /const cacheKey = `tp:month:\$\{origin\}:\$\{destination\}:\$\{departureDate\}:\$\{cabin\}:\$\{currency_\}:v1`/);
    assert.match(block, /nonstopOnly \? data\.filter\(r => \(r\.number_of_changes \?\? 0\) === 0\) : data/);
    assert.match(block, /rows\.slice\(0, maxResults\)/);
  });

  it('keys latest cache by upstream-varying trip shape and capped limit', () => {
    const block = blockBetween('// v2: latest', '// Save 7-day price snapshot');

    assert.match(block, /one_way: returnDate \? 'false' : 'true'/);
    assert.match(block, /limit: String\(Math\.min\(maxResults, 30\)\)/);
    assert.match(
      block,
      /const cacheKey = `tp:latest:\$\{origin\}:\$\{destination\}:\$\{cabin\}:\$\{currency_\}:\$\{returnDate \? 'roundtrip' : 'oneway'\}:\$\{Math\.min\(maxResults, 30\)\}:v2`/,
    );
    assert.match(block, /nonstopOnly \? data\.filter\(r => \(r\.number_of_changes \?\? 0\) === 0\) : data/);
  });
});
