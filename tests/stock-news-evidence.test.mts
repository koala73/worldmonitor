import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignUsEquityNewsTimestamp,
  enrichStockNewsItem,
  nextUsEquityTradingDate,
} from '../server/worldmonitor/market/v1/stock-news-evidence.ts';

test('US equity news alignment preserves pre-market and regular-session dates', () => {
  const premarket = alignUsEquityNewsTimestamp(Date.parse('2026-08-10T12:15:00.000Z')); // 08:15 NY
  const regular = alignUsEquityNewsTimestamp(Date.parse('2026-08-10T16:15:00.000Z')); // 12:15 NY
  assert.equal(premarket.alignedTradingDate, '2026-08-10');
  assert.equal(premarket.alignmentRule, 'PREMARKET_SAME_TRADING_DAY');
  assert.equal(premarket.marketSessionAtPublish, 'MARKET_SESSION_PRE');
  assert.equal(regular.alignedTradingDate, '2026-08-10');
  assert.equal(regular.alignmentRule, 'REGULAR_SESSION_SAME_TRADING_DAY');
  assert.equal(regular.marketSessionAtPublish, 'MARKET_SESSION_REGULAR');
});

test('after-hours, weekend and full-holiday news align to the next actual trading date', () => {
  const afterHours = alignUsEquityNewsTimestamp(Date.parse('2026-08-07T22:30:00.000Z')); // Friday 18:30 NY
  const weekend = alignUsEquityNewsTimestamp(Date.parse('2026-08-08T16:00:00.000Z')); // Saturday noon NY
  const christmas = alignUsEquityNewsTimestamp(Date.parse('2026-12-25T16:00:00.000Z')); // NYSE Christmas closure
  assert.equal(afterHours.alignedTradingDate, '2026-08-10');
  assert.equal(afterHours.alignmentRule, 'AFTER_HOURS_NEXT_TRADING_DAY');
  assert.equal(weekend.alignedTradingDate, '2026-08-10');
  assert.equal(weekend.alignmentRule, 'NON_TRADING_DAY_NEXT_TRADING_DAY');
  assert.equal(christmas.alignedTradingDate, '2026-12-28');
  assert.equal(christmas.alignmentRule, 'NON_TRADING_DAY_NEXT_TRADING_DAY');
  assert.equal(nextUsEquityTradingDate('2026-12-24'), '2026-12-28');
});

test('news enrichment keeps source facts while making no model or causal claim without a configured analysis provider', () => {
  const item = enrichStockNewsItem({
    id: 'provider-news-1', symbol: 'AAPL', title: 'Provider headline', source: 'Provider',
    sourceUrl: 'https://example.test/news/1', publishedAtUtc: Date.parse('2026-08-10T16:15:00.000Z'),
  });
  assert.equal(item.symbol, 'AAPL');
  assert.equal(item.sourceUrl, 'https://example.test/news/1');
  assert.equal(item.alignment?.exchangeTimezone, 'America/New_York');
  assert.equal(item.analysis?.available, false);
  assert.equal(item.analysis?.modelSentiment, 'NEWS_SENTIMENT_UNAVAILABLE');
  assert.equal(item.analysis?.causalConfidence, 0);
  assert.match(item.analysis?.causalReason ?? '', /No causal claim/);
  assert.deepEqual(item.analysis?.realizedReturns, []);
});
