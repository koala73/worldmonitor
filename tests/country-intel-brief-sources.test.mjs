import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCountryBriefSources, renderEvidenceGroundedCountryBrief } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';
import { parseBriefSections } from '../scripts/crawlable-developments.mjs';

describe('evidence-grounded country brief rendering', () => {
  const sources = [
    { title: 'Finland completes a 200-kilometer fence', source: 'Reuters', url: 'https://reuters.com/fence', publishedAt: '' },
    { title: 'Fitburg defendants deny sabotage', source: 'Yle', url: 'https://yle.fi/trial', publishedAt: '' },
    { title: 'Former President Niinisto warns of 85 border incidents', source: 'HS', url: 'https://hs.fi/border', publishedAt: '' },
  ];
  const evidence = [
    { id: 'E1', kind: 'cii', label: 'Country Instability Index', value: '31 of 100 (Low)', factText: "Finland's Country Instability Index is 31 of 100 (Low) as of Sep 21, 2026.", asOf: '2026-09-21T04:46:00.000Z' },
    { id: 'E2', kind: 'resilience-dimension', label: 'Fiscal space', value: '28 of 100', factText: "Finland's fiscal space scores 28 of 100 in the Country Resilience Index (Aug 29, 2026 snapshot).", asOf: '2026-08-29T00:00:00.000Z' },
    { id: 'E3', kind: 'market', label: 'Polymarket', value: '62%', factText: "Polymarket prices 'Will Finland close its eastern border by December 31?' at 62% (closes Dec 31, 2026).", asOf: '2026-09-21T00:00:00.000Z', url: 'https://polymarket.com/event/finland-border' },
  ];
  const claim = (text, citedSources = [], citedEvidence = []) => ({ text, sources: citedSources, evidence: citedEvidence });
  const payload = (overrides = {}) => ({
    situation: [claim('Finland completes a 200-kilometer fence', [1])],
    implications: [], risks: [], outlook: [], watch: [],
    ...overrides,
  });
  const render = (value) => renderEvidenceGroundedCountryBrief(JSON.stringify(value), sources, evidence, 'Finland');

  it('renders only non-empty sections, with headline and evidence markers', () => {
    const result = render(payload({
      risks: [claim("Finland's fiscal space scores 28 of 100 in the Country Resilience Index.", [], ['E2'])],
    }));
    assert.ok(result);
    assert.equal(result.text, [
      'SITUATION NOW\nFinland completes a 200-kilometer fence [1]',
      "KEY RISKS\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]",
    ].join('\n\n'));
    assert.deepEqual(result.sections.map((section) => section.key), ['situation', 'risks']);
    assert.deepEqual(result.sections[1].claims[0], { text: "Finland's fiscal space scores 28 of 100 in the Country Resilience Index.", sourceIndexes: [], evidenceIds: ['E2'] });
    assert.deepEqual(result.evidence.map((item) => item.id), ['E2']);
  });

  it('renders text the corpus parses back into the same sections and claims', () => {
    const result = render(payload({
      implications: [claim('Finland completes a border fence while its fiscal space scores 28 of 100 in the Country Resilience Index.', [1], ['E2'])],
      risks: [claim("Finland's Country Instability Index is 31 of 100 (Low) as of Sep 21, 2026.", [], ['E1'])],
      outlook: [claim("Polymarket prices 'Will Finland close its eastern border by December 31?' at 62% (closes Dec 31, 2026).", [], ['E3'])],
      watch: [claim('Fitburg defendants deny sabotage', [2])],
    }));
    const parsed = parseBriefSections(result.text, { countryCode: 'FI', countryName: 'Finland' });
    assert.deepEqual(parsed.map((section) => section.key), ['situation', 'implications', 'risks', 'outlook', 'watch']);
    assert.deepEqual(parsed.map(({ key, claims }) => ({ key, claims })), result.sections.map(({ key, claims }) => ({ key, claims })));
  });

  it('never emits evidence-limit or withheld notices', () => {
    const result = render(payload({ risks: [claim('Tamar output increases 30%', [], ['E2'])] }));
    assert.ok(result);
    assert.doesNotMatch(result.text, /do not establish|withheld/i);
    assert.equal(result.withheld, 1);
    assert.deepEqual(result.sections.map((section) => section.key), ['situation']);
  });

  it('drops a claim whose number is not in the evidence it cites (AE2)', () => {
    const wrong = render(payload({ risks: [claim("Finland's fiscal space scores 23 of 100 in the Country Resilience Index.", [], ['E2'])] }));
    assert.deepEqual(wrong.sections.map((section) => section.key), ['situation']);
    const right = render(payload({ risks: [claim("Finland's fiscal space scores 28 of 100 in the Country Resilience Index.", [], ['E2'])] }));
    assert.deepEqual(right.sections.map((section) => section.key), ['situation', 'risks']);
  });

  it('takes numbers only from cited evidence when a claim cites both kinds', () => {
    const laundered = render(payload({ risks: [claim("Finland's Country Instability Index is 85 of 100.", [3], ['E1'])] }));
    assert.deepEqual(laundered.sections.map((section) => section.key), ['situation']);
  });

  it('binds numbers to the cited value, not to its as-of date, its scale or a second metric', () => {
    for (const bad of [
      claim("Finland's Country Instability Index is 21 of 100 (Low).", [], ['E1']),
      claim("Finland's Country Instability Index is 100.", [], ['E1']),
      claim("Finland's fiscal space scores 31 of 100 in the Country Resilience Index and its Country Instability Index is 28 of 100.", [], ['E1', 'E2']),
    ]) {
      assert.deepEqual(render(payload({ risks: [bad] })).sections.map((section) => section.key), ['situation'], bad.text);
    }
  });

  it('drops sentences about the evidence instead of about the country', () => {
    const result = render(payload({ watch: [claim('The supplied headlines do not establish this.', [1])] }));
    assert.deepEqual(result.sections.map((section) => section.key), ['situation']);
    assert.equal(result.withheld, 1);
  });

  it('enforces the citation kinds each section accepts (AE3)', () => {
    const headlineOnlyRisk = render(payload({ risks: [claim('Fitburg defendants deny sabotage', [2])] }));
    assert.deepEqual(headlineOnlyRisk.sections.map((section) => section.key), ['situation']);
    const evidenceOnlyImplication = render(payload({ implications: [claim("Finland's fiscal space scores 28 of 100 in the Country Resilience Index.", [], ['E2'])] }));
    assert.deepEqual(evidenceOnlyImplication.sections.map((section) => section.key), ['situation']);
    const linkedImplication = render(payload({ implications: [claim("Finland completes a border fence while its fiscal space scores 28 of 100 in the Country Resilience Index.", [1], ['E2'])] }));
    assert.deepEqual(linkedImplication.sections.map((section) => section.key), ['situation', 'implications']);
    const ciiOutlook = render(payload({ outlook: [claim("Finland's Country Instability Index is 31 of 100 (Low).", [], ['E1'])] }));
    assert.deepEqual(ciiOutlook.sections.map((section) => section.key), ['situation']);
    const marketOutlook = render(payload({ outlook: [claim("Polymarket prices 'Will Finland close its eastern border by December 31?' at 62% (closes Dec 31, 2026).", [], ['E3'])] }));
    assert.deepEqual(marketOutlook.sections.map((section) => section.key), ['situation', 'outlook']);
    const headlineOutlook = render(payload({ outlook: [claim('Fitburg defendants deny sabotage', [2])] }));
    assert.deepEqual(headlineOutlook.sections.map((section) => section.key), ['situation']);
    const marketWatch = render(payload({ watch: [claim("Polymarket prices 'Will Finland close its eastern border by December 31?' at 62% (closes Dec 31, 2026).", [], ['E3'])] }));
    assert.deepEqual(marketWatch.sections.map((section) => section.key), ['situation', 'watch']);
  });

  it('keeps an evidence-only claim that names the country', () => {
    const result = render(payload({ risks: [claim("Finland's Country Instability Index is 31 of 100 (Low) as of Sep 21, 2026.", [], ['E1'])] }));
    assert.deepEqual(result.sections.map((section) => section.key), ['situation', 'risks']);
  });

  it('drops invented names, unknown ids and status qualifiers the cited text never made', () => {
    for (const bad of [
      claim('Tamar faces disruption in Finland', [], ['E2']),
      claim("Finland's fiscal space scores 28 of 100.", [], ['E9']),
      claim('Finland completes a fence', [7]),
      claim('Former Minister Fitburg denies sabotage', [2]),
    ]) {
      const result = render(payload({ watch: [bad] }));
      assert.deepEqual(result.sections.map((section) => section.key), ['situation'], JSON.stringify(bad));
    }
    const qualified = render(payload({ watch: [claim('Former President Niinisto warns of 85 border incidents', [3])] }));
    assert.deepEqual(qualified.sections.map((section) => section.key), ['situation', 'watch']);
  });

  it('caps claims per section', () => {
    const result = render(payload({ situation: [
      claim('Finland completes a 200-kilometer fence', [1]),
      claim('Fitburg defendants deny sabotage', [2]),
      claim('Former President Niinisto warns of 85 border incidents', [3]),
    ] }));
    assert.equal(result.sections[0].claims.length, 2);
  });

  it('accepts bounded citation spellings and rejects malformed ones', () => {
    for (const cited of [[1], ['1'], ['[1]']]) {
      assert.match(render(payload({ situation: [claim('Finland completes a 200-kilometer fence', cited)] })).text, /fence \[1\]/);
    }
    for (const cited of [['1,2'], ['1.5'], ['1foo']]) {
      assert.equal(render(payload({ situation: [claim('Finland completes a 200-kilometer fence', cited)] })), null);
    }
  });

  it('returns null without a grounded situation claim or for malformed output', () => {
    assert.equal(render(payload({ situation: [claim('Tamar faces disruption', [1])] })), null);
    assert.equal(render(payload({ situation: [claim("Finland's fiscal space scores 28 of 100.", [], ['E2'])] })), null);
    for (const raw of ['not json', '{}', '[]', JSON.stringify({ ...payload(), risks: 'x' })]) {
      assert.equal(renderEvidenceGroundedCountryBrief(raw, sources, evidence, 'Finland'), null);
    }
    assert.equal(renderEvidenceGroundedCountryBrief(JSON.stringify(payload({ situation: [{ text: 'Finland completes\na 200-kilometer fence', sources: [1], evidence: [] }] })), sources, evidence, 'Finland'), null);
  });
});

describe('country intel brief source parsing', () => {
  it('parses bounded structured source lines from the context snapshot', () => {
    const sources = parseCountryBriefSources([
      'Country: United States (US)',
      'Brief source articles:',
      'Source [1]: {"title":"US headline | with delimiter","source":"Example | Wire","url":"https://example.com/us","publishedAt":"2026-06-07T00:00:00.000Z"}',
      'Source [2]: {"title":"Unsafe headline","source":"Bad Feed","url":"javascript:alert(1)"}',
      'Source [3]: {"title":"Duplicate headline","source":"Example Wire","url":"https://example.com/us"}',
      'Source [4]: Second headline | Agency | http://example.com/second',
    ].join('\n'));

    assert.deepEqual(sources, [
      {
        title: 'US headline | with delimiter',
        source: 'Example | Wire',
        url: 'https://example.com/us',
        publishedAt: '2026-06-07T00:00:00.000Z',
      },
      {
        title: 'Second headline',
        source: 'Agency',
        url: 'http://example.com/second',
        publishedAt: '',
      },
    ]);
  });
});
