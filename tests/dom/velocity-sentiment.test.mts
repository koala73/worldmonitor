// src/services/velocity.ts had no test of any kind, and its two sentiment word
// sets shared a member. analyzeSentiment tests both sets without an else:
//
//   if (NEGATIVE_WORDS.has(word)) score -= 1;
//   if (POSITIVE_WORDS.has(word)) score += 1;
//
// so a word listed twice contributes nothing while reading, in both lists, as
// a deliberate weight. The score drives a user-visible badge: NewsPanel renders
// a warning or tick beside a headline once |sentimentScore| passes 2, and the
// label itself flips at ±1.
import { describe, expect, it } from 'vitest';

import {
  NEGATIVE_WORDS,
  POSITIVE_WORDS,
  analyzeSentiment,
  calculateVelocity,
} from '@/services/velocity';
import type { ClusteredEvent } from '@/types';

function cluster(primaryTitle: string, ...otherTitles: string[]): ClusteredEvent {
  const now = new Date();
  const allItems = [primaryTitle, ...otherTitles].map((title, i) => ({
    title, source: `Source ${i}`, link: `https://source-${i}.example/news`, pubDate: now, isAlert: false,
  }));
  return {
    id: 'cluster',
    primaryTitle,
    primarySource: allItems[0]!.source,
    primaryLink: allItems[0]!.link,
    allItems,
    sourceCount: allItems.length,
    uniquePublisherCount: allItems.length,
    topSources: [],
    isAlert: false,
    firstSeen: now,
    lastUpdated: now,
  };
}

describe('sentiment word sets', () => {
  it('are disjoint, so no term is silently inert', () => {
    const both = [...NEGATIVE_WORDS].filter((word) => POSITIVE_WORDS.has(word));
    // A word in both sets adds -1 and +1 and contributes nothing, while
    // reading in each list as a tuned weight.
    expect(both).toEqual([]);
  });

  it('contain only lowercase terms, since the analyser lowercases its input', () => {
    // A capitalised entry could never match, which is the same silent-inertness
    // failure in a different shape.
    for (const word of [...NEGATIVE_WORDS, ...POSITIVE_WORDS]) {
      expect(word, `${word} can never match lowercased input`).toBe(word.toLowerCase());
    }
  });

  it('split on the same boundaries the analyser tokenises on', () => {
    // analyzeSentiment splits on /\W+/, so a multi-word or punctuated entry is
    // unreachable.
    for (const word of [...NEGATIVE_WORDS, ...POSITIVE_WORDS]) {
      expect(word, `${word} cannot survive the \\W+ split`).toMatch(/^\w+$/);
    }
  });
});

describe('analyzeSentiment', () => {
  it('leaves surge neutral in the keyword scorer', () => {
    expect(analyzeSentiment('markets surge')).toEqual({ sentiment: 'neutral', score: 0 });
  });

  it('still reads the market-fall run as negative', () => {
    expect(analyzeSentiment('markets plunge and plummet').sentiment).toBe('negative');
  });

  it('nets a mixed headline rather than cancelling each term to zero', () => {
    // One of each: the terms offset, which is the arithmetic working, not a
    // word being inert.
    expect(analyzeSentiment('ceasefire holds after attack').score).toBe(0);
  });

  it('is neutral on text with no listed term', () => {
    expect(analyzeSentiment('quarterly filing published')).toEqual({ sentiment: 'neutral', score: 0 });
  });
});

describe('calculateVelocity sentiment', () => {
  it('keeps repeated reports of a cholera surge neutral', () => {
    const metrics = calculateVelocity(cluster(
      'Cholera surge in Haiti, says National Centre for Disease Control',
      'Haiti sees surge in cholera cases',
      'Doctors report cholera surge across Haiti',
    ));
    expect(metrics).toMatchObject({ sentiment: 'neutral', sentimentScore: 0 });
  });

  it('carries the score through to the metrics the panel renders', () => {
    const positive = calculateVelocity(cluster('Markets rally as growth and recovery take hold'));
    expect(positive.sentiment).toBe('positive');
    // Clears the badge threshold NewsPanel checks.
    expect(positive.sentimentScore).toBeGreaterThan(2);

    const negative = calculateVelocity(cluster('War and attack leave casualties'));
    expect(negative.sentiment).toBe('negative');
    expect(negative.sentimentScore).toBeLessThan(-2);
  });
});
