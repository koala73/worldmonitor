// #4922a: ticker tagging at news ingest — extractTickers unit coverage plus
// source-textual wiring assertions that list-feed-digest.ts extracts tickers
// at parse time and carries them onto the proto NewsItem (field 13,
// max_items=8 — the cap here is a proto validation contract, not styling).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTickerDictionary, extractTickers } from '../shared/ticker-extract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

const stocks = JSON.parse(readSrc('shared/stocks.json'));
const DICT = buildTickerDictionary(stocks.symbols);

describe('extractTickers — cashtags', () => {
  it('extracts a well-formed cashtag', () => {
    assert.deepEqual(extractTickers('Breaking: $AAPL hits record high', DICT), ['AAPL']);
  });

  it('accepts cashtags NOT in the stocks.json dictionary (explicit author intent)', () => {
    assert.deepEqual(extractTickers('Watch $ZZZZ squeeze today', DICT), ['ZZZZ']);
  });

  it('rejects lowercase cashtags — $aapl is NOT a ticker mention', () => {
    // Rule: cashtags are 1–5 UPPERCASE letters only; lowercase is dropped,
    // not normalized (mixed-case "$aapl" is far more often a typo/price tag
    // than an intentional ticker reference).
    assert.deepEqual(extractTickers('is $aapl going up?', DICT), []);
  });

  it('is word-bounded: currency amounts and glued suffixes never match', () => {
    assert.deepEqual(extractTickers('raised US$100M at a $2B valuation', DICT), []);
    assert.deepEqual(extractTickers('token $AAPLE12 is fake', DICT), []);
  });

  it('rejects cashtags longer than 5 letters', () => {
    assert.deepEqual(extractTickers('$ABCDEF is not a symbol', DICT), []);
  });
});

describe('extractTickers — company-name dictionary', () => {
  it('matches a company name as a whole word, mapping to its symbol', () => {
    assert.deepEqual(extractTickers('Nvidia beats estimates', DICT), ['NVDA']);
  });

  it('matches multi-word names as a phrase', () => {
    assert.deepEqual(extractTickers('Eli Lilly announces new obesity drug', DICT), ['LLY']);
    assert.deepEqual(extractTickers('Novo Nordisk shares slide', DICT), ['NVO']);
  });

  it('is case-insensitive on names', () => {
    assert.deepEqual(extractTickers('NVIDIA and nvidia and Nvidia', DICT), ['NVDA']);
  });

  it('never substring-matches inside larger words (Metallica ≠ META)', () => {
    assert.deepEqual(extractTickers('Metallica announces world tour', DICT), []);
    assert.deepEqual(extractTickers('Pineapples and Snapple sales up', DICT), []);
  });

  it('excludes index symbols (^GSPC/^DJI never emitted)', () => {
    assert.deepEqual(extractTickers('S&P 500 rallies as Dow Jones slips', DICT), []);
  });

  it('does NOT match bare symbols without $ (GM/ALL/IT false-positive class)', () => {
    assert.deepEqual(extractTickers('IT departments report ALL is well', DICT), []);
  });

  it('does NOT bare-name-match ambiguous common-word company names', () => {
    // These names are ordinary English words; bare-name matching would fire
    // spurious watchlist alerts. A cashtag is required to tag them (below).
    assert.deepEqual(extractTickers('Visa restrictions tighten for travelers', DICT), []);
    assert.deepEqual(extractTickers('The Amazon rainforest lost tree cover', DICT), []);
    assert.deepEqual(extractTickers('A new meta-analysis of the trials', DICT), []);
    assert.deepEqual(extractTickers('Kids learn the alphabet in school', DICT), []);
    assert.deepEqual(extractTickers('an apple a day', DICT), []);
    assert.deepEqual(extractTickers('the oracle at Delphi', DICT), []);
  });

  it('still tags ambiguous names via an explicit cashtag (author intent)', () => {
    assert.deepEqual(extractTickers('$V and $AMZN and $META rally', DICT), ['V', 'AMZN', 'META']);
  });

  it('still bare-name-matches distinctive single-word names', () => {
    assert.deepEqual(extractTickers('Nvidia beats estimates', DICT), ['NVDA']);
    assert.deepEqual(extractTickers('Netflix adds subscribers', DICT), ['NFLX']);
    assert.deepEqual(extractTickers('Tesla recalls vehicles', DICT), ['TSLA']);
  });
});

describe('extractTickers — output contract', () => {
  it('dedupes across cashtag and name mentions of the same symbol', () => {
    assert.deepEqual(extractTickers('$AAPL up 3% — Apple cites iPhone demand, $AAPL rallies', DICT), ['AAPL']);
  });

  it('preserves first-occurrence order across both extraction paths', () => {
    assert.deepEqual(
      extractTickers('Microsoft sues after $AAPL leak; Tesla unaffected', DICT),
      ['MSFT', 'AAPL', 'TSLA'],
    );
  });

  it('caps at 8 tickers (proto max_items=8)', () => {
    const text = '$AA $BB $CC $DD $EE $FF $GG $HH $II $JJ';
    const out = extractTickers(text, DICT);
    assert.equal(out.length, 8);
    assert.deepEqual(out, ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH']);
  });

  it('returns [] for empty and missing input', () => {
    assert.deepEqual(extractTickers('', DICT), []);
    assert.deepEqual(extractTickers(undefined, DICT), []);
    assert.deepEqual(extractTickers(null, DICT), []);
  });

  it('cashtag-only extraction works without a dictionary', () => {
    assert.deepEqual(extractTickers('Apple falls, $TSLA rises'), ['TSLA']);
  });
});

describe('buildTickerDictionary', () => {
  it('skips index entries (^-prefixed symbols)', () => {
    for (const symbol of DICT.symbolByName.values()) {
      assert.ok(!symbol.startsWith('^'), `index symbol ${symbol} must not enter the dictionary`);
    }
  });

  it('tolerates an empty symbol list', () => {
    const empty = buildTickerDictionary([]);
    assert.deepEqual(extractTickers('Apple and $AAPL', empty), ['AAPL']);
  });
});

describe('ingest wiring (source-textual + parse behavior)', () => {
  const src = readSrc('server/worldmonitor/news/v1/list-feed-digest.ts');

  it('list-feed-digest imports the shared extractor and stocks.json dictionary', () => {
    assert.match(src, /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/ticker-extract\.js'/);
    assert.match(src, /import stocksData from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/stocks\.json'/);
    assert.match(src, /buildTickerDictionary\(stocksData\.symbols\)/);
  });

  it('parseRssXml extracts tickers from title + description', () => {
    assert.match(src, /tickers: extractTickers\(/);
  });

  it('toProtoItem carries tickers with an empty-array fallback', () => {
    assert.match(src, /tickers: item\.tickers \?\? \[\]/);
  });

  it('parseRssXml stamps tickers on parsed items end-to-end', async () => {
    const { __testing__ } = await import('../server/worldmonitor/news/v1/list-feed-digest.ts');
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Microsoft beats estimates as $TSLA slides</title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <description>Nvidia supply chain unaffected by the quarter, analysts told investors on the call.</description>
    </item></channel></rss>`;
    const parsed = __testing__.parseRssXml(xml, { url: 'https://example.com/rss', name: 'Example', lang: 'en' }, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    // Microsoft (distinctive name) + $TSLA cashtag in title, Nvidia name in description.
    assert.deepEqual(parsed.items[0].tickers, ['MSFT', 'TSLA', 'NVDA']);
  });
});
