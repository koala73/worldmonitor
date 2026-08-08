import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderPopupSourceLinks } from '../src/components/map-popup-source-links.ts';
import type { UnrestEvent } from '../src/generated/server/worldmonitor/unrest/v1/service_server.ts';
import { deduplicateEvents } from '../server/worldmonitor/unrest/v1/_shared.ts';

function serverEvent(sourceUrls: string[]): UnrestEvent {
  return {
    id: `event-${sourceUrls[0]}`,
    title: 'Protest event',
    summary: '',
    eventType: 'UNREST_EVENT_TYPE_PROTEST',
    city: 'Paris',
    country: 'France',
    region: '',
    location: { latitude: 48.8566, longitude: 2.3522 },
    occurredAt: Date.UTC(2026, 3, 28),
    severity: 'SEVERITY_LEVEL_MEDIUM',
    fatalities: 0,
    sources: ['GDELT'],
    sourceUrls,
    sourceType: 'UNREST_SOURCE_TYPE_GDELT',
    tags: [],
    actors: [],
    confidence: 'CONFIDENCE_LEVEL_MEDIUM',
  };
}

describe('unrest source links', () => {
  it('caps deduplicated unrest source URLs at five', () => {
    const [merged] = deduplicateEvents([
      serverEvent([
        'https://news.example/1',
        'https://news.example/2',
        'https://news.example/3',
        'https://news.example/4',
        'https://news.example/5',
      ]),
      serverEvent([
        'https://news.example/5',
        'https://news.example/6',
        'https://news.example/7',
      ]),
    ]);

    assert.equal(merged.sourceUrls.length, 5);
    assert.deepEqual(merged.sourceUrls, [
      'https://news.example/1',
      'https://news.example/2',
      'https://news.example/3',
      'https://news.example/4',
      'https://news.example/5',
    ]);
  });

  it('does not render an empty protest source link container when every URL is unsafe', () => {
    const html = renderPopupSourceLinks(['javascript:alert(1)', 'ftp://example.test/story']);

    assert.doesNotMatch(html, /popup-source-links/);
  });
});
