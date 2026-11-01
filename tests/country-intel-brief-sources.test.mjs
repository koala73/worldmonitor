import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCountryBriefSources, renderEvidenceGroundedCountryBrief } from '../server/worldmonitor/intelligence/v1/get-country-intel-brief.ts';
import { briefCitationGroundingGap, parseBriefSections } from '../scripts/crawlable-developments.mjs';

describe('country assessment energy grounding', () => {
  const sources = [
    { title: 'EXCLUSIVE Belize PM vows stronger support for Taiwan after China sanctions - Focus Taiwan', source: 'Focus Taiwan', url: 'https://example.com/belize', publishedAt: '' },
    { title: 'MAC criticizes China’s sanctions aiming at election interference - Taipei Times', source: 'Taipei Times', url: 'https://example.com/mac', publishedAt: '' },
    { title: 'China to add AI, biopharma and solar tech to export control list - Nikkei Asia', source: 'Nikkei Asia', url: 'https://example.com/export-controls', publishedAt: '2026-10-16' },
  ];
  const situation = 'China plans to add AI, biopharma and solar tech to its export control list.';
  const observed = "China's addition of AI, biopharma and solar tech to its export control list may affect global supply chains, given China has a net energy import dependency of 24%.";
  const energy = { id: 'E4', kind: 'energy', label: 'Net energy import dependency', value: '24%',
    factText: 'China has a net energy import dependency of 24% (IEA, 2023).', asOf: '2023-12-31T00:00:00.000Z' };
  const claim = (text, sources = [], evidence = []) => ({ text, sources, evidence });
  const render = (overrides = {}, evidence = [energy]) => renderEvidenceGroundedCountryBrief(JSON.stringify({
    situation: [claim(situation, [3])], implications: [], risks: [], outlook: [], watch: [], ...overrides,
  }), sources, evidence, 'China');

  it('withholds the retained export-controls explanation and preserves the situation and complete energy fact', () => {
    const result = render({ implications: [claim(observed, [3], ['E4'])], risks: [claim(energy.factText, [], ['E4'])] });
    assert.ok(result, 'a useful brief must survive');
    assert.ok(!result.text.includes(observed), 'the observed energy/export-controls implication must be withheld');
    assert.equal(result.withheld, 1);
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'risks']);
    assert.equal(result.sections[0].claims[0].text, situation);
    assert.equal(result.sections[1].claims[0].text, energy.factText);
  });

  it('rejects mixed energy claims independently of wording, evidence id and claim section', () => {
    const alternate = 'China has a net energy import dependency of 24%, so its export control list may affect global supply chains.';
    for (const id of ['E4', 'E9']) {
      for (const section of ['implications', 'risks', 'watch']) {
        const result = render({ [section]: [claim(alternate, [3], [id])] }, [{ ...energy, id }]);
        assert.ok(result);
        assert.equal(result.withheld, 1, `${id} ${section}`);
        assert.deepEqual(result.sections.map(item => item.key), ['situation']);
      }
    }
  });

  it('preserves whitespace-only exact facts and complete negative-exporter facts', () => {
    const exporter = { ...energy, value: '-24%', factText: 'China has a net energy import dependency of -24% (IEA, 2023); a negative value means China is a net energy exporter.' };
    for (const [item, text] of [[energy, energy.factText.replaceAll(' ', '  ')], [exporter, exporter.factText]]) {
      const result = render({ risks: [claim(text, [], [item.id])] }, [item]);
      assert.ok(result);
      assert.equal(result.withheld, 0);
      assert.equal(result.sections[1].claims[0].text, text);
    }
    const incomplete = render({ risks: [claim('China has a net energy import dependency of -24% (IEA, 2023).', [], ['E4'])] }, [exporter]);
    assert.equal(incomplete.withheld, 1);
  });

  it('explicitly rejects paraphrases, redundant headlines and companion evidence under the conservative policy', () => {
    const companion = { id: 'E5', kind: 'chokepoint', label: 'Taiwan Strait', value: '', factText: 'The Taiwan Strait is a shipping chokepoint World Monitor tracks for China.', asOf: '2026-10-17' };
    for (const bad of [
      claim('China has a net energy import dependency of 24%.', [], ['E4']),
      claim(energy.factText, [3], ['E4']),
      claim(energy.factText, [], ['E4', 'E5']),
      claim(energy.factText.replace('China', 'China’s economy'), [], ['E4']),
      claim(energy.factText.replace('.', '!'), [], ['E4']),
    ]) {
      const result = render({ risks: [bad] }, [energy, companion]);
      assert.ok(result);
      assert.equal(result.withheld, 1, bad.text);
      assert.deepEqual(result.sections.map(item => item.key), ['situation']);
    }
  });

  it('leaves missing-energy and uncited-energy controls unchanged', () => {
    for (const evidence of [[], [energy]]) {
      const result = render({}, evidence);
      assert.equal(result.withheld, 0);
      assert.deepEqual(result.sections[0].claims.map(item => item.text), [situation]);
    }
    const other = { id: 'E2', kind: 'resilience-dimension', label: 'Fiscal space', value: '28 of 100', factText: "China's fiscal space scores 28 of 100 in the Country Resilience Index.", asOf: '2026-10-17' };
    const result = render({ implications: [claim("China plans to add AI to its export control list while its fiscal space scores 28 of 100 in the Country Resilience Index.", [3], ['E2'])] }, [other]);
    assert.equal(result.withheld, 0);
    assert.deepEqual(result.sections.map(item => item.key), ['situation', 'implications']);
  });
});

