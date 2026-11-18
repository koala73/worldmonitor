import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_RANKED_TICKERS,
  extractTickers,
  accumulateTickerMentions,
  rankTickers,
} = require('../scripts/lib/wsb-tickers.cjs');

// The relay calls accumulateTickerMentions once per subreddit, then rankTickers.
function scan(postsBySub, known) {
  const tickerMap = new Map();
  let scanned = 0;
  for (const [sub, posts] of Object.entries(postsBySub)) {
    scanned += accumulateTickerMentions(tickerMap, posts, sub, known);
  }
  return { scanned, ranked: rankTickers(tickerMap) };
}

const post = (id, title, score, extra = {}) => ({ id, title, selftext: '', score, upvote_ratio: 0.9, permalink: `/r/x/${id}`, ...extra });

describe('WSB Ticker Scanner', () => {
  describe('ticker extraction', () => {
    const known = new Set(['NVDA', 'AAPL', 'TSLA', 'GME', 'BRK-B']);

    it('finds $TICKER and bare known tickers', () => {
      assert.deepEqual([...extractTickers('$NVDA is great, also look at TSLA', known)].sort(), ['NVDA', 'TSLA']);
    });

    it('accepts a lowercase $ticker but not a lowercase bare word', () => {
      assert.deepEqual([...extractTickers('bought $nvda, tsla next', known)], ['NVDA']);
    });

    it('normalizes a dotted share class to the Yahoo dash form', () => {
      assert.deepEqual([...extractTickers('$BRK.B and BRK.B', known)], ['BRK-B']);
    });

    it('keeps unknown $-prefixed tickers but drops unknown bare ones', () => {
      assert.deepEqual([...extractTickers('$FAKEX and NVDA and FAKEY', known)].sort(), ['FAKEX', 'NVDA']);
    });

    it('skips bare tickers entirely when the known set is empty', () => {
      assert.deepEqual([...extractTickers('NVDA and $AAPL', new Set())], ['AAPL']);
    });

    it('drops blacklisted words even with a $ prefix', () => {
      assert.deepEqual([...extractTickers('$YOLO $CEO $WSB $GME', new Set(['CEO']))], ['GME']);
    });

    it('returns an empty set for empty or null text', () => {
      assert.equal(extractTickers('', known).size, 0);
      assert.equal(extractTickers(null, known).size, 0);
    });
  });

  describe('aggregation and ranking', () => {
    const known = new Set(['NVDA', 'AAPL', 'TSLA']);

    it('merges mentions across subreddits and keeps the highest-score post', () => {
      const { scanned, ranked } = scan({
        wallstreetbets: [post('1', 'NVDA earnings great', 100, { upvote_ratio: 0.9 })],
        stocks: [post('2', 'NVDA calls printing', 200, { upvote_ratio: 0.95 })],
        investing: [post('3', 'AAPL undervalued', 50)],
      }, known);
      assert.equal(scanned, 3);
      const nvda = ranked.find((t) => t.symbol === 'NVDA');
      assert.equal(nvda.mentionCount, 2);
      assert.equal(nvda.uniquePosts, 2);
      assert.equal(nvda.totalScore, 300);
      assert.equal(nvda.avgUpvoteRatio, 0.93);
      assert.deepEqual(nvda.subreddits, ['wallstreetbets', 'stocks']);
      assert.deepEqual(nvda.topPost, { title: 'NVDA calls printing', url: 'https://reddit.com/r/x/2', score: 200, subreddit: 'stocks' });
    });

    it('credits every ticker in one post with that post', () => {
      const { ranked } = scan({ wallstreetbets: [post('1', 'NVDA and AAPL both look good', 500)] }, known);
      assert.deepEqual(ranked.map((t) => [t.symbol, t.totalScore]).sort(), [['AAPL', 500], ['NVDA', 500]]);
    });

    it('scores velocity as log1p(totalScore) x mentions, rounded to one decimal, highest first', () => {
      const { ranked } = scan({
        wallstreetbets: [post('1', 'NVDA', 10000), post('2', 'AAPL', 100)],
        stocks: [post('3', 'NVDA', 5000)],
      }, known);
      assert.deepEqual(ranked.map((t) => [t.symbol, t.velocityScore]), [['NVDA', 19.2], ['AAPL', 4.6]]);
    });

    it('publishes at most 50 tickers, dropping the lowest velocity', () => {
      // Scores grow by e^0.2 per ticker, so each velocity is 0.2 above the last.
      const symbol = (i) => `Z${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
      const posts = Array.from({ length: 60 }, (_, i) => post(String(i), `$${symbol(i)}`, Math.round(Math.exp(i * 0.2) * 100)));
      const { ranked } = scan({ wallstreetbets: posts }, new Set());
      assert.equal(MAX_RANKED_TICKERS, 50);
      assert.equal(ranked.length, 50);
      assert.equal(ranked[0].symbol, 'ZCH');
      assert.equal(ranked.at(-1).symbol, 'ZAK');
    });
  });
});
