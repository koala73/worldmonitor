import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderChinaCorporateDisclosureSignals } from '../src/components/market-disclosures';

describe('MarketPanel official China disclosure surface (#5577)', () => {
  it('renders source, issuer, type, status, date, translation state, and safe original links', () => {
    const html = renderChinaCorporateDisclosureSignals({
      schemaVersion: 1,
      generatedAt: '2026-07-25T10:00:00.000Z',
      status: 'degraded',
      sources: [],
      events: [
        {
          id: 'china-disclosure:sse:600519:fixture',
          exchange: 'SSE',
          issuer: {
            id: 'issuer:sse:600519',
            exchange: 'SSE',
            securityCode: '600519',
            symbol: '600519.SS',
            name: '<img src=x onerror=alert(1)>',
            nameOriginal: '贵州茅台',
            mappingConfidence: 1,
          },
          announcementId: 'fixture',
          disclosureType: 'investigation',
          titleOriginal: '<script>alert(1)</script>立案调查',
          originalLanguage: 'zh-CN',
          translation: { state: 'not_translated' },
          documentUrl: 'https://www.sse.com.cn/disclosure/fixture.pdf',
          publicationTime: { value: '2026-07-25', precision: 'day' },
          retrievalTime: '2026-07-25T10:00:00.000Z',
          effectiveTime: null,
          status: 'current',
          confidence: { issuer: 1, classification: 0.98, extraction: 1 },
          history: [],
          provenance: {},
        },
      ],
    });

    assert.match(html, /Official exchange disclosures/);
    assert.match(html, /SSE/);
    assert.match(html, /600519\.SS/);
    assert.match(html, /Investigation/);
    assert.match(html, /Current/);
    assert.match(html, /2026-07-25/);
    assert.match(html, /Original Chinese/);
    assert.match(html, /View original/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /<script>|<img/i);
    assert.match(html, /&lt;script&gt;|&lt;img/);
  });

  it('does not link an unsafe document URL even if a malformed cache payload reaches the UI', () => {
    const html = renderChinaCorporateDisclosureSignals({
      schemaVersion: 1,
      generatedAt: '2026-07-25T10:00:00.000Z',
      status: 'healthy',
      sources: [],
      events: [
        {
          id: 'bad-link',
          exchange: 'SSE',
          issuer: {
            id: 'issuer:sse:600519',
            exchange: 'SSE',
            securityCode: '600519',
            symbol: '600519.SS',
            name: 'Kweichow Moutai',
            nameOriginal: '贵州茅台',
            mappingConfidence: 1,
          },
          announcementId: 'bad-link',
          disclosureType: 'halt',
          titleOriginal: '停牌公告',
          originalLanguage: 'zh-CN',
          translation: { state: 'not_translated' },
          documentUrl: 'javascript:alert(1)',
          publicationTime: { value: '2026-07-25', precision: 'day' },
          retrievalTime: '2026-07-25T10:00:00.000Z',
          effectiveTime: null,
          status: 'current',
          confidence: { issuer: 1, classification: 0.98, extraction: 1 },
          history: [],
          provenance: {},
        },
      ],
    });

    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /View original/);
  });
});