describe('country assessment relationship grounding', () => {
  const headline = 'Belize PM vows stronger support for Taiwan after China sanctions';
  const urging = 'China urges Taliban authorities to take concrete action against terrorist groups';
  const sources = [
    { title: headline, source: 'Focus Taiwan', url: 'https://example.com/belize', publishedAt: '' },
    { title: urging, source: 'Amu TV', url: 'https://amu.tv/254528/', publishedAt: '' },
  ];
  const cii = { id: 'E1', kind: 'cii', label: 'Country Instability Index', value: '71 of 100 (High)',
    factText: 'China has a Country Instability Index score of 71 of 100 (High), in the High band, as of Oct 16, 2026.', asOf: '2026-10-16' };
  const claim = (text, sources = [], evidence = []) => ({ text, sources, evidence });
  const render = (overrides, inputSources = sources, evidence = [cii]) => renderEvidenceGroundedCountryBrief(JSON.stringify({
    situation: [claim(headline, [1])], implications: [], risks: [], outlook: [], watch: [], ...overrides,
  }), inputSources, evidence, 'China');

  it('withholds the observed China/Taliban role inversion and retains the cited headline independently', () => {
    const result = render({
      situation: [claim(headline, [1]), claim(urging, [2])],
      watch: [claim('Whether China will take concrete action against terrorist groups as urged by the Taliban authorities.', [2])],
    });
    assert.deepEqual(result.sections.map(section => section.key), ['situation']);
    assert.equal(result.withheld, 1);
    assert.deepEqual(result.sections[0].claims.map(entry => entry.text), [headline, urging]);
    assert.deepEqual(result.sections[0].claims[1].sourceIndexes, [2]);
  });

  it('withholds the observed CII/Belize causal implication while keeping the headline and isolated CII fact', () => {
    const result = render({
      implications: [claim("China's high Country Instability Index score of 71 of 100 may be exacerbated by diplomatic disputes with Belize over Taiwan.", [1], ['E1'])],
      risks: [claim(cii.factText, [], ['E1'])],
    });
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'risks']);
    assert.equal(result.withheld, 1);
    assert.equal(result.sections[0].claims[0].text, headline);
    assert.equal(result.sections[1].claims[0].text, cii.factText);
  });

  it('preserves the same urging roles in active, passive and watch forms', () => {
    for (const text of [
      urging,
      'China urged Taliban authorities to take concrete action against terrorist groups.',
      'Taliban authorities were urged by China to take concrete action against terrorist groups.',
      'Whether the Taliban authorities will take concrete action against terrorist groups as urged by China.',
      'Whether Taliban authorities will take concrete action against terrorist groups, as urged by China.',
    ]) {
      const result = render({ watch: [claim(text, [2])] });
      assert.deepEqual(result.sections.map(section => section.key), ['situation', 'watch'], text);
      assert.equal(result.sections[1].claims[0].text, text);
      assert.equal(result.withheld, 0);
    }
  });

  it('withholds changed actors, recipients and actions across claim sections', () => {
    for (const text of [
      'Taliban authorities urge China to take concrete action against terrorist groups.',
      'China was urged by Taliban authorities to take concrete action against terrorist groups.',
      'Whether Taliban authorities will take action against China as urged by China.',
    ]) {
      for (const section of ['situation', 'watch']) {
        const result = render({ [section]: [claim(headline, [1]), claim(text, [2])] });
        assert.equal(result.withheld, 1, `${section}: ${text}`);
        assert.doesNotMatch(result.text, /Taliban/);
      }
    }
  });

  it('uses the cited roles for another actor pair without country-specific rules', () => {
    const other = [{ ...sources[0], title: 'France urges Germany to reopen border crossings' }];
    for (const text of [
      'France urges Germany to reopen border crossings.',
      'Germany is urged by France to reopen border crossings.',
      'Whether Germany will reopen border crossings as urged by France.',
    ]) {
      const result = render({ situation: [claim(other[0].title, [1])], watch: [claim(text, [1])] }, other);
      assert.equal(result.withheld, 0, text);
      assert.deepEqual(result.sections.map(section => section.key), ['situation', 'watch']);
    }
    const reversed = render({ situation: [claim(other[0].title, [1])], watch: [claim('Whether France will reopen border crossings as urged by Germany.', [1])] }, other);
    assert.deepEqual(reversed.sections.map(section => section.key), ['situation']);
    assert.equal(reversed.withheld, 1);
  });

  it('fails closed on ambiguous and conflicting urging titles regardless of citation order', () => {
    const text = 'Whether Taliban authorities will take concrete action against terrorist groups as urged by China.';
    const conflict = [...sources, { ...sources[1], title: 'Taliban authorities urge China to take concrete action against terrorist groups' }];
    for (const indexes of [[2, 3], [3, 2]]) {
      const result = render({ watch: [claim(text, indexes)] }, conflict);
      assert.deepEqual(result.sections.map(section => section.key), ['situation']);
      assert.equal(result.withheld, 1);
    }
    const ambiguous = [sources[0], { ...sources[1], title: 'China urges action against terrorist groups' }];
    const result = render({ watch: [claim(text, [2])] }, ambiguous);
    assert.deepEqual(result.sections.map(section => section.key), ['situation']);
    assert.equal(result.withheld, 1);
  });

  it('does not turn a negated request into an affirmative watch item', () => {
    const title = 'France urges Germany not to reopen border crossings';
    const other = [{ ...sources[0], title }];
    const result = render({
      situation: [claim(title, [1])],
      watch: [claim('Whether Germany will reopen border crossings as urged by France.', [1])],
    }, other);
    assert.deepEqual(result.sections.map(section => section.key), ['situation']);
    assert.equal(result.sections[0].claims[0].text, title);
    assert.equal(result.withheld, 1);
  });

  it('cannot combine an actor, recipient and action from different cited titles', () => {
    const other = [sources[0],
      { ...sources[1], title: 'France urges Germany to reopen border crossings' },
      { ...sources[1], title: 'China urges Taliban authorities to take concrete action against terrorist groups' },
    ];
    for (const indexes of [[2, 3], [3, 2]]) {
      for (const text of [
        'Whether Germany will take concrete action against terrorist groups as urged by France.',
        'Whether Taliban authorities will reopen border crossings as urged by China.',
        'Whether Germany will reopen border crossings as urged by China.',
      ]) {
        const result = render({ watch: [claim(text, indexes)] }, other);
        assert.deepEqual(result.sections.map(section => section.key), ['situation'], text);
        assert.equal(result.withheld, 1);
      }
    }
  });

  it('preserves an independently cited market question about urging', () => {
    const market = { id: 'E10', kind: 'market', label: 'Kalshi', value: '80%',
      factText: "Kalshi prices 'Will China urge Taliban authorities to act?' at 80% (closes Jan 1, 2029).", asOf: '2026-10-16' };
    const result = render({ outlook: [claim(market.factText, [], ['E10'])] }, sources, [market]);
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'outlook']);
    assert.equal(result.sections[1].claims[0].text, market.factText);
    assert.equal(result.withheld, 0);
  });

  it('retains an exact independent priced market proposition naming CII', () => {
    const market = { id: 'E10', kind: 'market', label: 'Kalshi prediction market', value: '80%',
      factText: "A Kalshi market related to China, 'Will China have a high CII?', priced Yes at 80% on Oct 16, 2026; it closes Jan 1, 2029.", asOf: '2026-10-16' };
    const result = render({ outlook: [claim(market.factText, [], ['E10'])] }, sources, [market]);
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'outlook']);
    assert.equal(result.sections[1].claims[0].text, market.factText);
    assert.deepEqual(result.sections[1].claims[0].evidenceIds, ['E10']);
    assert.deepEqual(result.evidence.map(item => item.id), ['E10']);
    assert.equal(result.withheld, 0);
  });

  it('retains a complete attributed forecast about CII without asserting its outcome', () => {
    const forecast = { id: 'E10', kind: 'forecast', label: 'World Monitor forecast', value: '80%',
      factText: 'A World Monitor forecast related to China, "Will China have a high Country Instability Index?", gives a 80% probability by Jan 1, 2029, as of Oct 16, 2026.', asOf: '2026-10-16' };
    const result = render({ outlook: [claim(forecast.factText, [], ['E10'])] }, sources, [forecast]);
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'outlook']);
    assert.equal(result.sections[1].claims[0].text, forecast.factText);
    assert.deepEqual(result.evidence.map(item => item.id), ['E10']);
    assert.equal(result.withheld, 0);
    for (const text of [
      'China has a high Country Instability Index.',
      forecast.factText.replace('80%', '81%'),
      forecast.factText.replace(', as of Oct 16, 2026', ''),
      `${forecast.factText} China has a high Country Instability Index.`,
    ]) {
      const rejected = render({ outlook: [claim(text, [], ['E10'])] }, sources, [forecast]);
      assert.deepEqual(rejected.sections.map(section => section.key), ['situation'], text);
      assert.equal(rejected.withheld, 1);
    }
  });

  it('does not let a forward evidence kind license an asserted CII score or incomplete proposition', () => {
    for (const kind of ['market', 'forecast']) {
      for (const text of ['China has a high CII.', cii.factText]) {
        const mislabeled = { ...cii, kind, factText: text };
        const result = render({ outlook: [claim(text, [], ['E1'])] }, sources, [mislabeled]);
        assert.deepEqual(result.sections.map(section => section.key), ['situation']);
        assert.equal(result.withheld, 1);
      }
    }
    const market = { id: 'E10', kind: 'market', label: 'Kalshi prediction market', value: '80%',
      factText: 'A Kalshi market related to China, "Will China have a high CII?", priced Yes at 80% on Oct 16, 2026; it closes Jan 1, 2029.', asOf: '2026-10-16' };
    for (const text of [
      'China has a high CII.',
      'Will China have a high CII?',
      market.factText.replace('80%', '81%'),
      market.factText.replace('; it closes Jan 1, 2029', ''),
      `${market.factText} China has a high CII.`,
    ]) {
      const result = render({ outlook: [claim(text, [], ['E10'])] }, sources, [market]);
      assert.deepEqual(result.sections.map(section => section.key), ['situation'], text);
      assert.equal(result.withheld, 1);
    }
    for (const [indexes, evidenceIds] of [[[1], ['E10']], [[], ['E10', 'E1']]]) {
      const result = render({ watch: [claim(market.factText, indexes, evidenceIds)] }, sources, [market, cii]);
      assert.deepEqual(result.sections.map(section => section.key), ['situation']);
      assert.equal(result.withheld, 1);
    }
  });

  it('cannot rescue a reversed relation with evidence or an unrelated headline', () => {
    const text = 'Whether China will take concrete action against terrorist groups as urged by the Taliban authorities.';
    const extra = { id: 'E5', kind: 'chokepoint', value: 'Taiwan', factText: 'China is linked to Taiwan.' };
    const result = render({ watch: [claim(text, [1, 2], ['E5'])] }, sources, [extra]);
    assert.deepEqual(result.sections.map(section => section.key), ['situation']);
    assert.equal(result.withheld, 1);
    assert.deepEqual(result.evidence, []);
    assert.equal(render({ situation: [claim(text, [2])] }), null);
  });

  it('retains isolated CII facts with optional trailing band and date disclosure', () => {
    for (const text of [
      cii.factText,
      'China has a Country Instability Index score of 71 of 100 (High), in the High band.',
      'China has a Country Instability Index score of 71 of 100 (High).',
      'China has a Country Instability Index score of 71 of 100.',
    ]) {
      const result = render({ risks: [claim(text, [], ['E1'])] });
      assert.deepEqual(result.sections.map(section => section.key), ['situation', 'risks'], text);
      assert.equal(result.withheld, 0);
    }
  });

  it('cannot bypass the isolated CII rule with renumbering, another section or companion evidence', () => {
    const renumbered = { ...cii, id: 'E7' };
    const extra = { id: 'E5', kind: 'chokepoint', value: 'Taiwan', factText: 'China is linked to Taiwan.' };
    for (const section of ['situation', 'implications', 'risks', 'watch']) {
      for (const [indexes, evidenceIds] of [[[1], ['E7']], [[], ['E7', 'E5']]]) {
        const claims = [claim(cii.factText, indexes, evidenceIds)];
        if (section === 'situation') claims.unshift(claim(headline, [1]));
        const result = render({ [section]: claims }, sources, [renumbered, extra]);
        assert.equal(result.withheld, 1, section);
        assert.deepEqual(result.evidence, []);
      }
    }
    for (const text of [
      `${cii.factText} This may worsen China instability.`,
      'China has a Country Instability Index score of 70 of 100.',
      'China has a Country Instability Index score of 71 of 100 (Low).',
    ]) {
      const result = render({ risks: [claim(text, [], ['E1'])] });
      assert.deepEqual(result.sections.map(section => section.key), ['situation']);
      assert.equal(result.withheld, 1);
    }
  });

  it('requires typed CII evidence even for nonnumeric claims and matching headline text', () => {
    for (const text of [cii.factText, 'China has a high Country Instability Index.', 'China has a high CII.']) {
      const matchingSources = [...sources, { ...sources[0], title: text }];
      const absent = render({ watch: [claim(text, [3])] }, matchingSources, []);
      assert.deepEqual(absent.sections.map(section => section.key), ['situation'], text);
      assert.equal(absent.withheld, 1);
      const wrongKind = { ...cii, kind: 'chokepoint', factText: text };
      const wrong = render({ risks: [claim(text, [], ['E1'])] }, matchingSources, [wrongKind]);
      assert.deepEqual(wrong.sections.map(section => section.key), ['situation'], text);
      assert.equal(wrong.withheld, 1);
      assert.deepEqual(wrong.evidence, []);
    }
    for (const text of ['China has a high Country Instability Index.', 'China has a high CII.']) {
      const result = render({ risks: [claim(text, [], ['E1'])] });
      assert.deepEqual(result.sections.map(section => section.key), ['situation'], text);
      assert.equal(result.withheld, 1);
    }
  });
});

