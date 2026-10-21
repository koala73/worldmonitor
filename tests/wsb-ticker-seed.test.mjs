import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TICKER_REGEX = /\$([A-Z]{1,5})\b|\b([A-Z]{1,5})\b/g;
const TICKER_BLACKLIST = new Set([
  'I','A','ALL','FOR','THE','CEO','GDP','IPO','SEC','FDA','IMF','ETF','ATH',
  'DD','YOLO','FOMO','FUD','HODL','WSB','USA','EU','UK','AI','EV','IT','OR',
  'AM','PM','ON','BE','SO','GO','AT','TO','UP','NO','IF','AS','BY','AN','DO',
  'IN','OF','IS','HAS','NEW','CFO','CTO','IRS','FBI','CIA','UN','WHO',
  'IMO','PSA','FYI','TL','DR','OP','OC','US','ER','RE','VS',
]);

function extractTickers(text, knownTickers) {
  const found = new Set();
  if (!text) return found;
  let m;
  TICKER_REGEX.lastIndex = 0;
  while ((m = TICKER_REGEX.exec(text)) !== null) {
    const sym = (m[1] || m[2] || '').toUpperCase();
    if (!sym || sym.length < 1) continue;
    if (TICKER_BLACKLIST.has(sym)) continue;
    if (knownTickers.size > 0 && !knownTickers.has(sym)) continue;
    found.add(sym);
  }
  return found;
}

function aggregate(posts, knownTickers) {
  const tickerMap = new Map();
  const nowSec = Date.now() / 1000;
  for (const p of posts) {
    const text = `${p.title || ''} ${p.selftext || ''}`;
    const tickers = extractTickers(text, knownTickers);
    for (const sym of tickers) {
      let entry = tickerMap.get(sym);
      if (!entry) {
        entry = {
          symbol: sym,
          mentionCount: 0,
          postIds: new Set(),
          totalScore: 0,
          upvoteRatioSum: 0,
          topPost: null,
          subreddits: new Set(),
        };
        tickerMap.set(sym, entry);
      }
      entry.mentionCount++;
      entry.postIds.add(p.id);
      entry.totalScore += (p.score || 0);
      entry.upvoteRatioSum += (p.upvote_ratio || 0);
      entry.subreddits.add(p._sub || 'wallstreetbets');
      if (!entry.topPost || (p.score || 0) > entry.topPost.score) {
        entry.topPost = {
          title: String(p.title || '').slice(0, 300),
          url: `https://reddit.com${p.permalink || ''}`,
          score: p.score || 0,
          subreddit: p._sub || 'wallstreetbets',
        };
      }
    }
  }
  const results = [];
  for (const [, entry] of tickerMap) {
    const uniquePosts = entry.postIds.size;
    const avgUpvoteRatio = uniquePosts > 0 ? Math.round((entry.upvoteRatioSum / entry.mentionCount) * 100) / 100 : 0;
    const velocityScore = Math.round(Math.log1p(entry.totalScore) * entry.mentionCount * 10) / 10;
    results.push({
      symbol: entry.symbol,
      mentionCount: entry.mentionCount,
      uniquePosts,
      totalScore: entry.totalScore,
      avgUpvoteRatio,
      topPost: entry.topPost,
      subreddits: [...entry.subreddits],
      velocityScore,
    });
  }
  results.sort((a, b) => b.velocityScore - a.velocityScore);
  return results;
}

