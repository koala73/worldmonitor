import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BRIEF_SECTION_HEADERS,
  briefGroundingPublisherCount,
  briefTextLines,
  developmentsHasDatedItem,
  hasBriefGrounding,
  isBriefBullet,
  isBriefOutlookRow,
  isBriefSectionHeader,
  MIN_BRIEF_GROUNDING_PUBLISHERS,
  normalizeBriefText,
  normalizeFrozenDevelopments,
  stripBriefBullet,
} from '../scripts/crawlable-developments.mjs';

// Shapes taken from the 2026-09-04 frozen snapshot: 32 of 40 briefs carried
// `**` markers, 23 carried the ISO code in the "WHAT THIS MEANS FOR" heading,
// and Georgia's opened with an "INTELLIGENCE BRIEF / CLASSIFICATION:
// CONFIDENTIAL" preamble (#7738, #7748).
const NORWAY_RAW = [
  'SITUATION NOW',
  'Norway’s $2 trillion fund proposed cutting U.S. Treasury holdings [1][2].',
  '',
  'WHAT THIS MEANS FOR NO',
  '• **Norges Bank Investment Management (NBIM)**: Proposed slashing of holdings — billions moved [1][2].',
  '• **Norwegian krone**: could strengthen temporarily.',
  '',
  'KEY RISKS',
  '- **Retaliation**: Moscow may respond.',
  '',
  'OUTLOOK',
  'NEXT 24H: Pushback from U.S. Treasury officials.',
  'NEXT 48H: Security measures in the Barents Sea.',
  '',
  'WATCH ITEMS',
  'NBIM announcement · Russian maritime declarations',
].join('\n');

const GEORGIA_RAW = [
  '**INTELLIGENCE BRIEF: GE (GEORGIA)**',
  '**DATE:** 2026-09-04',
  '**CLASSIFICATION:** CONFIDENTIAL',
  '',
  '**SITUATION NOW**',
  'Georgia faces an energy inflection point [1].',
  '',
  '**WHAT THIS MEANS FOR GE**',
  '- **Black Sea Petroleum terminal:** cessation of Russian crude processing.',
].join('\n');