describe('sanctions aggregate claim publication', () => {
  const headline = 'Belize PM vows stronger support for Taiwan after China sanctions';
  const sources = [{ title: headline, source: 'Focus Taiwan', url: '', publishedAt: '' }];
  const atom = 'China is linked to 1,396 US OFAC and Canada SEMA sanctions designations, as of Oct 16, 2026.';
  const evidence = [{ id: 'E3', kind: 'sanctions', label: 'US OFAC and Canada SEMA designations', value: '1,396', factText: atom, asOf: '2026-10-16' }];
  const claim = (text, sources = [], evidence = []) => ({ text, sources, evidence });
  const render = (overrides, inputs = evidence) => renderEvidenceGroundedCountryBrief(JSON.stringify({
    situation: [claim(headline, [1])], implications: [], risks: [], outlook: [], watch: [], ...overrides,
  }), sources, inputs, 'China');

  for (const text of [
    "China's sanctions against Belize, linked to 1,396 US OFAC and Canada SEMA sanctions designations, may deepen its diplomatic isolation over Taiwan.",
    'Belize imposed sanctions on China, linked to 1,396 US OFAC and Canada SEMA sanctions designations.',
    'Belize supports Taiwan while China is linked to 1,396 US OFAC and Canada SEMA sanctions designations.',
  ]) {
    it(`withholds a mixed aggregate implication: ${text}`, () => {
      const result = render({ implications: [claim(text, [1], ['E3'])] });
      assert.deepEqual(result.sections.map(section => section.key), ['situation']);
      assert.equal(result.withheld, 1);
      assert.deepEqual(result.evidence, []);
    });
  }

  it('keeps the independently cited headline and exact aggregate fact', () => {
    const result = render({ risks: [claim(atom, [], ['E3'])] });
    assert.deepEqual(result.sections.map(section => section.key), ['situation', 'risks']);
    assert.equal(result.sections[1].claims[0].text, atom);
    assert.equal(result.withheld, 0);
    assert.deepEqual(result.evidence.map(item => item.id), ['E3']);
  });

  it('rejects section, evidence-number and companion-evidence bypasses', () => {
    const renumbered = [{ ...evidence[0], id: 'E7' }, { id: 'E2', kind: 'chokepoint', value: 'Taiwan', factText: 'China is linked to Taiwan.' }];
    for (const overrides of [
      { watch: [claim('China sanctions Belize.', [1], ['E7'])] },
      { risks: [claim('China sanctions Belize.', [1], ['E7', 'E2'])] },
      { risks: [claim(atom, [1], ['E7'])] },
      { risks: [claim(atom.replace('1,396', '1,397'), [], ['E7'])] },
      { risks: [claim(atom, [], ['E99'])] },
    ]) {
      const result = render(overrides, renumbered);
      assert.deepEqual(result.sections.map(section => section.key), ['situation']);
      assert.equal(result.withheld, 1);
    }
  });

  it('still refuses an assessment without a grounded Situation', () => {
    assert.equal(render({ situation: [], risks: [claim(atom, [], ['E3'])] }), null);
  });

  it('publishes independent facts accepted by the corpus after withholding the mixed claim', () => {
    const result = render({
      implications: [claim('China sanctions Belize.', [1], ['E3'])],
      risks: [claim(atom, [], ['E3'])],
    });
    assert.equal(result.withheld, 1);
    assert.equal(briefCitationGroundingGap({ ...result, sources }, { countryCode: 'CN', countryName: 'China' }), null);
  });
});

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

