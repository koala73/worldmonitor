import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
}

function normalizeCategoryName(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function parseWeightMap(source) {
  const match = source.match(/const WEIGHTS = \{([^}]+)\};/);
  assert.ok(match, 'seed-fear-greed WEIGHTS declaration not found');
  return new Map([...match[1].matchAll(/(\w+):\s*([0-9.]+)/g)]
    .map(([, name, weight]) => [normalizeCategoryName(name), Number(weight)]));
}

function parseDocCategoryWeights(doc) {
  const tableStart = doc.indexOf('| # | Category        | Weight | What It Measures |');
  assert.notEqual(tableStart, -1, 'Fear & Greed category table not found');
  const tableEnd = doc.indexOf('\n\n### Score Labels', tableStart);
  assert.notEqual(tableEnd, -1, 'Fear & Greed category table end not found');
  const table = doc.slice(tableStart, tableEnd);
  return new Map([...table.matchAll(/^\| \d+\s*\| \*\*([^*]+)\*\*\s*\| ([0-9]+)%\s*\|/gm)]
    .map(([, name, weightPct]) => [normalizeCategoryName(name), Number(weightPct) / 100]));
}

function parseSentimentWeights(source) {
  const match = source.match(/score = \(cnnFg \* ([0-9.]+)\) \+ \(bullPercentile \* ([0-9.]+)\) \+ \(\(100 - bearPercentile\) \* ([0-9.]+)\);/);
  assert.ok(match, 'Sentiment normal-path weights not found in seed-fear-greed');
  return {
    cnn: Number(match[1]),
    bull: Number(match[2]),
    bear: Number(match[3]),
  };
}

function parseBreadthWeights(source) {
  const match = source.match(/const w = hasAd \? \[([0-9.]+), ([0-9.]+), ([0-9.]+)\] : \[([0-9.]+), ([0-9.]+), ([0-9.]+)\];/);
  assert.ok(match, 'Breadth branch weights not found in seed-fear-greed');
  return {
    normal: match.slice(1, 4).map(Number),
    degraded: match.slice(4, 7).map(Number),
  };
}

function parseAaiiTimeoutMs(source) {
  const fetchStart = source.indexOf('async function fetchAAII()');
  assert.notEqual(fetchStart, -1, 'fetchAAII not found');
  const fetchEnd = source.indexOf('\n}', fetchStart);
  assert.notEqual(fetchEnd, -1, 'fetchAAII end not found');
  const block = source.slice(fetchStart, fetchEnd);
  const match = block.match(/AbortSignal\.timeout\(([\d_]+)\)/);
  assert.ok(match, 'AAII AbortSignal.timeout not found');
  return Number(match[1].replace(/_/g, ''));
}

function parseSourceInputKeys(source, category) {
  const caseStart = source.indexOf(`case '${category}': {`);
  assert.notEqual(caseStart, -1, `${category} scorer branch not found`);
  const nextCase = source.indexOf('\n    case ', caseStart + 1);
  const block = source.slice(caseStart, nextCase === -1 ? source.indexOf('\n    default:', caseStart) : nextCase);
  const matches = [...block.matchAll(/inputs:\s*\{([^{}]+)\}/g)];
  assert.ok(matches.length, `${category} emitted inputs object not found`);
  return matches.at(-1)[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(':')[0].trim())
    .sort();
}

function parseDocOutputExampleInputKeys(doc, category) {
  const outputSchemaStart = doc.indexOf('### Output Schema (stored in Redis)');
  assert.notEqual(outputSchemaStart, -1, 'Fear & Greed output schema section not found');
  const outputSchemaEnd = doc.indexOf('\n```\n', doc.indexOf('```json', outputSchemaStart) + 1);
  assert.notEqual(outputSchemaEnd, -1, 'Fear & Greed output schema JSON block end not found');
  const outputSchema = doc.slice(outputSchemaStart, outputSchemaEnd);
  const escapedCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outputSchema.match(new RegExp(`"${escapedCategory}": [^\\n]*"inputs": \\{([^}]*)\\}`));
  assert.ok(match, `${category} output schema example inputs not found`);
  return [...match[1].matchAll(/"([^"]+)":/g)].map(([, key]) => key).sort();
}

function parseRedisKeyBlock(doc) {
  const redisStart = doc.indexOf('### Redis Keys');
  assert.notEqual(redisStart, -1, 'Redis Keys section not found');
  const fenceStart = doc.indexOf('```', redisStart);
  const fenceEnd = doc.indexOf('```', fenceStart + 3);
  assert.notEqual(fenceEnd, -1, 'Redis Keys fenced block end not found');
  return doc.slice(fenceStart, fenceEnd);
}