describe('normalizeBriefText', () => {
  it('strips markdown emphasis, keeps structure, and repairs the coded heading', () => {
    const text = normalizeBriefText(NORWAY_RAW, { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(!text.includes('**'));
    assert.ok(text.includes('WHAT THIS MEANS FOR NORWAY'));
    assert.ok(!/\bFOR NO\b/.test(text));
    assert.ok(text.startsWith('SITUATION NOW\n'));
    assert.ok(text.includes('• Norges Bank Investment Management (NBIM): Proposed slashing'));
    assert.ok(text.includes('NEXT 24H: Pushback'));
    assert.ok(text.endsWith('NBIM announcement · Russian maritime declarations'));
  });

  it('drops a model preamble before the first contract section', () => {
    const text = normalizeBriefText(GEORGIA_RAW, { countryCode: 'GE', countryName: 'Georgia' });
    assert.ok(text.startsWith('SITUATION NOW\n'), `preamble must go, got: ${text.slice(0, 40)}`);
    assert.ok(!text.includes('CLASSIFICATION'));
    assert.ok(!text.includes('INTELLIGENCE BRIEF'));
    assert.ok(text.includes('WHAT THIS MEANS FOR GEORGIA'));
  });

  it('keeps a cited lead the model wrote under its own header name', () => {
    const text = normalizeBriefText('CURRENT SITUATION\nConvoys move under escort [1].\n\nKEY RISKS\n• item', { countryCode: 'SD', countryName: 'Sudan' });
    assert.ok(text.startsWith('CURRENT SITUATION\nConvoys move under escort [1].'), 'a cited paragraph is content, not theatre');
  });

  it('keeps a brief that has no contract sections at all', () => {
    const prose = 'Two paragraphs of plain analysis [1].\n\nSecond paragraph.';
    assert.equal(normalizeBriefText(prose, { countryCode: 'NO', countryName: 'Norway' }), prose);
  });

  it('strips every markdown marker the model reaches for, not just the one first reported', () => {
    const text = normalizeBriefText('## SITUATION NOW\n__Port Sudan__ closed [1].\n* **Convoys** rerouted.', { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(text, 'SITUATION NOW\nPort Sudan closed [1].\n* Convoys rerouted.');
    assert.equal(isBriefBullet('* Convoys rerouted.'), true, 'an asterisk bullet is still a bullet once the markers are gone');
  });

  it('repairs the heading only for the page country and only when a name is known', () => {
    const foreign = normalizeBriefText('WHAT THIS MEANS FOR SD\n• item', { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(foreign.includes('WHAT THIS MEANS FOR SD'), 'another country code is not this page’s to rewrite');
    const unnamed = normalizeBriefText('WHAT THIS MEANS FOR NO\n• item', { countryCode: 'NO', countryName: '' });
    assert.ok(unnamed.includes('WHAT THIS MEANS FOR NO'), 'without a name there is nothing to repair with');
    const trailing = normalizeBriefText('WHAT THIS MEANS FOR ES  \n• item', { countryCode: 'ES', countryName: 'Spain' });
    assert.ok(trailing.includes('WHAT THIS MEANS FOR SPAIN'));
    const named = normalizeBriefText('WHAT THIS MEANS FOR NORWAY\n• item', { countryCode: 'NO', countryName: 'Norway' });
    assert.ok(named.includes('WHAT THIS MEANS FOR NORWAY'));
  });

  it('is idempotent', () => {
    const once = normalizeBriefText(NORWAY_RAW, { countryCode: 'NO', countryName: 'Norway' });
    assert.equal(normalizeBriefText(once, { countryCode: 'NO', countryName: 'Norway' }), once);
  });
});

describe('brief line classifiers', () => {
  it('recognises the five contract headers case-insensitively', () => {
    for (const header of BRIEF_SECTION_HEADERS) {
      assert.equal(isBriefSectionHeader(header), true);
      assert.equal(isBriefSectionHeader(`${header} NORWAY`), true);
      assert.equal(isBriefSectionHeader(header.toLowerCase()), true);
    }
    assert.equal(isBriefSectionHeader('Convoys move under escort.'), false);
    assert.equal(isBriefSectionHeader(''), false);
  });

  it('classifies bullets and outlook rows', () => {
    assert.equal(isBriefBullet('• Port Sudan: closed'), true);
    assert.equal(isBriefBullet('- Port Sudan: closed'), true);
    assert.equal(isBriefBullet('Port Sudan - closed'), false);
    assert.equal(isBriefBullet('-5% output'), false, 'a negative number is not a bullet');
    assert.equal(stripBriefBullet('• Port Sudan: closed'), 'Port Sudan: closed');
    assert.equal(stripBriefBullet('- Port Sudan: closed'), 'Port Sudan: closed');
    assert.equal(isBriefOutlookRow('NEXT 24H: quiet'), true);
    assert.equal(isBriefOutlookRow('NEXT week: quiet'), false);
    assert.deepEqual(briefTextLines('a\n\n  b  \n'), ['a', 'b']);
  });
});

describe('brief grounding floor', () => {
  it('counts distinct publisher families, never raw source labels', () => {
    // Egypt's committed brief cleared a raw count on three Egypt Independent
    // articles; three labels from one newsroom are one publisher (#6428).
    assert.equal(MIN_BRIEF_GROUNDING_PUBLISHERS, 2);
    const egypt = ['Egypt Independent', 'Egypt Independent', 'Egypt Independent'].map((source) => ({ source }));
    assert.equal(briefGroundingPublisherCount(egypt), 1);
    assert.equal(hasBriefGrounding(egypt), false);
    assert.equal(briefGroundingPublisherCount([{ source: 'BBC World' }, { source: 'BBC Africa' }]), 1, 'two editions of one newsroom are one family');
    assert.equal(hasBriefGrounding([{ source: 'UN News' }, { source: 'Test Wire' }]), true);
    assert.equal(hasBriefGrounding([]), false);
    assert.equal(hasBriefGrounding(null), false);
  });
});

describe('developmentsHasDatedItem', () => {
  it('counts a headline, a brief with text, or a timeline event, and nothing else', () => {
    const headline = { title: 't', source: 's', url: 'https://example.test/a', publishedAt: '2026-09-02T10:00:00.000Z' };
    assert.equal(developmentsHasDatedItem({ headlines: [headline], brief: null, timeline: [] }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: { text: 'SITUATION NOW' }, timeline: null }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: null, timeline: [{ title: 'e' }] }), true);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: { text: '  ' }, timeline: [] }), false);
    assert.equal(developmentsHasDatedItem({ headlines: [], brief: null, timeline: null, briefSkipped: 'no-grounding' }), false);
    assert.equal(developmentsHasDatedItem(null), false);
  });
});

describe('normalizeFrozenDevelopments', () => {
  const source = (n) => ({
    title: `Story ${n}`,
    source: `Wire ${n}`,
    url: `https://example.test/${n}`,
    publishedAt: '2026-09-02T10:00:00.000Z',
  });
  const brief = (sources) => ({
    text: 'SITUATION NOW\n**Bold** claim [1].\n\nWHAT THIS MEANS FOR SD\n• item',
    model: 'm',
    generatedAt: '2026-09-02T12:00:00.000Z',
    sources,
  });

  it('withholds a brief grounded on fewer than the floor and records why', () => {
    const row = { headlines: [source(1)], brief: brief([source(1)]), timeline: [], briefSkipped: null };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.brief, null);
    assert.equal(out.briefSkipped, 'thin-grounding');
    assert.deepEqual(out.headlines, row.headlines, 'the dated headline stays');
    assert.equal(row.brief !== null, true, 'the input is not mutated');
    // Two sources from one publisher are still one publisher.
    const oneOutlet = { ...row, brief: brief([source(1), { ...source(2), source: 'Wire 1' }]) };
    assert.equal(normalizeFrozenDevelopments(oneOutlet, { countryCode: 'SD', countryName: 'Sudan' }).brief, null);
  });

  it('normalizes the text of a sufficiently grounded brief and keeps its sources', () => {
    const row = { headlines: [source(1), source(2)], brief: brief([source(1), source(2)]), timeline: [], briefSkipped: null };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.briefSkipped, null);
    assert.equal(out.brief.sources.length, 2);
    assert.ok(!out.brief.text.includes('**'));
    assert.ok(out.brief.text.includes('WHAT THIS MEANS FOR SUDAN'));
    assert.equal(out.brief.generatedAt, '2026-09-02T12:00:00.000Z');
  });

  it('clears markdown markers from every published string, not only the brief', () => {
    // The build guard reads the whole <main>; one marker in a timeline
    // summary would otherwise fail a complete weekly capture.
    const row = {
      headlines: [{ ...source(1), title: '**Breaking**: convoys move' }],
      brief: brief([source(1), { ...source(2), title: '__Darfur__ harvest outlook' }]),
      timeline: [{ title: 'Port call **logged**', summary: 'A __scheduled__ call', sourceUrl: 'https://example.test/t', occurredAt: '2026-09-02T06:00:00.000Z', domain: 'maritime' }],
      briefSkipped: null,
    };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
    assert.equal(out.headlines[0].title, 'Breaking: convoys move');
    assert.equal(out.brief.sources[1].title, 'Darfur harvest outlook');
    assert.equal(out.timeline[0].title, 'Port call logged');
    assert.equal(out.timeline[0].summary, 'A scheduled call');
    assert.equal(out.headlines[0].url, row.headlines[0].url, 'URLs are untouched');
    assert.equal(row.headlines[0].title, '**Breaking**: convoys move', 'the input is not mutated');
  });

  it('hands a malformed sources field back untouched for the renderer to reject', () => {
    for (const sources of [undefined, null, 'UN News', [{ title: 'no outlet', url: 'https://example.test/x' }]]) {
      const row = { headlines: [source(1)], brief: { ...brief([]), sources }, timeline: [], briefSkipped: null };
      const out = normalizeFrozenDevelopments(row, { countryCode: 'SD', countryName: 'Sudan' });
      assert.deepEqual(out.brief, row.brief, `sources=${JSON.stringify(sources)} must not be withheld as thin grounding`);
      assert.equal(out.briefSkipped, null);
    }
  });

  it('passes rows without a brief through unchanged', () => {
    const row = { headlines: [], brief: null, timeline: null, briefSkipped: 'no-grounding' };
    assert.deepEqual(normalizeFrozenDevelopments(row, { countryCode: 'PW', countryName: 'Palau' }), row);
    assert.equal(normalizeFrozenDevelopments(null, {}), null);
    assert.equal(normalizeFrozenDevelopments(undefined, {}), undefined);
  });
});
