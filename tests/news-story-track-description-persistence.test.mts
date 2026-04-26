// U2 — story:track:v1 HSET persistence contract for the description field.
//
// Description is written UNCONDITIONALLY on every mention (empty string when
// the current mention has no body). This keeps the row's description
// authoritative for the current cycle: because story:track rows are
// collapsed by normalized-title hash, an earlier mention's body would
// otherwise persist on subsequent body-less mentions for up to STORY_TTL
// (7 days), silently grounding LLMs on a body that doesn't belong to the
// current mention. Writing empty is the honest signal — consumers fall
// back to the cleaned headline (R6) per contract.

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

  it('writes an empty-string description when the current mention has no body — overwrites any prior mention body', () => {
    // Critical for stale-grounding avoidance: if the previous mention for
    // this normalized-title had a body, the next body-less mention must
    // wipe it so consumers don't ground LLMs on "some mention's body."
    const item = baseItem({ description: '' });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.has('description'), true, 'description must always be written (empty string overwrites any prior mention body)');
    assert.strictEqual(m.get('description'), '');
    assert.ok(m.has('title'));
    assert.ok(m.has('link'));
  });

  it('treats undefined description the same as empty string (writes empty, overwriting prior)', () => {
    // Simulates old cached ParsedItem rows from rss:feed:v1 (1h TTL) that
    // predate the parser change and are deserialised without the field.
    const item = baseItem();
    delete (item as Record<string, unknown>).description;
    const fields = buildStoryTrackHsetFields(item as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.has('description'), true);
    assert.strictEqual(m.get('description'), '');
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

  it('persists publishedAt as a stringified epoch ms (READ-time freshness contract)', () => {
    // The READ-time freshness floor in scripts/seed-digest-notifications.mjs
    // (buildDigest) parses track.publishedAt as int and drops rows older
    // than DIGEST_READ_MAX_AGE_HOURS. The HSET helper MUST emit it as a
    // numeric string for that parse to succeed. Skipping this would make
    // the read-time gate silently inert.
    const item = baseItem({ publishedAt: 1_745_000_000_000 });
    const fields = buildStoryTrackHsetFields(item, '1745000000000', 42);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('publishedAt'), '1745000000000');
    assert.strictEqual(Number.parseInt(m.get('publishedAt') as string, 10), 1_745_000_000_000);
  });

  it('stale-body overwrite: sequence of mentions for the same titleHash always reflects the CURRENT mention', () => {
    // Simulates the Codex-flagged scenario: Feed A at T0 has body, Feed B
    // at T1 body-less, Feed C at T2 has different body. All collapse to the
    // same story:track:v1 row via normalized-title hash. Each HSET must
    // reflect the current mention exactly — not preserve a prior mention's
    // body silently.
    const t0Fields = buildStoryTrackHsetFields(baseItem({
      description: 'Feed A body from T0: Mojtaba Khamenei, 56, wounded in attack.',
    }), '1745000000000', 42);
    const t1Fields = buildStoryTrackHsetFields(baseItem({
      description: '', // body-less wire reprint
    }), '1745000000100', 42);
    const t2Fields = buildStoryTrackHsetFields(baseItem({
      description: 'Feed C body from T2: Leader reported in stable condition.',
    }), '1745000000200', 42);

    assert.strictEqual(fieldsToMap(t0Fields).get('description'), 'Feed A body from T0: Mojtaba Khamenei, 56, wounded in attack.');
    assert.strictEqual(fieldsToMap(t1Fields).get('description'), '', 'T1 body-less mention must emit empty description, overwriting T0');
    assert.strictEqual(fieldsToMap(t2Fields).get('description'), 'Feed C body from T2: Leader reported in stable condition.');
  });
});
