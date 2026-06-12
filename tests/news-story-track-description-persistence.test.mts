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
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const {
  buildStoryTrackHsetFields,
  computeEntityCorroborationSignals,
  promoteDiplomacySeverity,
} = __testing__;

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    source: 'Example News',
    title: 'Test headline about a newsworthy event',
    link: 'https://example.com/news/a',
    publishedAt: 1_745_000_000_000,
    isAlert: false,
    level: 'medium' as const,
    category: 'general',
    confidence: 0.9,
    classSource: 'keyword' as const,
    importanceScore: 42,
    corroborationCount: 1,
    entityCorroborationCount: 0,
    lang: 'en',
    description: '',
    isOpinion: false,
    isFeelGood: false,
    isEphemeralLiveCoverage: false,
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

  it('writes isOpinion as "1" / "0" — stamps the opinion verdict on the row (F3)', () => {
    // The brief's read path (buildDigest) excludes isOpinion="1" rows.
    // Written unconditionally for the same shared-row reason as
    // `description`: a stale "1" from an earlier mention must be
    // overwritten by the current mention's verdict.
    const opinionItem = baseItem({ isOpinion: true });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(opinionItem, '1745000000000', 42)).get('isOpinion'), '1');
    const newsItem = baseItem({ isOpinion: false });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(newsItem, '1745000000000', 42)).get('isOpinion'), '0');
    // Missing field (old cached ParsedItem rows pre-dating the parser
    // change) → falsy → "0", never the literal "undefined".
    const legacyItem = baseItem();
    delete (legacyItem as Record<string, unknown>).isOpinion;
    assert.strictEqual(
      fieldsToMap(buildStoryTrackHsetFields(legacyItem as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42)).get('isOpinion'),
      '0',
    );
  });

  it('writes isFeelGood as "1" / "0" — stamps the feel-good verdict on the row (Veterans-warplanes anchor)', () => {
    // Sibling to isOpinion stamp. buildDigest excludes isFeelGood="1"
    // rows. Same shared-row semantics: stale "1" from an earlier
    // mention must be overwritten by the current mention's verdict.
    const feelGoodItem = baseItem({ isFeelGood: true });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(feelGoodItem, '1745000000000', 42)).get('isFeelGood'), '1');
    const newsItem = baseItem({ isFeelGood: false });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(newsItem, '1745000000000', 42)).get('isFeelGood'), '0');
    // Missing field on the ParsedItem → falsy → "0". This is
    // buildStoryTrackHsetFields' own fallback behavior. The
    // cache-leakage failure mode this could ENABLE (cached pre-PR
    // ParseResult with isFeelGood-less items writing '0' onto fresh
    // story:track:v1 rows, defeating buildDigest's residue catch) is
    // closed by the rss:feed:v4 cache-prefix bump in fetchAndParseRss —
    // see test "rss:feed cache prefix is v5" below.
    // After the bump, no cached pre-PR ParseResult can reach this code
    // path: every cache miss forces a fresh parseRssXml run that
    // stamps isFeelGood correctly. Genuinely-pre-existing story:track:v1
    // rows (written before this PR shipped) have no isFeelGood field
    // at all, and buildDigest's stampMissing check (typeof !== 'string'
    // || length === 0) picks those up via the residue catch.
    const legacyItem = baseItem();
    delete (legacyItem as Record<string, unknown>).isFeelGood;
    assert.strictEqual(
      fieldsToMap(buildStoryTrackHsetFields(legacyItem as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42)).get('isFeelGood'),
      '0',
    );
  });

  it('writes isEphemeralLiveCoverage as "1" / "0" — stamps expiring live-programming teasers', () => {
    const liveItem = baseItem({ isEphemeralLiveCoverage: true });
    assert.strictEqual(
      fieldsToMap(buildStoryTrackHsetFields(liveItem, '1745000000000', 42)).get('isEphemeralLiveCoverage'),
      '1',
    );
    const durableItem = baseItem({ isEphemeralLiveCoverage: false });
    assert.strictEqual(
      fieldsToMap(buildStoryTrackHsetFields(durableItem, '1745000000000', 42)).get('isEphemeralLiveCoverage'),
      '0',
    );
    const legacyItem = baseItem();
    delete (legacyItem as Record<string, unknown>).isEphemeralLiveCoverage;
    assert.strictEqual(
      fieldsToMap(buildStoryTrackHsetFields(legacyItem as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42)).get('isEphemeralLiveCoverage'),
      '0',
    );
  });

  it('T1: writes category as the canonical EventCategory string (Veterans threads-card fix)', () => {
    // PR #3697 exposed that buildStoryTrackHsetFields did not persist
    // `category`, so the brief composer always saw the 'General' default
    // for every story. This test locks the persistence going forward:
    // category is written as the canonical lowercase EventCategory value
    // (display capitalization happens once in shared/brief-filter.js at
    // envelope build, not here). See plan
    // docs/plans/2026-05-17-002-fix-persist-story-track-category-plan.md.
    const conflictItem = baseItem({ category: 'conflict' });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(conflictItem, '1745000000000', 42)).get('category'), 'conflict');
    const healthItem = baseItem({ category: 'health' });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(healthItem, '1745000000000', 42)).get('category'), 'health');
    const techItem = baseItem({ category: 'tech' });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(techItem, '1745000000000', 42)).get('category'), 'tech');
  });

  it('T2-T4: defensive write — missing / non-string upstream category becomes empty string, never literal "undefined"', () => {
    // The fallback chain is: missing here → '' on Redis →
    // shared/brief-filter.js:365's `asTrimmedString(raw.category) || 'General'`
    // converts back to 'General' for graceful degradation. The
    // critical contract is that NO literal 'undefined' or '42' string
    // ever reaches Redis from a malformed upstream value.
    //
    // T2: baseItem default fixture ('general') round-trips unchanged.
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(baseItem(), '1745000000000', 42)).get('category'), 'general');
    // T3: explicit `undefined` override → defensive empty string.
    const undefItem = baseItem({ category: undefined });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(undefItem as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42)).get('category'), '');
    // T4: non-string upstream value → defensive empty string (no '42').
    const nonStringItem = baseItem({ category: 42 });
    assert.strictEqual(fieldsToMap(buildStoryTrackHsetFields(nonStringItem as Parameters<typeof buildStoryTrackHsetFields>[0], '1745000000000', 42)).get('category'), '');
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

  it('persists promoted flashpoint-diplomacy severity so high-sensitivity digests can include it', () => {
    const promoted = promoteDiplomacySeverity(
      'medium',
      'US and Iran close deal to ease Hormuz tensions',
      3,
    );
    assert.strictEqual(promoted, 'high');

    const item = baseItem({
      title: 'US and Iran close deal to ease Hormuz tensions',
      level: promoted,
      isAlert: true,
      category: 'diplomacy',
      source: 'Reuters',
      entityCorroborationCount: 5,
    });
    const fields = buildStoryTrackHsetFields(item, '1745000000001', 99);
    const m = fieldsToMap(fields);
    assert.strictEqual(m.get('severity'), 'high');
    assert.strictEqual(m.get('entityCorroborationCount'), '5');
  });

  it('does not promote generic business deals or under-corroborated diplomacy titles', () => {
    assert.strictEqual(
      promoteDiplomacySeverity('medium', 'Apple closes deal for new supplier contract', 3),
      'medium',
    );
    assert.strictEqual(
      promoteDiplomacySeverity('medium', 'US and Iran close deal to ease Hormuz tensions', 2),
      'medium',
    );
    assert.strictEqual(
      promoteDiplomacySeverity('critical', 'US and Iran close deal to ease Hormuz tensions', 3),
      'critical',
    );
    assert.strictEqual(
      promoteDiplomacySeverity('info', 'This day in history: US and Iran close deal to ease Hormuz tensions', 3),
      'info',
    );
  });

  it('counts tier-1/2 entity corroboration separately from lower-tier sources', () => {
    const now = 1_745_000_000_000;
    const items = [
      baseItem({
        source: 'Reuters',
        title: 'US and Iran close deal to ease Hormuz tensions',
        titleHash: 'h-reuters',
        publishedAt: now,
      }),
      baseItem({
        source: 'AP News',
        title: 'Iran deal could calm oil markets after Hormuz alarm',
        titleHash: 'h-ap',
        publishedAt: now,
      }),
      baseItem({
        source: 'Axios',
        title: 'US-Iran deal averts immediate Hormuz disruption',
        titleHash: 'h-axios',
        publishedAt: now,
      }),
      baseItem({
        source: 'Hacker News',
        title: 'Iran deal discussions draw online attention',
        titleHash: 'h-hn',
        publishedAt: now,
      }),
    ];

    const signals = computeEntityCorroborationSignals(
      items as Array<Parameters<typeof computeEntityCorroborationSignals>[0][number]>,
      now,
    );
    assert.deepStrictEqual(signals.get('h-reuters'), {
      sourceCount: 4,
      tier12SourceCount: 3,
    });
    assert.deepStrictEqual(signals.get('h-hn'), {
      sourceCount: 4,
      tier12SourceCount: 3,
    });
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

describe('fetchAndParseRss — cache prefix invalidation contract', () => {
  it('rss:feed cache prefix is v5 (post-isEphemeralLiveCoverage), not v4', () => {
    // Pre-PR ParsedItems cached at rss:feed:v4 lack the
    // isEphemeralLiveCoverage field. If a cache hit returned one of those,
    // the falsy-coerce in
    // buildStoryTrackHsetFields would stamp '0' onto the row, and
    // buildDigest's stampMissing check (`typeof !== 'string' || length === 0`)
    // would treat '0' as a genuine "not ephemeral-live" verdict — defeating
    // the residue catch for the 1h healthy-cache rollout window. The v5
    // prefix invalidates every pre-PR entry; cold reads on the first
    // post-deploy cron tick force fresh parseRssXml runs that stamp
    // isEphemeralLiveCoverage correctly. This test locks the cutover so a future
    // refactor cannot silently revert to v4.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
      'utf-8',
    );
    assert.ok(
      src.includes("`rss:feed:v5:${variant}:${feed.url}`"),
      'rss:feed cache key must use v5 prefix — see comment above the cacheKey assignment in fetchAndParseRss',
    );
    assert.ok(
      !src.includes("`rss:feed:v4:${variant}:${feed.url}`"),
      'must NOT leave a residual v4 cacheKey assignment — would silently revert the cutover',
    );
  });
});