describe('Fear & Greed docs match seed-fear-greed source', () => {
  const source = readRepo('scripts/seed-fear-greed.mjs');
  const doc = readRepo('docs/fear-greed-index-2.0-brief.md');

  it('publishes category weights from the seeder WEIGHTS map', () => {
    const sourceWeights = parseWeightMap(source);
    const docWeights = parseDocCategoryWeights(doc);

    assert.equal(docWeights.size, sourceWeights.size, 'Fear & Greed docs should list every weighted category');

    for (const [category, sourceWeight] of sourceWeights) {
      assert.equal(docWeights.get(category), sourceWeight, `docs weight drift for ${category}`);
    }
  });

  it('documents source-derived Sentiment fallback gates and weights', () => {
    const weights = parseSentimentWeights(source);
    const aaiiTimeoutMs = parseAaiiTimeoutMs(source);

    assert.match(doc, new RegExp(`CNN_FG \\* ${weights.cnn}`));
    assert.match(doc, new RegExp(`AAII_Bull_Percentile \\* ${weights.bull}`));
    assert.match(doc, new RegExp(`AAII_Bear_Percentile\\) \\* ${weights.bear}`));
    assert.match(source, /aaiBull == null \|\| aaiBear == null/);
    assert.match(source, /score = \(bullPercentile \* 0\.5\) \+ \(\(100 - bearPercentile\) \* 0\.5\);/);
    assert.match(source, /score = cnnFg;/);
    assert.match(source, /score = cryptoFg;/);
    assert.match(source, /score = 50;/);
    assert.match(source, /aaiBull: aaiBull \?\? null, aaiBear: aaiBear \?\? null/);
    assert.match(doc, /AAII unavailable/);
    assert.match(doc, /CNN unavailable, AAII available/);
    assert.match(doc, /AAII_Bull_Percentile \* 0\.5/);
    assert.match(doc, /100 - AAII_Bear_Percentile\) \* 0\.5/);
    assert.match(doc, /aaiBull\/aaiBear as null, not 0/);
    assert.match(doc, /crypto F&G from Redis as secondary signal/);
    assert.match(doc, /neutral 50 if both are absent/);
    assert.match(doc, /CNN unavailable but AAII available/);
    assert.match(doc, /AAII_Bull_Percentile \* 0\.5/);
    assert.match(doc, /AAII_Bear_Percentile\) \* 0\.5/);
    assert.match(source, /score = \(bullPercentile \* 0\.5\) \+ \(\(100 - bearPercentile\) \* 0\.5\);/);
    assert.match(doc, new RegExp(`AbortSignal\\.timeout\\(${aaiiTimeoutMs}\\)`));
  });

  it('documents source-derived Breadth branch weights and current AD-ratio gate', () => {
    const { normal, degraded } = parseBreadthWeights(source);

    assert.match(source, /advDecRatio:\s*null/);
    assert.match(doc, /Advance\/decline ratio is currently `null`/);
    assert.match(doc, new RegExp(`breadth_score \\* ${normal[0]} \\+ ad_score \\* ${normal[1]} \\+ rsp_score \\* ${normal[2]}`));
    assert.match(doc, new RegExp(`breadth_score \\* ${degraded[0]} \\+ rsp_score \\* ${degraded[2]}`));
  });

  it('keeps the output schema example aligned with emitted category input keys', () => {
    const categories = ['sentiment', 'volatility', 'positioning', 'trend', 'breadth', 'momentum', 'liquidity', 'credit', 'macro', 'crossAsset'];

    for (const category of categories) {
      assert.deepEqual(
        parseDocOutputExampleInputKeys(doc, category),
        parseSourceInputKeys(source, category),
        `${category} output schema example inputs should match emitted seeder inputs`,
      );
    }

    assert.match(doc, /"advDecRatio": null/);
    assert.doesNotMatch(doc, /"vixChange":/);
    assert.doesNotMatch(doc, /"putCallAvg":/);
    assert.doesNotMatch(doc, /"leadersVsLaggards":/);
  });

  it('documents only implemented current Redis keys in the Redis Keys block', () => {
    const redisKeyBlock = parseRedisKeyBlock(doc);

    assert.match(source, /const FEAR_GREED_KEY = 'market:fear-greed:v1';/);
    assert.doesNotMatch(source, /extraKeys:/);
    assert.match(redisKeyBlock, /market:fear-greed:v1/);
    assert.match(redisKeyBlock, /seed-meta:market:fear-greed/);
    assert.match(redisKeyBlock, /seed-lock:market:fear-greed/);
    assert.doesNotMatch(redisKeyBlock, /market:fear-greed:history:v1/);
    assert.match(doc, /`market:fear-greed:history:v1` is a planned sorted set/);
    assert.match(doc, /does not write or read it yet/);
  });
});
