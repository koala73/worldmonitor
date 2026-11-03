import assert from 'node:assert/strict';
import { it } from 'node:test';
import { protoItemToNewsItem, protoThreatToNewsThreat } from '../src/services/news-digest-items.ts';
import type { NewsItem, ThreatClassification } from '../src/generated/client/worldmonitor/news/v1/service_client.ts';

it('converts all existing wire levels and retains complete classification metadata', () => {
  const levels = {
    THREAT_LEVEL_UNSPECIFIED: 'info', THREAT_LEVEL_LOW: 'low', THREAT_LEVEL_MEDIUM: 'medium',
    THREAT_LEVEL_HIGH: 'high', THREAT_LEVEL_CRITICAL: 'critical',
  } as const;
  for (const [level, expected] of Object.entries(levels)) {
    for (const source of ['keyword', 'ml', 'llm']) {
      const threat = { level, category: 'economic', confidence: 0.7, source } as ThreatClassification;
      assert.deepEqual(protoThreatToNewsThreat(threat), { ...threat, level: expected });
    }
  }
  assert.equal(protoThreatToNewsThreat(undefined), undefined);
});

it('preserves the existing digest defaults, unknown decoding and whole-item fields', () => {
  const item: NewsItem = {
    source: 'Reuters', title: 'Headline', link: 'https://example.org/a', publishedAt: 1_790_000_000_000,
    isAlert: true, locationName: '', importanceScore: 0, corroborationCount: 1, credibilityScore: 0,
    snippet: 'Retained description', tickers: ['ABC'],
    threat: { level: 'THREAT_LEVEL_HIGH', category: 'economic', confidence: 0.8, source: '' },
  };
  const converted = protoItemToNewsItem(item);
  assert.deepEqual(converted.threat, { level: 'high', category: 'economic', confidence: 0.8, source: 'keyword' });
  assert.equal(converted.title, item.title);
  assert.equal(converted.link, item.link);
  assert.equal(converted.source, item.source);
  assert.equal(converted.pubDate.getTime(), item.publishedAt);
  assert.equal(converted.isAlert, true);
  assert.equal(converted.snippet, item.snippet);
  assert.deepEqual(converted.tickers, item.tickers);
  assert.equal(protoItemToNewsItem({ ...item, threat: undefined }).threat, undefined);
  const unknown = { ...item.threat!, level: 'FUTURE_WIRE_LEVEL' } as unknown as ThreatClassification;
  assert.equal(protoItemToNewsItem({ ...item, threat: unknown }).threat?.level, 'info');
});
