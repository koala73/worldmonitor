/**
 * #6419 step 2: the single-source / tier-4-only rule applies uniformly.
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
  assessCorroboration,
  evidenceFromCluster,
  evidenceFromItem,
  toCorroborationJson,
  type ClaimEvidence,
  type Corroboration,
} from '../server/_shared/corroboration.ts';
import { SOURCE_TIERS, declaredSourceTier, getSourceTier } from '../server/_shared/source-tiers.ts';
import { clusterNewsCore } from '../shared/news-clustering-core.js';
import { THREAT_CATEGORIES, THREAT_LEVELS } from '../shared/jev-classify.js';
import { publisherFamilyFor } from '../shared/publisher-families.js';

const UNDECLARED = 'Synthetic Unmapped Outlet 6419';
const STORY = 'Missile attack kills troops in border strike officials say';

const grouped = (labels: string[], reportedPublishers: number | null = null): ClaimEvidence =>
  ({ kind: 'grouped', labels, reportedPublishers });

const declaredLabels = Object.keys(SOURCE_TIERS);
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
