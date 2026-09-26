/**
 * #6419 steps 2 and 3: the single-source / tier-4-only rule and the publisher
 * roster apply uniformly.
 *
 * Acceptance: "a test asserts no source, tier, or category is exempt". Every
 * case below is enumerated from the live tables (RSS JSON + Telegram + X
 * overlays, publisher families, threat categories and levels), so a source
 * added tomorrow joins the proof without editing this file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CORROBORATION_OUTPUT_SCHEMA,
  PUBLISHER_ROSTER_CAP,
  PUBLISHER_ROSTER_OUTPUT_PROPERTIES,
  PUBLISHER_ROSTER_STRING_MAX_BYTES,
  assessCorroboration,
  evidenceFromCluster,
  evidenceFromItem,
  evidenceFromStory,
  publisherRoster,
  toCorroborationJson,
  toPublisherRosterJson,
  type ClaimEvidence,
  type Corroboration,
  type Publisher,
} from '../server/_shared/corroboration.ts';
import { SOURCE_TIERS, TIER_MEANING, declaredSourceTier, getSourceTier } from '../server/_shared/source-tiers.ts';
import { clusterNewsCore } from '../shared/news-clustering-core.js';
import { THREAT_CATEGORIES, THREAT_LEVELS } from '../shared/jev-classify.js';
import {
  PUBLISHER_FAMILIES,
  countPublisherFamilies,
  publisherFamilyFor,
  publisherNameForFamily,
} from '../shared/publisher-families.js';

const UNDECLARED = 'Synthetic Unmapped Outlet 6419';
const STORY = 'Missile attack kills troops in border strike officials say';

const grouped = (labels: string[], reportedPublishers: number | null = null): ClaimEvidence =>
  ({ kind: 'grouped', labels, reportedPublishers });

const declaredLabels = Object.keys(SOURCE_TIERS);
const curatedFamilies = Object.entries(PUBLISHER_FAMILIES);
const tier4Labels = declaredLabels.filter((label) => SOURCE_TIERS[label] === 4);

function sampleFor(tier: 1 | 2 | 3 | null, avoidFamily: string): string {
  if (tier === null) return UNDECLARED;
  const label = declaredLabels.find((l) => SOURCE_TIERS[l] === tier && publisherFamilyFor(l) !== avoidFamily);
  assert.ok(label, `no declared tier-${tier} label outside family ${avoidFamily}`);
  return label;
}

function tier4PairsInDistinctFamilies(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < tier4Labels.length; i++) {
    for (let j = i + 1; j < tier4Labels.length; j++) {
      const a = tier4Labels[i]!;
      const b = tier4Labels[j]!;
      if (publisherFamilyFor(a) !== publisherFamilyFor(b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

describe('declaredSourceTier', () => {
  it('returns the declared tier for every key of every table', () => {
    for (const label of declaredLabels) {
      assert.equal(declaredSourceTier(label), SOURCE_TIERS[label], label);
    }
  });

  it('never returns 4 for a label absent from all three tables', () => {
    assert.equal(declaredSourceTier(UNDECLARED), null);
    assert.equal(declaredSourceTier(''), null);
    assert.equal(declaredSourceTier('constructor'), null);
    assert.equal(getSourceTier(UNDECLARED), 4, 'ranking default is unchanged');
  });

  it('covers the Telegram and X overlays, not only the RSS JSON', () => {
    assert.ok(tier4Labels.length > 10, `expected RSS + Telegram tier-4 labels, saw ${tier4Labels.length}`);
  });
});

describe('assessCorroboration: no source or tier is exempt', () => {
  it('a lone label is single-publisher for every declared label and an undeclared one', () => {
    for (const label of [...declaredLabels, UNDECLARED]) {
      const expected: Corroboration = { state: 'single-publisher', publishers: 1 };
      assert.deepEqual(assessCorroboration(grouped([label])), expected, `grouped ${label}`);
      assert.deepEqual(
        assessCorroboration(evidenceFromItem({ source: label, corroborationCount: 1 })),
        expected,
        `item ${label}`,
      );
    }
  });

  it('every pair of declared tier-4 labels in distinct families is tier4-only', () => {
    const pairs = tier4PairsInDistinctFamilies();
    assert.ok(pairs.length > 0);
    for (const [a, b] of pairs) {
      assert.deepEqual(assessCorroboration(grouped([a, b])), { state: 'tier4-only', publishers: 2 }, `${a} + ${b}`);
    }
  });

  it('swapping either tier-4 member for a tier 1, 2, 3 or undeclared label is corroborated', () => {
    for (const [a, b] of tier4PairsInDistinctFamilies()) {
      for (const tier of [1, 2, 3, null] as const) {
        for (const [kept, replaced] of [[a, b], [b, a]] as const) {
          const other = sampleFor(tier, publisherFamilyFor(kept));
          assert.deepEqual(
            assessCorroboration(grouped([kept, other])),
            { state: 'corroborated', publishers: 2 },
            `${kept} + tier ${tier ?? 'undeclared'} ${other} (replacing ${replaced})`,
          );
        }
      }
    }
  });

  it('two labels of one publisher family are single-publisher, whatever their tiers', () => {
    const byFamily = new Map<string, string[]>();
    for (const label of declaredLabels) {
      const family = publisherFamilyFor(label);
      if (family.startsWith('label:')) continue;
      byFamily.set(family, [...(byFamily.get(family) ?? []), label]);
    }
    const multi = [...byFamily.entries()].filter(([, labels]) => labels.length >= 2);
    assert.ok(multi.length > 0);
    for (const [family, labels] of multi) {
      assert.deepEqual(assessCorroboration(grouped(labels)), { state: 'single-publisher', publishers: 1 }, family);
    }
  });

  it('single-publisher outranks tier4-only', () => {
    for (const label of tier4Labels) {
      assert.equal(assessCorroboration(grouped([label, label])).state, 'single-publisher', label);
    }
  });

  it('a server count above the seen families never yields tier4-only', () => {
    for (const [a, b] of tier4PairsInDistinctFamilies()) {
      assert.deepEqual(assessCorroboration(grouped([a, b], 3)), { state: 'corroborated', publishers: 3 }, `${a} + ${b}`);
    }
    for (const label of tier4Labels) {
      assert.deepEqual(assessCorroboration(grouped([label], 2)), { state: 'corroborated', publishers: 2 }, label);
      assert.deepEqual(
        assessCorroboration(evidenceFromItem({ source: label, corroborationCount: 2 })),
        { state: 'corroborated', publishers: 2 },
        `item ${label}`,
      );
    }
  });

  it('is unknown without evidence, never a guess', () => {
    assert.deepEqual(assessCorroboration(grouped([])), { state: 'unknown' });
    assert.deepEqual(assessCorroboration(grouped(['', '  '])), { state: 'unknown' });
    assert.deepEqual(assessCorroboration(evidenceFromItem({ source: 'Reuters World' })), { state: 'unknown' });
    assert.deepEqual(
      assessCorroboration(evidenceFromItem({ source: 'Reuters World', corroborationCount: 0 })),
      { state: 'unknown' },
    );
  });
});

describe('evidence adapters', () => {
  it('evidenceFromCluster takes every member label and the largest server count', () => {
    assert.deepEqual(
      evidenceFromCluster({ allItems: [{ source: 'A', corroborationCount: 1 }, { source: 'B', corroborationCount: 3 }] }),
      { kind: 'grouped', labels: ['A', 'B'], reportedPublishers: 3 },
    );
    assert.deepEqual(
      evidenceFromCluster({ allItems: [{ source: 'A' }, { source: 'B', corroborationCount: 0 }] }),
      { kind: 'grouped', labels: ['A', 'B'], reportedPublishers: null },
    );
  });

  it('evidenceFromItem keeps only a positive server count', () => {
    assert.deepEqual(evidenceFromItem({ source: 'A', corroborationCount: 2 }), { kind: 'item', label: 'A', reportedPublishers: 2 });
    assert.deepEqual(evidenceFromItem({ source: 'A', corroborationCount: 0 }), { kind: 'item', label: 'A', reportedPublishers: null });
  });

  it('wire form and schema cover every state', () => {
    assert.deepEqual(toCorroborationJson({ state: 'unknown' }), { state: 'unknown', publishers: null });
    assert.deepEqual(toCorroborationJson({ state: 'tier4-only', publishers: 2 }), { state: 'tier4-only', publishers: 2 });
    const schema = CORROBORATION_OUTPUT_SCHEMA as {
      properties: { state: { enum: string[] }; publishers: { type: string[] } };
    };
    assert.deepEqual(
      [...schema.properties.state.enum].sort(),
      ['corroborated', 'single-publisher', 'tier4-only', 'unknown'],
    );
  });
});

describe('assessCorroboration: no category, threat level or alert flag is exempt', () => {
  const [t4a, t4b] = tier4PairsInDistinctFamilies()[0]!;
  const carriers: Array<{ labels: string[]; expected: Corroboration['state'] }> = [
    { labels: ['Reuters World'], expected: 'single-publisher' },
    { labels: ['Reuters World', 'Reuters US'], expected: 'single-publisher' },
    { labels: [t4a, t4b], expected: 'tier4-only' },
    { labels: [t4a, 'Reuters World'], expected: 'corroborated' },
    { labels: [t4a, UNDECLARED], expected: 'corroborated' },
  ];

  it('the same carriers give the same verdict for every category x level x isAlert', () => {
    for (const { labels, expected } of carriers) {
      const seen = new Set<string>();
      for (const category of THREAT_CATEGORIES) {
        for (const level of THREAT_LEVELS) {
          for (const isAlert of [true, false]) {
            const items = labels.map((source) => ({
              source,
              title: STORY,
              link: `https://example.test/${encodeURIComponent(source)}`,
              pubDate: new Date('2026-09-20T10:00:00Z'),
              isAlert,
              threat: { level, category, confidence: 0.9, source: 'keyword' as const },
            }));
            const clusters = clusterNewsCore(items, getSourceTier);
            assert.equal(clusters.length, 1, `${labels.join('+')} ${category}/${level}/${isAlert}`);
            const verdict = assessCorroboration(evidenceFromCluster(clusters[0]!));
            assert.equal(verdict.state, expected, `${labels.join('+')} ${category}/${level}/${isAlert}`);
            seen.add(JSON.stringify(verdict));
          }
        }
      }
      assert.equal(seen.size, 1, `${labels.join('+')} verdict varied with category/level/alert`);
    }
  });
});

const bestDeclared = (labels: readonly string[]): Publisher['tier'] => labels
  .map((label) => declaredSourceTier(label))
  .reduce<Publisher['tier']>((best, tier) => (tier !== null && (best === null || tier < best) ? tier : best), null);

function expectedPublisher(labels: string[]): Publisher {
  const family = publisherFamilyFor(labels[0]);
  return {
    family,
    name: Object.prototype.hasOwnProperty.call(PUBLISHER_FAMILIES, family) ? publisherNameForFamily(family) : labels[0]!.trim(),
    tier: bestDeclared(labels),
    labels,
  };
}

function rosterCorpus(): string[][] {
  const lists: string[][] = [
    [...declaredLabels, UNDECLARED],
    ...curatedFamilies.map(([, entry]) => [...entry.labels]),
    ...tier4PairsInDistinctFamilies(),
    ['', '  ', 'Reuters World', UNDECLARED, 'Reuters World'],
  ];
  for (const [a] of tier4PairsInDistinctFamilies()) {
    for (const tier of [1, 2, 3, null] as const) lists.push([a, sampleFor(tier, publisherFamilyFor(a))]);
  }
  return lists;
}

describe('publisherRoster: no source, tier or family is exempt (#6419 step 3)', () => {
  it('a lone label is one publisher at exactly its declared tier, for every table key and an undeclared label', () => {
    for (const label of [...declaredLabels, UNDECLARED]) {
      assert.deepEqual(publisherRoster(grouped([label])), [expectedPublisher([label])], label);
      assert.deepEqual(publisherRoster(evidenceFromItem({ source: label })), [expectedPublisher([label])], `item ${label}`);
    }
  });

  it('an undeclared label is never tier 4', () => {
    assert.equal(publisherRoster(grouped([UNDECLARED]))[0]!.tier, null);
    assert.equal(publisherRoster(grouped(['constructor']))[0]!.tier, null);
  });

  it('every curated family over all its labels is one publisher at the best tier any of them declares', () => {
    for (const [family, entry] of curatedFamilies) {
      const roster = publisherRoster(grouped([...entry.labels]));
      if (entry.labels.length === 0) {
        assert.deepEqual(roster, [], `${family} is domain-only: no label, nothing to list`);
        continue;
      }
      assert.deepEqual(roster, [{
        family,
        name: entry.publisher,
        tier: bestDeclared(entry.labels),
        labels: [...entry.labels],
      }], family);
    }
  });

  it('a family with conflicting declared tiers shows the tier of the labels this claim carries', () => {
    const conflicting = curatedFamilies.filter(([, entry]) =>
      new Set(entry.labels.map((label) => declaredSourceTier(label)).filter((tier) => tier !== null)).size > 1);
    assert.ok(conflicting.length > 0, 'no family carries conflicting tiers any more; this case is vacuous');
    for (const [family, entry] of conflicting) {
      for (const label of entry.labels) {
        assert.equal(publisherRoster(grouped([label]))[0]!.tier, declaredSourceTier(label), `${family} ${label}`);
      }
    }
  });

  it('roster length is the seen family count for every list in the corpus', () => {
    for (const labels of rosterCorpus()) {
      assert.equal(publisherRoster(grouped(labels)).length, countPublisherFamilies(labels), labels.join(' + '));
    }
  });

  it('orders by tier ascending, undeclared last, then name', () => {
    const roster = publisherRoster(grouped([UNDECLARED, 'The Verge', 'BBC World', 'Reuters World', 'Defense One', 'AFP']));
    assert.deepEqual(roster.map((p) => [p.name, p.tier]), [
      ['AFP', 1], ['Reuters', 1], ['BBC', 2], ['Defense One', 3], ['The Verge', 4], [UNDECLARED, null],
    ]);
  });

  it('keeps each distinct label once in first-seen order, so the tier traces to a label', () => {
    assert.deepEqual(publisherRoster(grouped(['The Verge', 'The Vergecast', 'The Verge'])), [
      { family: 'the-verge', name: 'The Verge', tier: 3, labels: ['The Verge', 'The Vergecast'] },
    ]);
  });

  it('is empty exactly when there are no labels to read', () => {
    assert.deepEqual(publisherRoster(grouped([])), []);
    assert.deepEqual(publisherRoster(grouped(['', '  '])), []);
    assert.deepEqual(publisherRoster(evidenceFromStory({ sources: 'Reuters' })), []);
  });
});

describe('publisherRoster agrees with assessCorroboration', () => {
  it('tier4-only means every row and every listed label is declared tier 4, and the verdict never counts fewer publishers than rows', () => {
    let tier4Seen = 0;
    for (const labels of rosterCorpus()) {
      for (const reported of [null, 1, labels.length + 1]) {
        const evidence = grouped(labels, reported);
        const verdict = assessCorroboration(evidence);
        const roster = publisherRoster(evidence);
        const context = `${labels.join(' + ')} reported=${reported}`;
        if (verdict.state === 'tier4-only') {
          tier4Seen += 1;
          assert.ok(roster.every((p) => p.tier === 4), context);
          assert.ok(roster.every((p) => p.labels.every((label) => declaredSourceTier(label) === 4)), context);
        }
        if (verdict.state === 'unknown') {
          assert.equal(roster.length, 0, context);
        } else {
          assert.ok(roster.length > 0, context);
          assert.ok(verdict.publishers >= roster.length, context);
          const json = toPublisherRosterJson(roster, verdict);
          assert.equal(json.publishers.length + json.publishersUnlisted, verdict.publishers, `${context}: the wire roster reconciles with the verdict`);
        }
      }
    }
    assert.ok(tier4Seen > 0, 'the corpus never produced tier4-only; the agreement check is vacuous');
  });
});

describe('publisher roster wire form', () => {
  it(`lists at most ${PUBLISHER_ROSTER_CAP} publishers and counts the rest`, () => {
    const labels = Array.from({ length: PUBLISHER_ROSTER_CAP + 4 }, (_, i) => `${UNDECLARED} ${i}`);
    const evidence = grouped(['Reuters World', ...labels]);
    const json = toPublisherRosterJson(publisherRoster(evidence), assessCorroboration(evidence));
    assert.equal(json.publishers.length, PUBLISHER_ROSTER_CAP);
    assert.equal(json.publishersUnlisted, 5);
    assert.deepEqual(json.publishers[0], { name: 'Reuters', tier: 1, labels: ['Reuters World'], labelsUnlisted: 0 });
    assert.deepEqual(toPublisherRosterJson([], { state: 'unknown' }), { publishers: [], publishersUnlisted: 0 });
  });

  it('counts publishers the verdict knows of but the labels cannot name', () => {
    const above = grouped(['Reuters World', 'BBC World'], 5);
    assert.equal(toPublisherRosterJson(publisherRoster(above), assessCorroboration(above)).publishersUnlisted, 3);
    const labels = Array.from({ length: PUBLISHER_ROSTER_CAP + 2 }, (_, i) => `${UNDECLARED} ${i}`);
    const cappedAndAbove = grouped(labels, PUBLISHER_ROSTER_CAP + 6);
    assert.equal(
      toPublisherRosterJson(publisherRoster(cappedAndAbove), assessCorroboration(cappedAndAbove)).publishersUnlisted,
      6,
      'past the cap and beyond the labels are one count, not two',
    );
  });

  it(`caps wire strings at ${PUBLISHER_ROSTER_STRING_MAX_BYTES} UTF-8 bytes without splitting a character`, () => {
    const long = `${'é'.repeat(30)}${'本'.repeat(10)}`;
    const [publisher] = toPublisherRosterJson(publisherRoster(grouped([long])), assessCorroboration(grouped([long]))).publishers;
    assert.equal(publisher!.name, 'é'.repeat(20));
    assert.deepEqual(publisher!.labels, ['é'.repeat(20)]);
  });

  it('every configured label and publisher name fits the wire cap whole', () => {
    const names = [...declaredLabels, ...curatedFamilies.flatMap(([, entry]) => [entry.publisher, ...entry.labels])];
    const tooLong = names.filter((name) => Buffer.byteLength(name, 'utf8') > PUBLISHER_ROSTER_STRING_MAX_BYTES);
    assert.deepEqual(tooLong, [], 'raise PUBLISHER_ROSTER_STRING_MAX_BYTES only after re-measuring the get_news_clusters worst-case budget');
  });

  it('schema tier enum is the declared tiers plus null, described from TIER_MEANING', () => {
    const schema = PUBLISHER_ROSTER_OUTPUT_PROPERTIES as {
      publishers: { items: { properties: { tier: { enum: unknown[]; description: string } }; required: string[] } };
    };
    const tier = schema.publishers.items.properties.tier;
    assert.deepEqual(tier.enum, [1, 2, 3, 4, null]);
    for (const meaning of Object.values(TIER_MEANING)) assert.ok(tier.description.includes(meaning), meaning);
    assert.deepEqual(schema.publishers.items.required, ['name', 'tier', 'labels', 'labelsUnlisted']);
  });
});

describe('publisherRoster: no category, threat level or alert flag is exempt', () => {
  const [t4a, t4b] = tier4PairsInDistinctFamilies()[0]!;
  for (const labels of [['Reuters World'], ['Reuters World', 'Reuters US'], [t4a, t4b], [t4a, 'Reuters World', UNDECLARED]]) {
    it(`${labels.join(' + ')} yields one roster for every category x level x isAlert`, () => {
      const seen = new Set<string>();
      for (const category of THREAT_CATEGORIES) {
        for (const level of THREAT_LEVELS) {
          for (const isAlert of [true, false]) {
            const items = labels.map((source) => ({
              source,
              title: STORY,
              link: `https://example.test/${encodeURIComponent(source)}`,
              pubDate: new Date('2026-09-20T10:00:00Z'),
              isAlert,
              threat: { level, category, confidence: 0.9, source: 'keyword' as const },
            }));
            const clusters = clusterNewsCore(items, getSourceTier);
            assert.equal(clusters.length, 1);
            seen.add(JSON.stringify(publisherRoster(evidenceFromCluster(clusters[0]!))));
          }
        }
      }
      assert.equal(seen.size, 1, 'roster varied with category/level/alert');
      assert.equal((JSON.parse([...seen][0]!) as unknown[]).length, countPublisherFamilies(labels));
    });
  }
});