describe('WSB Ticker Scanner', () => {
  describe('ticker extraction regex', () => {
    const known = new Set(['NVDA', 'AAPL', 'TSLA', 'GME', 'AMC', 'PLTR', 'SPY', 'QQQ', 'MSFT', 'META']);

    it('finds $TICKER patterns', () => {
      const result = extractTickers('Just bought $NVDA and $AAPL calls', known);
      assert.ok(result.has('NVDA'));
      assert.ok(result.has('AAPL'));
    });

    it('finds bare uppercase tickers', () => {
      const result = extractTickers('TSLA to the moon! GME squeeze incoming', known);
      assert.ok(result.has('TSLA'));
      assert.ok(result.has('GME'));
    });

    it('filters blacklisted words', () => {
      const noFilter = new Set();
      const result = extractTickers('I think THE CEO said ALL is good FOR IPO', noFilter);
      assert.ok(!result.has('I'));
      assert.ok(!result.has('THE'));
      assert.ok(!result.has('CEO'));
      assert.ok(!result.has('ALL'));
      assert.ok(!result.has('FOR'));
      assert.ok(!result.has('IPO'));
    });

    it('filters WSB jargon', () => {
      const noFilter = new Set();
      const result = extractTickers('YOLO FOMO HODL DD FUD WSB', noFilter);
      assert.ok(!result.has('YOLO'));
      assert.ok(!result.has('FOMO'));
      assert.ok(!result.has('HODL'));
      assert.ok(!result.has('DD'));
      assert.ok(!result.has('FUD'));
      assert.ok(!result.has('WSB'));
    });

    it('validates against known ticker set when non-empty', () => {
      const result = extractTickers('NVDA and FAKEX both mentioned', known);
      assert.ok(result.has('NVDA'));
      assert.ok(!result.has('FAKEX'), 'Unknown ticker FAKEX should be filtered');
    });

    it('returns empty set for empty/null input', () => {
      const result = extractTickers('', known);
      assert.equal(result.size, 0);
      const result2 = extractTickers(null, known);
      assert.equal(result2.size, 0);
    });

    it('handles mixed $TICKER and bare forms', () => {
      const result = extractTickers('$NVDA is great, also look at TSLA', known);
      assert.ok(result.has('NVDA'));
      assert.ok(result.has('TSLA'));
    });
  });

  describe('aggregation', () => {
    const known = new Set(['NVDA', 'AAPL', 'TSLA']);

    it('merges multiple mentions of same ticker', () => {
      const posts = [
        { id: '1', title: 'NVDA earnings great', selftext: '', score: 100, upvote_ratio: 0.9, permalink: '/r/wsb/1', _sub: 'wallstreetbets' },
        { id: '2', title: 'NVDA calls printing', selftext: '', score: 200, upvote_ratio: 0.95, permalink: '/r/wsb/2', _sub: 'stocks' },
        { id: '3', title: 'AAPL undervalued', selftext: '', score: 50, upvote_ratio: 0.8, permalink: '/r/wsb/3', _sub: 'investing' },
      ];
      const results = aggregate(posts, known);
      const nvda = results.find(t => t.symbol === 'NVDA');
      assert.ok(nvda);
      assert.equal(nvda.mentionCount, 2);
      assert.equal(nvda.uniquePosts, 2);
      assert.equal(nvda.totalScore, 300);
      assert.deepEqual(nvda.subreddits.sort(), ['stocks', 'wallstreetbets']);
      assert.equal(nvda.topPost.score, 200);
    });

    it('counts multiple tickers in same post separately', () => {
      const posts = [
        { id: '1', title: 'NVDA and AAPL both look good', selftext: '', score: 500, upvote_ratio: 0.92, permalink: '/r/wsb/1', _sub: 'wallstreetbets' },
      ];
      const results = aggregate(posts, known);
      assert.equal(results.length, 2);
      const nvda = results.find(t => t.symbol === 'NVDA');
      const aapl = results.find(t => t.symbol === 'AAPL');
      assert.ok(nvda);
      assert.ok(aapl);
      assert.equal(nvda.totalScore, 500);
      assert.equal(aapl.totalScore, 500);
    });

    it('picks highest-score post as topPost', () => {
      const posts = [
        { id: '1', title: 'TSLA low score', selftext: '', score: 10, upvote_ratio: 0.5, permalink: '/r/wsb/1', _sub: 'wallstreetbets' },
        { id: '2', title: 'TSLA high score', selftext: '', score: 9000, upvote_ratio: 0.99, permalink: '/r/wsb/2', _sub: 'stocks' },
      ];
      const results = aggregate(posts, known);
      const tsla = results.find(t => t.symbol === 'TSLA');
      assert.equal(tsla.topPost.score, 9000);
      assert.equal(tsla.topPost.title, 'TSLA high score');
    });
  });

  describe('velocity scoring', () => {
    it('higher score + more mentions = higher velocity', () => {
      const posts = [
        { id: '1', title: 'NVDA', selftext: '', score: 10000, upvote_ratio: 0.95, permalink: '/r/1', _sub: 'wallstreetbets' },
        { id: '2', title: 'NVDA', selftext: '', score: 5000, upvote_ratio: 0.9, permalink: '/r/2', _sub: 'stocks' },
        { id: '3', title: 'AAPL', selftext: '', score: 100, upvote_ratio: 0.7, permalink: '/r/3', _sub: 'investing' },
      ];
      const known = new Set(['NVDA', 'AAPL']);
      const results = aggregate(posts, known);
      const nvda = results.find(t => t.symbol === 'NVDA');
      const aapl = results.find(t => t.symbol === 'AAPL');
      assert.ok(nvda.velocityScore > aapl.velocityScore, `NVDA (${nvda.velocityScore}) should have higher velocity than AAPL (${aapl.velocityScore})`);
    });

    it('velocity uses log1p of totalScore', () => {
      const posts = [
        { id: '1', title: 'NVDA', selftext: '', score: 100, upvote_ratio: 0.9, permalink: '/r/1', _sub: 'wallstreetbets' },
      ];
      const known = new Set(['NVDA']);
      const results = aggregate(posts, known);
      const nvda = results.find(t => t.symbol === 'NVDA');
      const expected = Math.round(Math.log1p(100) * 1 * 10) / 10;
      assert.equal(nvda.velocityScore, expected);
    });
  });

  describe('top-50 cutoff', () => {
    it('returns at most 50 tickers', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const tickers = [];
      for (let i = 0; i < 60; i++) {
        const a = alphabet[Math.floor(i / 26) % 26];
        const b = alphabet[i % 26];
        tickers.push(`Z${a}${b}`);
      }
      const known = new Set(tickers);
      const posts = tickers.map((sym, i) => ({
        id: String(i),
        title: `$${sym}`,
        selftext: '',
        score: 100 + i,
        upvote_ratio: 0.9,
        permalink: `/r/wsb/${i}`,
        _sub: 'wallstreetbets',
      }));
      const results = aggregate(posts, known);
      const top50 = results.slice(0, 50);
      assert.equal(top50.length, 50);
      assert.ok(results.length === 60, `Should have 60 total before cutoff, got ${results.length}`);
    });
  });
});
