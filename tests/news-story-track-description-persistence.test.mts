// U2 — story:track:v1 HSET persistence contract for the new description field.
//
// The description is written to the HSET only when non-empty, so old rows and
// rows from feeds without a description return `undefined` on HGETALL. This
// lets downstream consumers fall back to the cleaned headline (R6) without a
// key version bump.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { buildStoryTrackHsetFields } = __testing__;

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    source: 'Example News',
    title: 'Test headline about a newsworthy event',
    link: 'https://example.com/news/a',
    publishedAt: 1_745_000_000_000,
    isAlert: false,
    level: 'medium' as const,
    category: 'world',
    confidence: 0.9,
    classSource: 'keyword' as const,
    importanceScore: 42,
    corroborationCount: 1,
    lang: 'en',
    description: '',
    ...overrides,
  };
}

function fieldsToMap(fields: Array<string | number>): Map<string, string | number> {
  const m = new Map<string, string | number>();
  for (let i = 0; i < fields.length; i += 2) {
    m.set(String(fields[i]), fields[i + 1]!);
  }
  return m;
}

describe('buildStoryTrackHsetFields — story:track:v1 HSET contract', () => {
  it('writes description when non-empty', () => {
    const item = baseItem({
      description: 'Mojtaba Khamenei, 56, was seriously wounded in an attack this week, delegating authority to the Revolutionary Guards.',
    });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('description'), item.description);
    assert.ok(m.has('title'));
    assert.ok(m.has('link'));
    assert.ok(m.has('severity'));
    assert.ok(m.has('lang'));
  });

  it('omits description key entirely when empty', () => {
    const item = baseItem({ description: '' });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.has('description'), false, 'empty description must not be written so HGETALL returns undefined');
    // Other fields still present
    assert.ok(m.has('title'));
    assert.ok(m.has('link'));
  });

  it('treats undefined description the same as empty string', () => {
    // Simulates old cached ParsedItem rows from rss:feed:v1 (1h TTL) that
    // predate the parser change and are deserialised without the field.
    const item = baseItem();
    delete (item as Record<string, unknown>).description;
    const fields = buildStoryTrackHsetFields(item as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.has('description'), false);
  });

  it('preserves all other canonical fields (lastSeen, currentScore, title, link, severity, lang)', () => {
    const item = baseItem({
      description: 'A body that passes the length gate and will be persisted to Redis.',
      title: 'Headline A',
      link: 'https://x.example/a',
      level: 'high',
      lang: 'fr',
    });
    const fields = buildStoryTrackHsetFields(item, '1745000000001', 99);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('lastSeen'), '1745000000001');
    assert.strictEqual(m.get('currentScore'), 99);
    assert.strictEqual(m.get('title'), 'Headline A');
    assert.strictEqual(m.get('link'), 'https://x.example/a');
    assert.strictEqual(m.get('severity'), 'high');
    assert.strictEqual(m.get('lang'), 'fr');
  });

  it('round-trips Unicode / newlines cleanly', () => {
    const description = 'Brief d’actualité avec des accents : élections, résultats — et des émojis 🇫🇷.\nDeuxième ligne.';
    const item = baseItem({ description });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('description'), description);
  });

  it('description value survives in the returned array regardless of size (within caller-imposed 400 cap)', () => {
    const description = 'A'.repeat(400);
    const item = baseItem({ description });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('description'), description);
    assert.strictEqual((m.get('description') as string).length, 400);
  });
});