describe('airport evidence in the grounded country brief', () => {
  const sources = [{ title: 'Saudi Arabia shuts Jeddah airspace after drone attack', source: 'Reuters', url: 'https://example.com/a', publishedAt: '' }];
  const airport = {
    id: 'E1', kind: 'airport', label: 'NOTAM airport status', value: 'closed', asOf: '2026-10-24T18:30:00.000Z', url: '',
    factText: 'King Abdulaziz International (JED) in Saudi Arabia is closed under a NOTAM, as of Oct 24, 2026.',
  };
  const render = (risks) => renderEvidenceGroundedCountryBrief(JSON.stringify({
    situation: [{ text: 'Saudi Arabia shuts Jeddah airspace after drone attack', sources: [1], evidence: [] }],
    implications: [], risks, outlook: [], watch: [],
  }), sources, [airport], 'Saudi Arabia');

  it('publishes a risk that states the closure as cited', () => {
    const result = render([{ text: 'King Abdulaziz International (JED) in Saudi Arabia is closed under a NOTAM', sources: [], evidence: ['E1'] }]);
    assert.deepEqual(result.sections.map((section) => section.key), ['situation', 'risks']);
    assert.equal(result.withheld, 0);
  });

  it('withholds a closure claim that adds a number the data point does not state', () => {
    const result = render([{ text: 'King Abdulaziz International (JED) in Saudi Arabia is closed under a NOTAM for 48 hours', sources: [], evidence: ['E1'] }]);
    assert.equal(result.withheld, 1);
  });
});
