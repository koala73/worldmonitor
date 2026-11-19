// Stock quote sparklines are Yahoo's raw 1-minute closes (up to ~760 a session) and ship in the fast
// bootstrap tier, but the dashboard draws them 50 px wide. Both writers of market:stocks-bootstrap:v1
// (the relay and the cron seeder) must publish the same capped sample.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { QUOTE_SPARKLINE_MAX_POINTS, capQuoteSparklines, downsampleSparkline } = require('../scripts/shared/quote-sparkline.cjs');

const series = (n) => Array.from({ length: n }, (_, i) => 100 + i);

describe('downsampleSparkline', () => {
  it('keeps the first and last close and stays within the cap', () => {
    const values = series(764);
    const sampled = downsampleSparkline(values, QUOTE_SPARKLINE_MAX_POINTS);
    assert.equal(sampled.length, QUOTE_SPARKLINE_MAX_POINTS);
    assert.equal(sampled[0], values[0]);
    assert.equal(sampled.at(-1), values.at(-1));
  });

  it('samples in order without inventing values', () => {
    const values = series(500);
    const sampled = downsampleSparkline(values, 50);
    for (let i = 1; i < sampled.length; i += 1) assert.ok(sampled[i] > sampled[i - 1]);
    assert.ok(sampled.every((v) => values.includes(v)));
  });

  it('returns a short series unchanged', () => {
    assert.deepEqual(downsampleSparkline([1, 2, 3], 96), [1, 2, 3]);
    assert.deepEqual(downsampleSparkline([], 96), []);
  });
});

describe('capQuoteSparklines', () => {
  it('caps long sparklines and leaves the rest of each quote alone', () => {
    const long = { symbol: '^NSEI', price: 1, change: 2, sparkline: series(376) };
    const short = { symbol: '^GSPC', price: 3, change: 4, sparkline: series(40) };
    const empty = { symbol: 'AAPL', price: 5, change: 6, sparkline: [] };
    const [cappedLong, cappedShort, cappedEmpty] = capQuoteSparklines([long, short, empty]);
    assert.equal(cappedLong.sparkline.length, QUOTE_SPARKLINE_MAX_POINTS);
    assert.deepEqual({ ...cappedLong, sparkline: undefined }, { ...long, sparkline: undefined });
    assert.equal(cappedShort, short);
    assert.equal(cappedEmpty, empty);
  });
});

describe('both stocks-bootstrap writers cap sparklines', () => {
  it('the cron seeder caps the merged quotes it publishes', () => {
    const source = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');
    assert.match(source, /quotes:\s*capQuoteSparklines\(mergedQuotes\)/);
  });

  it('the relay caps the merged quotes it publishes', () => {
    const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.match(source, /const quotes = capQuoteSparklines\(mergeLastGoodQuotes\(MARKET_SYMBOLS, freshQuotes, previousQuotes\)\);/);
  });
});
