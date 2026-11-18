'use strict';

// Ticker extraction and ranking for the relay's WSB scanner.
//
// Lives in scripts/lib rather than inline in ais-relay.cjs for the same
// reason as x-poll-cycle.cjs: the relay file boots on import, so logic only
// reachable there could be tested only through a copy, and the copy in
// tests/wsb-ticker-seed.test.mjs had drifted from the relay (single regex,
// no BRK.B normalization, bare tickers accepted with an empty known set).

// $-prefixed: case-insensitive ($nvda, $NVDA, $BRK.B). Bare: uppercase only (NVDA, BRK.B).
// $-prefixed tickers skip whitelist validation (strong signal). Bare uppercase validated against known set.
const DOLLAR_TICKER_REGEX = /\$([a-zA-Z]{1,5}(?:[.-][a-zA-Z]{1,2})?)\b/g;
const BARE_TICKER_REGEX = /\b([A-Z]{1,5}(?:[.-][A-Z]{1,2})?)\b/g;
const TICKER_BLACKLIST = new Set([
  'I','A','ALL','FOR','THE','CEO','GDP','IPO','SEC','FDA','IMF','ETF','ATH',
  'DD','YOLO','FOMO','FUD','HODL','WSB','USA','EU','UK','AI','EV','IT','OR',
  'AM','PM','ON','BE','SO','GO','AT','TO','UP','NO','IF','AS','BY','AN','DO',
  'IN','OF','IS','HAS','NEW','CFO','CTO','IRS','FBI','CIA','UN','WHO',
  'IMO','PSA','FYI','TL','DR','OP','OC','US','ER','RE','VS',
]);
const MAX_RANKED_TICKERS = 50;

function normalizeTicker(raw) {
  // BRK.B → BRK-B (Yahoo Finance uses dash, Reddit uses dot)
  return raw.toUpperCase().replace(/\./g, '-');
}

function extractTickers(text, knownTickers) {
  const found = new Set();
  if (!text) return found;
  let m;

  // $-prefixed tickers: strong signal, skip whitelist validation (only blacklist)
  DOLLAR_TICKER_REGEX.lastIndex = 0;
  while ((m = DOLLAR_TICKER_REGEX.exec(text)) !== null) {
    const sym = normalizeTicker(m[1] || '');
    if (!sym || sym.length < 1) continue;
    if (TICKER_BLACKLIST.has(sym)) continue;
    found.add(sym);
  }

  // Bare uppercase: high false-positive risk, REQUIRE known ticker set
  // When knownTickers is empty (bootstrap unavailable), skip bare matching entirely
  if (knownTickers.size > 0) {
    BARE_TICKER_REGEX.lastIndex = 0;
    while ((m = BARE_TICKER_REGEX.exec(text)) !== null) {
      const sym = normalizeTicker(m[1] || '');
      if (!sym || sym.length < 1) continue;
      if (TICKER_BLACKLIST.has(sym)) continue;
      if (!knownTickers.has(sym)) continue;
      found.add(sym);
    }
  }

  return found;
}

// Accumulates one subreddit's posts into tickerMap. Returns the number of
// posts scanned.
function accumulateTickerMentions(tickerMap, posts, subreddit, knownTickers) {
  let scanned = 0;
  for (const p of posts) {
    scanned++;
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
      entry.subreddits.add(subreddit);
      if (!entry.topPost || (p.score || 0) > entry.topPost.score) {
        entry.topPost = {
          title: String(p.title || '').slice(0, 300),
          url: `https://reddit.com${p.permalink || ''}`,
          score: p.score || 0,
          subreddit,
        };
      }
    }
  }
  return scanned;
}

// Turns the accumulated map into the published list: highest velocity first,
// at most MAX_RANKED_TICKERS entries.
function rankTickers(tickerMap) {
  const tickers = [];
  for (const [, entry] of tickerMap) {
    const uniquePosts = entry.postIds.size;
    const avgUpvoteRatio = uniquePosts > 0 ? Math.round((entry.upvoteRatioSum / uniquePosts) * 100) / 100 : 0;
    const ageFactor = 1; // all posts are "hot" (recent)
    const velocityScore = Math.round(Math.log1p(entry.totalScore) * entry.mentionCount * ageFactor * 10) / 10;
    tickers.push({
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
  tickers.sort((a, b) => b.velocityScore - a.velocityScore);
  return tickers.slice(0, MAX_RANKED_TICKERS);
}

module.exports = {
  TICKER_BLACKLIST,
  MAX_RANKED_TICKERS,
  normalizeTicker,
  extractTickers,
  accumulateTickerMentions,
  rankTickers,
};
