import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  briefCitationGroundingGap,
  briefGroundingGap,
  briefGroundingPublisherCount,
  COUNTRY_INDEX_ORIGIN,
  developmentsHasDatedItem,
  hasBriefGrounding,
  isVerifiableArticleUrl,
  MIN_BRIEF_GROUNDING_PUBLISHERS,
  normalizeBriefText,
  normalizeFrozenDevelopments,
  parseBriefSections,
  registrableDomain,
} from '../scripts/crawlable-developments.mjs';
import { isVerifiableArticleUrl as freezeIsVerifiableArticleUrl } from '../scripts/freeze-crawlable-live-pulse.mjs';

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

  it('repairs ISO headings regardless of letter case', () => {
    for (const heading of ['What this means for NO', 'What this means for no', 'WHAT THIS MEANS FOR NO']) {
      const text = normalizeBriefText(`${heading}\nNorway updates shipping rules [1][2].`, {
        countryCode: 'NO', countryName: 'Norway',
      });
      assert.equal(text, 'WHAT THIS MEANS FOR NORWAY\nNorway updates shipping rules [1][2].');
    }
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

  it('counts two rows on one site as one publisher whatever their labels say', () => {
    // GDELT index rows (#7748) carry the publishing domain as their label,
    // digest rows carry a feed label: "Guardian ME" and "theguardian.com"
    // are one newsroom, and the floor must not clear on it twice.
    const mixed = [
      { source: 'Guardian ME', url: 'https://www.theguardian.com/world/2026/sep/03/a' },
      { source: 'theguardian.com', url: 'https://www.theguardian.com/world/2026/sep/04/b' },
    ];
    assert.equal(briefGroundingPublisherCount(mixed), 1);
    assert.equal(hasBriefGrounding(mixed), false);
    // Editions on different hosts still fold through the family table.
    assert.equal(briefGroundingPublisherCount([
      { source: 'BBC World', url: 'https://www.bbc.co.uk/news/a' },
      { source: 'BBC Africa', url: 'https://www.bbc.com/news/b' },
    ]), 1);
    // Two genuinely different sites are two publishers, including
    // second-level country TLDs that a naive "last two labels" rule folds.
    assert.equal(briefGroundingPublisherCount([
      { source: 'rnz.co.nz', url: 'https://www.rnz.co.nz/news/pacific/1' },
      { source: 'abc.net.au', url: 'https://www.abc.net.au/news/2' },
    ]), 2);
    assert.equal(briefGroundingPublisherCount([
      { source: 'rnz.co.nz', url: 'https://www.rnz.co.nz/news/pacific/1' },
      { source: 'stuff.co.nz', url: 'https://www.stuff.co.nz/world/2' },
    ]), 2, 'rnz.co.nz and stuff.co.nz share a suffix, not a site');
    // A row without a usable URL counts by label alone.
    assert.equal(briefGroundingPublisherCount([
      { source: 'UN News' },
      { source: 'Test Wire', url: 'not a url' },
    ]), 2);
    // A shared host bridges two labels into one family transitively.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Wire A', url: 'https://news.example/a' },
      { source: 'Wire B', url: 'https://news.example/b' },
      { source: 'Wire B', url: 'https://other.example/c' },
    ]), 1);
  });

  it('resolves a curated newsroom by its domains, so two BBC hosts are one publisher', () => {
    // A digest label and an index row labelled by domain, on two different
    // registrable domains of one newsroom (review of #7748).
    assert.equal(briefGroundingPublisherCount([
      { source: 'BBC World', url: 'https://www.bbc.com/news/world-1' },
      { source: 'bbc.co.uk', url: 'https://www.bbc.co.uk/news/uk-2' },
    ]), 1);
    assert.equal(briefGroundingPublisherCount([
      { source: 'apnews.com', url: 'https://apnews.com/article/x' },
      { source: 'AP News', url: 'https://apnews.com/article/y' },
      { source: 'Reuters World', url: 'https://www.reuters.com/world/z' },
    ]), 2);
    // A subdomain edition folds into its newsroom.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Guardian World', url: 'https://www.theguardian.com/world/a' },
      { source: 'amp.theguardian.com', url: 'https://amp.theguardian.com/world/b' },
    ]), 1);
  });

  it('never treats an aggregator redirect host as a site', () => {
    // Canada's committed brief: three Google News redirect rows from two
    // families. A redirect host is not a site two labels can share.
    assert.equal(briefGroundingPublisherCount([
      { source: 'Reuters India', url: 'https://news.google.com/rss/articles/a' },
      { source: 'Reuters World', url: 'https://news.google.com/rss/articles/b' },
      { source: 'Gold & Metals', url: 'https://news.google.com/rss/articles/c' },
    ]), 2);
    assert.equal(isVerifiableArticleUrl('https://news.google.com/rss/articles/a'), false);
    assert.equal(isVerifiableArticleUrl('https://www.rnz.co.nz/news/a'), true);
    assert.equal(isVerifiableArticleUrl('http://www.rnz.co.nz/news/a'), false);
    assert.equal(freezeIsVerifiableArticleUrl, isVerifiableArticleUrl, 'the freeze re-exports the shared rule for the welcome strip');
  });

  it('requires a curated row behind a brief: index rows corroborate, they do not ground', () => {
    const index = (n, host) => ({
      title: `Story ${n}`, source: host, url: `https://${host}/${n}`, publishedAt: '2026-09-02T10:00:00.000Z', origin: COUNTRY_INDEX_ORIGIN,
    });
    const digest = { title: 'Digest story', source: 'Test Wire', url: 'https://wire.test/d', publishedAt: '2026-09-02T10:00:00.000Z' };
    assert.equal(briefGroundingGap([index(1, 'rnz.co.nz'), index(2, 'abc.net.au')]), 'uncurated-grounding');
    assert.equal(hasBriefGrounding([index(1, 'rnz.co.nz'), index(2, 'abc.net.au')]), false);
    assert.equal(briefGroundingGap([digest, index(1, 'rnz.co.nz')]), null);
    assert.equal(hasBriefGrounding([digest, index(1, 'rnz.co.nz')]), true);
    assert.equal(briefGroundingGap([digest]), 'thin-grounding', 'the publisher count is checked first');
    assert.equal(briefGroundingGap([index(1, 'rnz.co.nz')]), 'thin-grounding');
    // The publish-time rule withholds the brief with the same reason.
    const row = {
      headlines: [index(1, 'rnz.co.nz'), index(2, 'abc.net.au')],
      brief: { text: 'SITUATION NOW\nCalm [1].', model: 'm', generatedAt: '2026-09-02T12:00:00.000Z', sources: [index(1, 'rnz.co.nz'), index(2, 'abc.net.au')] },
      timeline: [],
      briefSkipped: null,
    };
    const out = normalizeFrozenDevelopments(row, { countryCode: 'NR', countryName: 'Nauru' });
    assert.equal(out.brief, null);
    assert.equal(out.briefSkipped, 'uncurated-grounding');
    assert.equal(out.headlines.length, 2, 'the dated headlines stay');
  });

  it('derives registrable domains with second-level suffixes intact', () => {
    assert.equal(registrableDomain('https://www.bbc.co.uk/news/a'), 'bbc.co.uk');
    assert.equal(registrableDomain('https://amp.theguardian.com/world/b'), 'theguardian.com');
    assert.equal(registrableDomain('https://www.abc.net.au/news/c'), 'abc.net.au');
    assert.equal(registrableDomain('https://example.test/x'), 'example.test');
    assert.equal(registrableDomain('not a url'), '');
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
  it('withholds invented assets and citations to the wrong source (#7865)', () => {
    const sources = [
      { title: 'Israel resumes talks', source: 'Reuters', url: 'https://reuters.com/a' },
      { title: 'Tamar resumes production', source: 'BBC', url: 'https://bbc.com/b' },
    ];
    for (const text of [
      'Tamar faces disruption [1].',
      'Tamar faces disruption [1][2].',
      'Israel resumes talks [1]. Leviathan faces disruption [1].',
      'Israel resumes talks [1].\n• Cerrejón faces disruption.',
      'Caño Limón-Coveñas faces disruption [1].',
      'El Guri faces disruption [1].',
      'Électricité de France faces disruption [1].',
      'The iPhone faces disruption [1].',
      'Ørsted faces disruption [1].',
      'Łódź faces disruption [1].',
      'ΔΕΗ faces disruption [1].',
      'The øBrand faces disruption [1].',
      '3M faces disruption [1].',
      '7-Eleven faces disruption [1].',
      'Israel resumes talks [1].\nOutlook for Tamar deteriorates [1].\nIsrael resumes talks [1].',
      'Israel resumes talks [1].\nOutlook for Tamar deteriorates.\nIsrael resumes talks [1].',
      'Israel resumes talks [1].\nWHAT THIS MEANS FOR ISRAEL: Tamar closed [1].',
    ]) {
      const row = { headlines: sources, brief: { text, sources }, timeline: [], briefSkipped: null };
      const out = normalizeFrozenDevelopments(row);
      assert.equal(out.brief, null, text);
      assert.equal(out.briefSkipped, 'unsupported-citation');
      assert.deepEqual(out.headlines, sources);
      assert.equal(row.brief.text, text, 'the historical input is unchanged');
      assert.deepEqual(normalizeFrozenDevelopments(out), out, 'withholding is idempotent');
    }
  });

  it('retains supported entities and the original source indexes', () => {
    const sources = [
      { title: 'Israel resumes talks', source: 'Reuters', url: 'https://reuters.com/a' },
      { title: 'Tamar resumes production', source: 'BBC', url: 'https://bbc.com/b' },
    ];
    const text = 'SITUATION NOW\nIsrael resumes talks [1].\nWHAT THIS MEANS FOR ISRAEL\n• Tamar faces disruption [2].';
    const out = normalizeFrozenDevelopments({ brief: { text, sources }, briefSkipped: null });
    assert.equal(out.brief.text, text);
    assert.deepEqual(out.brief.sources, sources);
    assert.equal(out.briefSkipped, null);
  });

  it('retains Unicode names when the cited title supports them', () => {
    for (const name of ['Ørsted', 'Łódź', 'ΔΕΗ', 'øBrand', '3M', '7-Eleven']) {
      const sources = [
        { title: `${name} resumes operations`, source: 'Reuters', url: 'https://reuters.com/a' },
        { title: 'Talks resume', source: 'BBC', url: 'https://bbc.com/b' },
      ];
      const text = `${name} faces disruption [1].`;
      const out = normalizeFrozenDevelopments({ brief: { text, sources } });
      assert.equal(out.brief?.text, text, name);
    }
  });

  // Distinct hosts per wire: rows on one site are one publisher (#7748).
  const source = (n) => ({
    title: `Story ${n}`,
    source: `Wire ${n}`,
    url: `https://wire${n}.test/${n}`,
    publishedAt: '2026-09-02T10:00:00.000Z',
  });
  const brief = (sources) => ({
    text: 'SITUATION NOW\n**Story** develops [1].\n\nWHAT THIS MEANS FOR SD\n• item',
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

describe('brief heading country identity', () => {
  it('rewrites exact aliases to the page name and is idempotent', () => {
    for (const [countryCode, countryName, alias] of [
      ['HK', 'Hong Kong', 'Hong Kong SAR China'],
      ['CD', 'DR Congo', 'Congo - Kinshasa'],
    ]) {
      const input = `WHAT THIS MEANS FOR ${alias}\nA supported claim [1].`;
      const expected = `WHAT THIS MEANS FOR ${countryName.toUpperCase()}\nA supported claim [1].`;
      const country = { countryCode, countryName };
      assert.equal(normalizeBriefText(input, country), expected);
      assert.equal(normalizeBriefText(expected, country), expected);
    }
  });
  it('leaves foreign names and prose unchanged', () => {
    const country = { countryCode: 'CD', countryName: 'DR Congo' };
    for (const heading of ['Congo - Brazzaville', 'Kinshasa', 'Congo - Kinshasa faces new risks [1]']) {
      const input = `SITUATION NOW\nA claim [1].\nWHAT THIS MEANS FOR ${heading}`;
      assert.equal(normalizeBriefText(input, country), input);
    }
  });
});

describe('evidence-grounded briefs', () => {
  const sources = [
    { title: 'Egypt stands firm on Gaza ceasefire', source: 'Reuters', url: 'https://reuters.com/eg' },
    { title: 'Egypt agrees to South Sudan dam', source: 'BBC', url: 'https://bbc.com/eg' },
  ];
  const evidence = [
    { id: 'E1', kind: 'resilience-dimension', label: 'Fiscal space', value: '28 of 100', asOf: '2026-08-29T00:00:00.000Z',
      factText: "Egypt's fiscal space scores 28 of 100 in the Country Resilience Index (Aug 29, 2026 snapshot)." },
    { id: 'E2', kind: 'chokepoint', label: 'Suez Canal', value: 'Suez Canal', asOf: '2026-09-21T00:00:00.000Z',
      factText: 'Egypt is linked to the Suez Canal chokepoint.', url: 'https://www.worldmonitor.app/chokepoints/suez-canal/' },
  ];
  const brief = (text) => ({ text, sources, evidence });

  it('grounds evidence-cited lines in the cited fact texts', () => {
    assert.equal(briefCitationGroundingGap(brief([
      'SITUATION NOW', 'Egypt stands firm on Gaza ceasefire [1]',
      'KEY RISKS', "Egypt's fiscal space scores 28 of 100 in the Country Resilience Index. [E1]",
      'WHAT THIS MEANS FOR EGYPT', 'Egypt agrees to South Sudan dam while linked to the Suez Canal chokepoint. [2][E2]',
    ].join('\n'))), null);
  });

  it('rejects unknown evidence ids, numbers and names the cited evidence does not state', () => {
    for (const line of [
      "Egypt's fiscal space scores 28 of 100. [E9]",
      "Egypt's fiscal space scores 23 of 100 in the Country Resilience Index. [E1]",
      'Egypt faces a Hormuz closure. [E2]',
    ]) {
      assert.ok(briefCitationGroundingGap(brief(`SITUATION NOW\nEgypt stands firm on Gaza ceasefire [1]\nKEY RISKS\n${line}`)), line);
    }
  });

  it('parses the server-rendered text back into sections and claims', () => {
    const text = [
      'SITUATION NOW', 'Egypt stands firm on Gaza ceasefire [1]', '',
      'WHAT THIS MEANS FOR EGYPT', 'Egypt agrees to South Sudan dam while linked to the Suez Canal chokepoint. [2][E2]', '',
      'KEY RISKS', "Egypt's fiscal space scores 28 of 100 in the Country Resilience Index. [E1]", 'An uncited line',
    ].join('\n');
    assert.deepEqual(parseBriefSections(text, { countryCode: 'EG', countryName: 'Egypt' }), [
      { key: 'situation', heading: 'SITUATION NOW', claims: [{ text: 'Egypt stands firm on Gaza ceasefire', sourceIndexes: [1], evidenceIds: [] }] },
      { key: 'implications', heading: 'WHAT THIS MEANS FOR EGYPT', claims: [{ text: 'Egypt agrees to South Sudan dam while linked to the Suez Canal chokepoint.', sourceIndexes: [2], evidenceIds: ['E2'] }] },
      { key: 'risks', heading: 'KEY RISKS', claims: [
        { text: "Egypt's fiscal space scores 28 of 100 in the Country Resilience Index.", sourceIndexes: [], evidenceIds: ['E1'] },
        { text: 'An uncited line', sourceIndexes: [], evidenceIds: [] },
      ] },
    ]);
  });

  it('applies the server claim rules: joined multi-headline grounding, bound numbers, qualifiers, no evidence-limit sentences', () => {
    const withTitles = (text) => ({
      text,
      sources: [...sources, { title: 'President Sisi meets CIA chief', source: 'Ahram', url: 'https://ahram.org.eg/sisi' }],
      evidence,
    });
    const gap = (line) => briefCitationGroundingGap(withTitles(`SITUATION NOW\nEgypt stands firm on Gaza ceasefire [1]\nWATCH ITEMS\n${line}`));
    assert.equal(gap('Egypt stands firm on Gaza ceasefire as Egypt agrees to South Sudan dam [1][2]'), null, 'the server accepts this two-headline claim');
    assert.equal(gap('President Sisi meets CIA chief [3]'), null);
    assert.ok(gap('Former President Sisi meets CIA chief [3]'), 'a status qualifier the title never made');
    assert.ok(gap("Egypt's fiscal space scores 29 of 100 in the Country Resilience Index. [E1]"), 'a number taken from the as-of date');
    assert.ok(gap('The supplied headlines do not establish this. [1]'), 'a sentence about the evidence');
  });

  it('recognizes the server heading for a country name the resolver cannot map (Côte d’Ivoire)', () => {
    const ciSources = [
      { title: 'Côte d’Ivoire signs LNG import deal', source: 'Reuters', url: 'https://reuters.com/ci' },
      { title: 'Côte d’Ivoire court reduces charges', source: 'BBC', url: 'https://bbc.com/ci' },
    ];
    const ciEvidence = [{ id: 'E1', kind: 'advisory', label: 'Travel advisory', value: 'Exercise Increased Caution', asOf: '2026-09-21T00:00:00.000Z',
      factText: 'The most severe government travel advisory World Monitor tracks for Côte d’Ivoire is Exercise Increased Caution.' }];
    const text = 'SITUATION NOW\nCôte d’Ivoire signs LNG import deal [1]\n\nWHAT THIS MEANS FOR CÔTE D’IVOIRE\nCôte d’Ivoire signs LNG import deal while its travel advisory is Exercise Increased Caution. [1][E1]';
    assert.equal(briefCitationGroundingGap({ text, sources: ciSources, evidence: ciEvidence }, { countryCode: 'CI' }), null);
    assert.deepEqual(parseBriefSections(text, { countryCode: 'CI' }).map((section) => section.key), ['situation', 'implications']);
    // Prose that merely starts with the phrase is still a claim, not a heading.
    assert.deepEqual(parseBriefSections('SITUATION NOW\nWhat this means for Côte d’Ivoire is unclear [1]', { countryCode: 'CI' }).map((section) => section.key), ['situation']);
  });

  it('keeps the per-title rule for pre-migration briefs', () => {
    const legacy = { text: 'SITUATION NOW\nEgypt stands firm on Gaza ceasefire as Egypt agrees to South Sudan dam [1][2]', sources };
    assert.ok(briefCitationGroundingGap(legacy));
  });

  it('still requires at least one headline citation', () => {
    assert.equal(briefCitationGroundingGap(brief("KEY RISKS\nEgypt's fiscal space scores 28 of 100 in the Country Resilience Index. [E1]")), 'missing citations');
  });

  it('strips legacy evidence-limit and withheld notices, and headings they leave empty', () => {
    const legacy = [
      'SITUATION NOW', 'Egypt stands firm on Gaza ceasefire. [1]', '',
      'WHAT THIS MEANS FOR EGYPT', 'The supplied headlines do not establish this.', '',
      'KEY RISKS', 'Egypt agrees to South Sudan dam. [2]', '',
      'OUTLOOK', 'The supplied headlines do not establish this.', '',
      'Some generated claims were withheld because they did not match the supplied source titles.',
    ].join('\n');
    const row = normalizeFrozenDevelopments({ brief: { text: legacy, sources, model: 'deepseek/deepseek-v4-flash' }, briefSkipped: null }, { countryCode: 'EG', countryName: 'Egypt' });
    assert.equal(Object.hasOwn(row.brief, 'model'), false, 'the model id never reaches a page or download');
    const out = normalizeBriefText(legacy, { countryCode: 'EG', countryName: 'Egypt' });
    assert.equal(out, 'SITUATION NOW\nEgypt stands firm on Gaza ceasefire. [1]\n\nKEY RISKS\nEgypt agrees to South Sudan dam. [2]');
    assert.equal(normalizeBriefText(out, { countryCode: 'EG', countryName: 'Egypt' }), out);
  });
});
