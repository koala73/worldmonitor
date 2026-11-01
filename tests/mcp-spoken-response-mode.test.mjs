// `response_mode: "spoken"` (#9722, voice and avatar consumers).
//
// A voice agent reads a tool answer aloud. The full payload is the wrong shape
// for that: it is large, numeric, and full of field names. The spoken mode
// returns 2-3 short plain-language sentences built deterministically from the
// tool's own structured data (no model call, so no invented numbers), plus a
// `citations` array the agent can show or log. Every number in the sentence
// is pinned here against the fixture it came from.
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  spokenChokepointStatus,
  spokenCountryRisk,
  spokenForecastPredictions,
  spokenMediaPerspective,
  spokenPredictionMarkets,
  spokenResilienceIndicators,
  spokenWorldBrief,
} from '../api/mcp/spoken-narrators.ts';
import { SPOKEN_MAX_CHARS, buildSpokenEnvelope } from '../api/mcp/spoken.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const VALID_KEY = 'wm_test_key_spoken';
const BASE_URL = 'https://worldmonitor.app/mcp';
const NOW = Date.now();
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const SPOKEN_TOOLS = [
  'get_country_risk', 'get_world_brief', 'get_chokepoint_status', 'get_forecast_predictions',
  'get_prediction_markets', 'get_media_perspective', 'get_resilience_indicators',
];

// ---------------------------------------------------------------------------
// Fixtures: one realistic payload per tool, in the shape the tool documents.
// ---------------------------------------------------------------------------
const COUNTRY_RISK = {
  countryCode: 'IQ', countryName: 'Iraq',
  cii: {
    region: 'IQ', combinedScore: 62.4, staticBaseline: 55, dynamicScore: 3.1, trend: 'TREND_DIRECTION_RISING',
    components: { ciiContribution: 40, geoConvergence: 71.5, militaryActivity: 55, newsActivity: 30 },
    computedAt: NOW - 20 * MIN, methodologyVersion: 'v14',
  },
  advisoryLevel: 'reconsider', sanctionsActive: true, sanctionsCount: 132,
  fetchedAt: NOW - 20 * MIN, upstreamUnavailable: false,
};

const WORLD_BRIEF = {
  brief: 'A **brief** with [1] markers and https://example.com/link.', summary: 'same',
  headlines: [
    'Iran and Israel exchange strikes as talks stall',
    'U.S. Senate passes stopgap funding bill',
    'Typhoon makes landfall in the Philippines',
  ],
  topStories: [], provider: 'p', model: 'm',
  generatedAt: iso(NOW - 25 * MIN), stale: false, ageMinutes: 25,
  sources: [
    { title: 'Iran and Israel exchange strikes', url: 'https://example.com/a', source: 'Reuters', publishedAt: iso(NOW - 40 * MIN) },
    { title: 'Senate passes stopgap', url: '', source: 'AP', publishedAt: iso(NOW - 50 * MIN) },
  ],
};

const CHOKEPOINTS = {
  cached_at: iso(NOW - 8 * MIN), stale: false,
  data: {
    'transit-summaries': {
      summaries: {
        hormuz_strait: { todayTotal: 41, todayTanker: 20, todayCargo: 15, todayOther: 6, wowChangePct: -12.4, riskLevel: 'critical', incidentCount7d: 627, disruptionPct: 100, riskSummary: '', riskReportAction: '', anomaly: {}, dataAvailable: true, todayCountsAvailable: true },
        suez: { todayTotal: 38, wowChangePct: 4.5, riskLevel: 'elevated', incidentCount7d: 28, disruptionPct: 20, riskSummary: '', riskReportAction: '', anomaly: {}, dataAvailable: true, todayCountsAvailable: true },
        malacca_strait: { todayTotal: 120, wowChangePct: 1.2, riskLevel: '', incidentCount7d: 0, disruptionPct: 0, riskSummary: '', riskReportAction: '', anomaly: {}, dataAvailable: true, todayCountsAvailable: true },
        bab_el_mandeb: { todayTotal: null, wowChangePct: null, riskLevel: 'high', incidentCount7d: 90, disruptionPct: 60, riskSummary: '', riskReportAction: '', anomaly: {}, dataAvailable: true, todayCountsAvailable: false },
      },
      fetchedAt: NOW - 8 * MIN,
    },
    chokepoint_transits: null,
    _countries: ['AE', 'SA'],
    'chokepoint-baselines': {
      source: 'EIA World Oil Transit Chokepoints', referenceYear: 2023, updatedAt: iso(NOW - 30 * 24 * 60 * MIN),
      chokepoints: [
        { id: 'hormuz', relayId: 'hormuz_strait', name: 'Strait of Hormuz' },
        { id: 'suez', relayId: 'suez', name: 'Suez Canal / SUMED' },
        { id: 'malacca', relayId: 'malacca_strait', name: 'Strait of Malacca' },
        { id: 'babelm', relayId: 'bab_el_mandeb', name: 'Bab el-Mandeb' },
      ],
    },
    ref: null,
    'chokepoint-flows': {
      hormuz_strait: { currentMbd: 2.6, baselineMbd: 21, flowRatio: 0.123, disrupted: true, source: 'portwatch-dwt', hazardAlertLevel: 'RED', hazardAlertName: 'HORMUZ-26' },
      suez: { currentMbd: 7.6, baselineMbd: 7.6, flowRatio: 1.001, disrupted: false, source: 'portwatch-dwt', hazardAlertLevel: null, hazardAlertName: null },
      malacca_strait: { currentMbd: 15.7, baselineMbd: 17.2, flowRatio: 0.911, disrupted: false, source: 'portwatch-dwt', hazardAlertLevel: null, hazardAlertName: null },
      bab_el_mandeb: { currentMbd: 5.7, baselineMbd: 6.2, flowRatio: 0.92, disrupted: false, source: 'portwatch-dwt', hazardAlertLevel: null, hazardAlertName: null },
    },
  },
};

function hormuzOnly(envelope) {
  const data = envelope.data;
  return {
    ...envelope,
    data: {
      ...data,
      'transit-summaries': { ...data['transit-summaries'], summaries: { hormuz_strait: data['transit-summaries'].summaries.hormuz_strait } },
      'chokepoint-flows': { hormuz_strait: data['chokepoint-flows'].hormuz_strait },
      'chokepoint-baselines': { ...data['chokepoint-baselines'], chokepoints: [data['chokepoint-baselines'].chokepoints[0]] },
    },
  };
}

const MARKETS_BOOTSTRAP = {
  geopolitical: [
    { title: 'Will Russia and Ukraine agree to a ceasefire by December 31?', yesPrice: 18, change24h: -3, source: 'polymarket', volume: 1_200_000, liquidity: 90_000, url: 'https://polymarket.com/event/ceasefire', endDate: '2026-12-31', regions: ['RU', 'UA'] },
    { title: 'Iran nuclear deal signed in 2026?', yesPrice: 41, change24h: 2.5, source: 'kalshi', volume: 300_000, url: 'https://kalshi.com/markets/iran', endDate: '2026-12-31', regions: ['IR'] },
  ],
  tech: [
    { title: 'OpenAI releases GPT-6 in 2026?', yesPrice: 70, source: 'polymarket', volume: 500_000, liquidity: 40_000, url: 'https://polymarket.com/event/gpt6', endDate: '2026-12-31', regions: [] },
  ],
  finance: [],
};
const PREDICTION_MARKETS = { cached_at: iso(NOW - 30 * MIN), stale: false, data: { 'markets-bootstrap': MARKETS_BOOTSTRAP } };

const FORECASTS = {
  cached_at: iso(NOW - 40 * MIN), stale: false,
  data: {
    predictions: {
      generatedAt: NOW - 40 * MIN,
      predictions: [
        { id: 'fc-conflict-1', domain: 'conflict', region: 'Gulf', probability: 0.55, title: 'Gulf tanker insurance premiums rise', change24h: null, change7d: null },
        { id: 'fc-market-1', domain: 'market', region: 'Red Sea', probability: 0.709, title: 'Energy repricing risk from Red Sea maritime disruption', change24h: 0.03, change7d: 0.1 },
      ],
    },
  },
};

const MEDIA = {
  subjectCountry: 'SA', windowHours: 72,
  groups: [
    {
      homeCountry: 'SA', audience: 'domestic', outletCount: 3, headlineCount: 12,
      framing: { favorable: 5, neutral: 4, critical: 1, hostile: 0, unlabeled: 2, method: 'llm-headline-stance', model: 'm', promptVersion: '1' },
      headlines: [
        { title: 'المملكة تكشف عن الميزانية', englishTitle: 'Kingdom unveils budget', titleLanguage: 'ar', outlet: 'Arab News', publisherFamily: 'arab-news', tier: 2, ownershipClass: 'private', propagandaRisk: 'low', framing: 'favorable', publishedAt: NOW - 60 * MIN, link: 'https://example.com/budget' },
      ],
    },
    {
      homeCountry: 'GB', audience: 'international', outletCount: 2, headlineCount: 6,
      framing: { favorable: 0, neutral: 3, critical: 3, hostile: 0, unlabeled: 0, method: 'llm-headline-stance', model: 'm', promptVersion: '1' },
      headlines: [
        { title: 'Saudi oil policy under scrutiny', englishTitle: 'Saudi oil policy under scrutiny', titleLanguage: 'en', outlet: 'Financial Times', publisherFamily: 'ft', tier: 1, ownershipClass: 'private', propagandaRisk: 'low', framing: 'critical', publishedAt: NOW - 3 * 60 * MIN, link: 'https://example.com/ft' },
      ],
    },
  ],
  noCoverageCountries: [], unattributedCount: 1, state: 'complete', feedTotal: 40, feedCached: 40, readAt: iso(NOW - 2 * MIN),
};

const RESILIENCE = {
  countryCode: 'DE', methodology: 'm', formula: 'd6', dataVersion: '2026-09-01', schemaVersion: '2',
  dimensions: [
    { id: 'energy', score: 58.2, coverage: 1, active: true, reconciliationAvailable: true },
    { id: 'macroFiscal', score: 81, coverage: 1, active: true, reconciliationAvailable: true },
    { id: 'cyberDigital', score: 44.9, coverage: 1, active: true, reconciliationAvailable: true },
    { id: 'socialCohesion', score: 77, coverage: 1, active: true, reconciliationAvailable: true },
    { id: 'tradePolicy', score: 0, coverage: 0, active: false, reconciliationAvailable: false, reason: 'retired' },
  ],
  indicators: [
    { id: 'power-losses', dimension: 'energy', state: 'observed', retrievedAt: iso(NOW - 10 * 24 * 60 * MIN), sources: [{ key: 'wb', name: 'World Bank WDI', url: 'https://data.worldbank.org/indicator/EG.ELC.LOSS.ZS' }] },
    { id: 'education-attainment', dimension: 'socialCohesion', state: 'imputed', retrievedAt: iso(NOW - 12 * 24 * 60 * MIN), sources: [{ key: 'wb', name: 'World Bank WDI', url: 'https://data.worldbank.org/indicator/SE.TER.CUAT.BA.ZS' }] },
    { id: 'fiscal-space', dimension: 'macroFiscal', state: 'observed', retrievedAt: iso(NOW - 9 * 24 * 60 * MIN), sources: [{ key: 'imf', name: 'IMF WEO', url: 'https://www.imf.org/weo' }] },
    { id: 'cyber-index', dimension: 'cyberDigital', state: 'observed', sources: [] },
    // Deliberate exclusions, not data gaps: they must not count as missing.
    { id: 'legacy-tariff-row', dimension: 'tradePolicy', state: 'retired', reason: 'retired', sources: [] },
    { id: 'island-only', dimension: 'logisticsSupply', state: 'not-applicable', sources: [] },
  ],
};

// ---------------------------------------------------------------------------
// Speech invariants every narration must satisfy.
// ---------------------------------------------------------------------------
function sentencesOf(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"])/).filter((s) => s.length > 0);
}

function assertSpeakable(envelope, label) {
  assert.equal(typeof envelope.spoken, 'string', `${label}: spoken is a string`);
  const text = envelope.spoken;
  const count = sentencesOf(text).length;
  assert.ok(count >= 2 && count <= 3, `${label}: expected 2-3 sentences, got ${count}: ${text}`);
  assert.ok(text.length <= SPOKEN_MAX_CHARS, `${label}: ${text.length} chars exceeds ${SPOKEN_MAX_CHARS}`);
  assert.doesNotMatch(text, /https?:\/\/|www\./, `${label}: no URLs in speech`);
  assert.doesNotMatch(text, /[*_`#|<>[\]{}()%]/, `${label}: no markdown, brackets, parentheses or percent signs in speech`);
  assert.doesNotMatch(text, /\b[A-Z]\.[A-Z]\b/, `${label}: no dotted abbreviations in speech`);
  assert.doesNotMatch(text, /\b(?:cii|combinedScore|yesPrice|change24h|wowChangePct|todayTotal|flowRatio|mbd|TREND_DIRECTION|[a-z]+[A-Z][a-zA-Z]+)\b/, `${label}: no field names or raw codes in speech`);
  assert.match(text, /[.!?]$/, `${label}: ends with terminal punctuation`);
  assert.ok(Array.isArray(envelope.citations) && envelope.citations.length > 0, `${label}: citations present`);
  for (const citation of envelope.citations) {
    assert.equal(typeof citation.source, 'string', `${label}: citation.source`);
    assert.ok(citation.source.length > 0, `${label}: citation.source non-empty`);
    assert.ok(citation.asOf === null || (typeof citation.asOf === 'string' && !Number.isNaN(Date.parse(citation.asOf))), `${label}: citation.asOf is ISO or null`);
    assert.equal(typeof citation.stale, 'boolean', `${label}: citation.stale`);
    if (citation.url !== undefined) assert.match(citation.url, /^https?:\/\//, `${label}: citation.url is http(s)`);
    if (citation.title !== undefined) assert.equal(typeof citation.title, 'string');
  }
  assert.equal(typeof envelope.stale, 'boolean', `${label}: stale`);
  assert.ok(envelope.asOf === null || typeof envelope.asOf === 'string', `${label}: asOf`);
}

function narrate(name, narrator, result, args = {}) {
  return buildSpokenEnvelope({ name, _spoken: narrator }, result, args, NOW);
}

describe('spoken narrators build 2-3 plain sentences from the structured payload', () => {
  it('get_country_risk reads the score, trend, top driver, advisory and sanctions', () => {
    const out = narrate('get_country_risk', spokenCountryRisk, COUNTRY_RISK, { country_code: 'IQ' });
    assertSpeakable(out, 'country risk');
    assert.equal(out.spoken,
      'Iraq scores 62 out of 100 on the instability index, and the trend is rising. '
      + 'The largest contribution comes from armed conflict, at 72. '
      + 'The travel advisory is reconsider travel, and 132 sanctioned entities are linked to the country.');
    assert.equal(out.stale, false);
    assert.equal(out.asOf, iso(COUNTRY_RISK.fetchedAt));
    assert.equal(out.citations[0].source, 'WorldMonitor Composite Instability Index (v14)');
    assert.equal(out.citations[0].asOf, iso(COUNTRY_RISK.fetchedAt));
  });

  it('get_country_risk says so when the upstream read failed instead of reading zeros as calm', () => {
    const out = narrate('get_country_risk', spokenCountryRisk, { ...COUNTRY_RISK, cii: null, advisoryLevel: '', sanctionsActive: false, sanctionsCount: 0, fetchedAt: 0, upstreamUnavailable: true });
    assertSpeakable(out, 'country risk unavailable');
    assert.equal(out.spoken, 'I could not get a risk reading for Iraq right now because a required data source did not respond. Please try again in a few minutes.');
    assert.equal(out.stale, true);
    assert.equal(out.asOf, null);
    assert.doesNotMatch(out.spoken, /\b0\b/);
  });

  it('get_country_risk flags an old reading honestly', () => {
    const old = NOW - 9 * 60 * MIN;
    const out = narrate('get_country_risk', spokenCountryRisk, { ...COUNTRY_RISK, fetchedAt: old, cii: { ...COUNTRY_RISK.cii, computedAt: old } });
    assertSpeakable(out, 'country risk stale');
    assert.match(out.spoken, /This reading is from about 9 hours ago and may be out of date\.$/);
    assert.equal(out.stale, true);
    assert.equal(out.citations[0].stale, true);
  });

  it('get_world_brief reads the top headlines with age, stripping markdown, links and dotted abbreviations', () => {
    const out = narrate('get_world_brief', spokenWorldBrief, WORLD_BRIEF);
    assertSpeakable(out, 'world brief');
    assert.equal(out.spoken,
      'The latest world brief was written about 25 minutes ago. '
      + 'The top story is Iran and Israel exchange strikes as talks stall, followed by US Senate passes stopgap funding bill. '
      + 'Also in the brief: Typhoon makes landfall in the Philippines.');
    assert.equal(out.asOf, WORLD_BRIEF.generatedAt);
    assert.deepEqual(out.citations, [
      { source: 'Reuters', title: 'Iran and Israel exchange strikes', url: 'https://example.com/a', asOf: WORLD_BRIEF.sources[0].publishedAt, stale: false },
      { source: 'AP', title: 'Senate passes stopgap', asOf: WORLD_BRIEF.sources[1].publishedAt, stale: false },
    ]);
  });

  it('get_world_brief says when the brief is stale', () => {
    const out = narrate('get_world_brief', spokenWorldBrief, { ...WORLD_BRIEF, stale: true, ageMinutes: 125, generatedAt: iso(NOW - 125 * MIN) });
    assertSpeakable(out, 'world brief stale');
    assert.match(out.spoken, /^The latest world brief was written about 2 hours ago and is older than usual, so treat it as the last known picture\. /);
    assert.equal(out.stale, true);
    assert.ok(out.citations.every((c) => c.stale === true));
  });

  it('get_chokepoint_status narrates one chokepoint when filtered', () => {
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, hormuzOnly(CHOKEPOINTS), { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint one');
    assert.equal(out.spoken,
      'Strait of Hormuz is at critical risk, with 627 incidents in the past 7 days. '
      + 'Oil flow is 2.6 million barrels a day against a normal 21, about 12 percent of normal, and it is flagged as disrupted. '
      + '41 vessels transited today, down 12 percent on last week.');
    assert.equal(out.asOf, CHOKEPOINTS.cached_at);
    assert.equal(out.citations[0].source, 'WorldMonitor chokepoint monitor (AIS relay and IMF PortWatch)');
    assert.equal(out.citations[1].source, 'EIA World Oil Transit Chokepoints');
  });

  it('get_chokepoint_status gives an overview across chokepoints', () => {
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, CHOKEPOINTS);
    assertSpeakable(out, 'chokepoint overview');
    assert.equal(out.spoken,
      'Of 4 monitored chokepoints, 1 is flagged as disrupted: Strait of Hormuz. '
      + 'The highest risk level is critical, at Strait of Hormuz, with 627 incidents in the past 7 days. '
      + 'Oil flow through Strait of Hormuz is 2.6 million barrels a day against a normal 21, about 12 percent of normal.');
  });

  it('get_chokepoint_status replaces the last sentence with the stale caveat', () => {
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, { ...hormuzOnly(CHOKEPOINTS), cached_at: iso(NOW - 2 * 60 * MIN), stale: true }, { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint stale');
    assert.match(out.spoken, /flagged as disrupted\. This snapshot was taken about 2 hours ago and is flagged as stale, so some figures may be out of date\.$/);
    assert.doesNotMatch(out.spoken, /transited today/);
    assert.equal(out.stale, true);
  });

  it('get_prediction_markets reads bucket counts and the leading markets with their moves', () => {
    const out = narrate('get_prediction_markets', spokenPredictionMarkets, PREDICTION_MARKETS);
    assertSpeakable(out, 'prediction markets');
    assert.equal(out.spoken,
      'Prediction markets as of about 30 minutes ago track 3 contracts: 2 geopolitical, 1 tech and none in finance. '
      + 'The leading geopolitical market, Will Russia and Ukraine agree to a ceasefire by December 31, is priced at 18 percent, down 3 points in the past day. '
      + 'The leading tech market, OpenAI releases GPT-6 in 2026, is priced at 70 percent.');
    assert.deepEqual(out.citations.map((c) => [c.source, c.url]), [
      ['Polymarket', 'https://polymarket.com/event/ceasefire'],
      ['Polymarket', 'https://polymarket.com/event/gpt6'],
    ]);
  });

  it('get_prediction_markets narrates the runner-up inside a single category and says when nothing matches', () => {
    const geo = { ...PREDICTION_MARKETS, data: { 'markets-bootstrap': { ...MARKETS_BOOTSTRAP, tech: [], finance: [] } } };
    const out = narrate('get_prediction_markets', spokenPredictionMarkets, geo, { category: 'geopolitical' });
    assertSpeakable(out, 'prediction markets one category');
    assert.match(out.spoken, /Next, Iran nuclear deal signed in 2026 is priced at 41 percent, up 3 points in the past day\.$/);
    const empty = narrate('get_prediction_markets', spokenPredictionMarkets, { ...PREDICTION_MARKETS, data: { 'markets-bootstrap': { geopolitical: [], tech: [], finance: [] } } }, { query: 'zzz' });
    assertSpeakable(empty, 'prediction markets empty');
    assert.equal(empty.spoken, 'No prediction markets match those filters as of about 30 minutes ago. Try a broader query or another category.');
  });

  it('get_forecast_predictions reads the highest-probability forecasts as percentages', () => {
    const out = narrate('get_forecast_predictions', spokenForecastPredictions, FORECASTS);
    assertSpeakable(out, 'forecasts');
    assert.equal(out.spoken,
      'WorldMonitor currently publishes 2 forecasts, generated about 40 minutes ago; these are AI assessments, not guarantees. '
      + 'The highest probability is 71 percent for Energy repricing risk from Red Sea maritime disruption, a market forecast for Red Sea, up 3 points in the past day. '
      + 'Next is 55 percent for Gulf tanker insurance premiums rise, a conflict forecast for Gulf.');
    assert.equal(out.asOf, iso(FORECASTS.data.predictions.generatedAt));
    assert.equal(out.citations[0].title, 'Energy repricing risk from Red Sea maritime disruption');
  });

  it('get_media_perspective counts coverage by origin and stance and names the latest headline', () => {
    const out = narrate('get_media_perspective', spokenMediaPerspective, MEDIA, { subject_country: 'SA' });
    assertSpeakable(out, 'media perspective');
    assert.equal(out.spoken,
      'Over the past 72 hours, 18 headlines from 5 outlets covered Saudi Arabia: 12 from its own press, none from its foreign-facing media and 6 from outside coverage. '
      + 'Of the 16 headlines a model labelled for stance, 5 read as favorable, 7 neutral and 4 critical or hostile. '
      + 'The most recent is from Arab News: Kingdom unveils budget.');
    assert.equal(out.citations[0].source, 'Arab News');
    assert.equal(out.citations[0].url, 'https://example.com/budget');
    assert.equal(out.citations[0].asOf, iso(MEDIA.groups[0].headlines[0].publishedAt));
  });

  it('get_media_perspective flags a partial read and an unavailable one', () => {
    const partial = narrate('get_media_perspective', spokenMediaPerspective, { ...MEDIA, state: 'partial' }, { subject_country: 'SA' });
    assertSpeakable(partial, 'media partial');
    assert.match(partial.spoken, /critical or hostile\. Some feeds were unavailable, so this is a partial view\.$/);
    const unlabelled = narrate('get_media_perspective', spokenMediaPerspective, { ...MEDIA, groups: MEDIA.groups.map((g) => ({ ...g, framing: { favorable: 0, neutral: 0, critical: 0, hostile: 0, unlabeled: g.headlineCount } })) }, { subject_country: 'SA' });
    assert.match(unlabelled.spoken, /No model stance labels are available for these headlines yet\./);
    assert.equal(partial.stale, true);
    const down = narrate('get_media_perspective', spokenMediaPerspective, { ...MEDIA, groups: [], state: 'unavailable' }, { subject_country: 'SA' });
    assertSpeakable(down, 'media unavailable');
    assert.equal(down.spoken, 'Media coverage for Saudi Arabia is unavailable right now. Please try again later.');
  });

  it('get_resilience_indicators names failed sources and missing rows separately from imputed ones', () => {
    const indicators = [
      { id: 'a', state: 'observed', sources: [] }, { id: 'b', state: 'source-failure', sources: [] },
      { id: 'c', state: 'missing', sources: [] }, { id: 'd', state: 'fallback', sources: [] }, { id: 'e', state: 'inactive', sources: [] },
    ];
    const out = narrate('get_resilience_indicators', spokenResilienceIndicators, { ...RESILIENCE, indicators }, { country_code: 'DE' });
    assertSpeakable(out, 'resilience states');
    assert.match(out.spoken, /1 of 4 active indicators are directly observed, with 1 imputed, 1 from a failed source and 1 missing\.$/);
  });

  it('get_chokepoint_status does not read an absent flow map as nothing disrupted', () => {
    const noFlows = { ...CHOKEPOINTS, data: { ...CHOKEPOINTS.data, 'chokepoint-flows': null } };
    const overview = narrate('get_chokepoint_status', spokenChokepointStatus, noFlows, { dataset: ['transit-summaries'] });
    assertSpeakable(overview, 'chokepoint overview without flows');
    assert.match(overview.spoken, /^4 monitored chokepoints are in this snapshot, but disruption status was not included\. /);
    assert.doesNotMatch(overview.spoken, /None of the|flagged as disrupted/);
    const single = narrate('get_chokepoint_status', spokenChokepointStatus, { ...hormuzOnly(CHOKEPOINTS), data: { ...hormuzOnly(CHOKEPOINTS).data, 'chokepoint-flows': null } }, { chokepoint: 'hormuz' });
    assertSpeakable(single, 'single chokepoint without flows');
    assert.match(single.spoken, /Oil flow and disruption status were not included in this snapshot\./);
  });

  it('every narration stays within the 500-character bound on long inputs, keeping whole sentences and the caveat', () => {
    const longTitle = (n) => `Forecast number ${n} about a very long chain of maritime, energy and insurance consequences across several regions and many months`;
    const long = {
      ...FORECASTS, stale: true, cached_at: iso(NOW - 3 * 60 * MIN),
      data: { predictions: { generatedAt: NOW - 3 * 60 * MIN, predictions: [
        { id: 'a', domain: 'supply_chain', region: 'Eastern Mediterranean and the Red Sea approaches', probability: 0.81, title: longTitle(1), change24h: 0.02 },
        { id: 'b', domain: 'infrastructure', region: 'Gulf of Aden and the Bab el-Mandeb corridor', probability: 0.64, title: longTitle(2), change24h: -0.04 },
      ] } },
    };
    const out = narrate('get_forecast_predictions', spokenForecastPredictions, long);
    assertSpeakable(out, 'long forecasts');
    assert.match(out.spoken, /flagged as stale, so some figures may be out of date\.$/, 'the caveat survives the cut');
    const many = { ...CHOKEPOINTS, data: { ...CHOKEPOINTS.data, 'chokepoint-flows': Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`very_long_chokepoint_name_number_${i}_on_a_distant_coast`, { currentMbd: 1 + i, baselineMbd: 10, flowRatio: 0.5, disrupted: true, source: 'portwatch-dwt' }])) } };
    const crowded = narrate('get_chokepoint_status', spokenChokepointStatus, many);
    assertSpeakable(crowded, 'many disrupted chokepoints');
  });

  it('get_resilience_indicators names the strongest and weakest dimensions in plain words', () => {
    const out = narrate('get_resilience_indicators', spokenResilienceIndicators, RESILIENCE, { country_code: 'DE' });
    assertSpeakable(out, 'resilience');
    assert.equal(out.spoken,
      "Germany's resilience breakdown covers 4 dimensions, using data from September 2026. "
      + 'Its strongest areas are public finances at 81 and social cohesion at 77, and its weakest are cyber and digital at 45 and energy at 58. '
      + '3 of 4 active indicators are directly observed, with 1 imputed.');
    assert.deepEqual(out.citations.map((c) => c.source), ['WorldMonitor resilience score', 'World Bank WDI', 'IMF WEO']);
    assert.equal(out.citations[1].url, 'https://data.worldbank.org/indicator/EG.ELC.LOSS.ZS');
  });
});

// ---------------------------------------------------------------------------
// Dispatch: the mode is advertised, validated, and shaped like every other
// non-documented response so a strict client accepts it.
// ---------------------------------------------------------------------------
describe('tools/call response_mode: "spoken" through the MCP handler', () => {
  let mod;
  let handler;
  let registry;
  let publicTools;
  const restore = [];
  const redisKeys = new Map();

  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
  function strictClientVerdict(publicTool, result) {
    const sc = result.structuredContent;
    if (sc === undefined || sc === null) return 'missing structuredContent';
    const validate = ajv.compile(publicTool.outputSchema);
    if (validate(sc)) return null;
    return (validate.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  }

  function stub(name, fn) {
    const tool = registry.find((t) => t.name === name);
    const before = tool._execute;
    tool._execute = fn;
    restore.push(() => { tool._execute = before; });
  }

  async function call(name, args, id = 7) {
    const res = await handler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    }));
    return { status: res.status, body: await res.json() };
  }

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
    process.env.MCP_TELEMETRY = 'false';
    redisKeys.clear();
    globalThis.fetch = async (url) => {
      const u = url.toString();
      for (const [key, value] of redisKeys) {
        if (u.includes(`/get/${encodeURIComponent(key)}`)) {
          return new Response(JSON.stringify({ result: value === null ? null : JSON.stringify(value) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      if (u.startsWith('https://fake.upstash.io')) {
        return new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    };
    mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    handler = mod.default;
    registry = mod.__testing__.TOOL_REGISTRY;
    const listed = await handler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    publicTools = new Map((await listed.json()).result.tools.map((t) => [t.name, t]));
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it('advertises response_mode and the spoken outputSchema branch only on tools with a narrator', () => {
    for (const tool of registry) {
      const pub = publicTools.get(tool.name);
      const expected = SPOKEN_TOOLS.includes(tool.name);
      assert.equal(tool._spoken !== undefined, expected, `${tool.name}: narrator roster`);
      assert.equal('response_mode' in pub.inputSchema.properties, expected, `${tool.name}: response_mode advertised`);
      const hasBranch = pub.outputSchema.anyOf.some((b) => Array.isArray(b.required) && b.required.includes('spoken'));
      assert.equal(hasBranch, expected, `${tool.name}: spoken branch in outputSchema`);
      if (expected) {
        assert.deepEqual(pub.inputSchema.properties.response_mode.enum, ['full', 'spoken']);
        assert.match(pub.inputSchema.properties.response_mode.description, /text-to-speech/);
      }
    }
  });

  it('rejects an unknown mode with a clear validation error', async () => {
    stub('get_country_risk', async () => COUNTRY_RISK);
    const { status, body } = await call('get_country_risk', { country_code: 'IQ', response_mode: 'haiku' });
    assert.equal(status, 200);
    assert.equal(body.error.code, -32602);
    const violation = body.error.data.violations.find((v) => v.field === 'response_mode');
    assert.ok(violation, JSON.stringify(body.error));
    assert.match(violation.description, /full, spoken/);
  });

  it('rejects response_mode on a tool that has no spoken narrator', async () => {
    stub('get_sources', async () => ({ view: 'summary', summary: { providerCount: 1 }, providers: [] }));
    const { body } = await call('get_sources', { response_mode: 'spoken' });
    assert.equal(body.error?.code, -32602, JSON.stringify(body));
    const violation = body.error.data.violations.find((v) => v.field === 'response_mode');
    assert.match(violation.description, /no spoken mode/i);
  });

  it('rejects summary together with spoken, since the sentences need the full lists', async () => {
    redisKeys.set('prediction:markets-bootstrap:v1', MARKETS_BOOTSTRAP);
    redisKeys.set('seed-meta:prediction:markets', { fetchedAt: NOW - 30 * MIN, recordCount: 3 });
    const { body } = await call('get_prediction_markets', { summary: true, response_mode: 'spoken' });
    assert.equal(body.error?.code, -32602, JSON.stringify(body));
    const violation = body.error.data.violations.find((v) => v.field === 'summary');
    assert.match(violation.description, /spoken/);
  });

  it('response_mode: "full" is the documented payload, byte-identical to omitting the argument', async () => {
    stub('get_country_risk', async () => COUNTRY_RISK);
    const plain = await call('get_country_risk', { country_code: 'IQ' });
    const full = await call('get_country_risk', { country_code: 'IQ', response_mode: 'full' });
    assert.equal(full.body.result.content[0].text, plain.body.result.content[0].text);
    assert.deepEqual(full.body.result.structuredContent, plain.body.result.structuredContent);
  });

  it('a spoken call returns the envelope in text and structuredContent, and a strict client accepts it', async () => {
    stub('get_country_risk', async (params) => {
      assert.equal(params.response_mode, undefined, 'the mode is not forwarded to the tool');
      return COUNTRY_RISK;
    });
    const { body } = await call('get_country_risk', { country_code: 'IQ', response_mode: 'spoken' });
    assert.equal(body.error, undefined, JSON.stringify(body.error ?? {}));
    const result = body.result;
    const text = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, text);
    assert.equal(text.tool, 'get_country_risk');
    assert.match(text.spoken, /^Iraq scores 62 out of 100/);
    assert.equal(text.cii, undefined, 'the full payload is omitted, as documented');
    assertSpeakable(text, 'dispatch country risk');
    assert.equal(strictClientVerdict(publicTools.get('get_country_risk'), result), null);
    assert.ok(result.content[0].text.length < 2048, 'a spoken answer stays small');
  });

  it('jmespath projects the spoken envelope, so a voice agent can take only the sentence', async () => {
    stub('get_country_risk', async () => COUNTRY_RISK);
    const { body } = await call('get_country_risk', { country_code: 'IQ', response_mode: 'spoken', jmespath: 'spoken' });
    assert.equal(body.error, undefined, JSON.stringify(body.error ?? {}));
    const sentence = JSON.parse(body.result.content[0].text);
    assert.match(sentence, /^Iraq scores 62 out of 100/);
    assert.deepEqual(body.result.structuredContent, { projection: sentence });
    assert.equal(strictClientVerdict(publicTools.get('get_country_risk'), body.result), null);
  });

  it('a cache tool narrates from its freshness envelope and says when the seed is stale', async () => {
    redisKeys.set('prediction:markets-bootstrap:v1', MARKETS_BOOTSTRAP);
    redisKeys.set('seed-meta:prediction:markets', { fetchedAt: NOW - 30 * MIN, recordCount: 3 });
    const fresh = await call('get_prediction_markets', { category: 'geopolitical', response_mode: 'spoken' });
    assert.equal(fresh.body.error, undefined, JSON.stringify(fresh.body.error ?? {}));
    const text = JSON.parse(fresh.body.result.content[0].text);
    assertSpeakable(text, 'dispatch prediction markets');
    assert.match(text.spoken, /^Prediction markets as of about 30 minutes ago track 2 contracts: 2 geopolitical, none in tech and none in finance\. /);
    assert.equal(text.stale, false);
    assert.equal(strictClientVerdict(publicTools.get('get_prediction_markets'), fresh.body.result), null);

    redisKeys.set('seed-meta:prediction:markets', { fetchedAt: NOW - 4 * 60 * MIN, recordCount: 3 });
    const stale = await call('get_prediction_markets', { category: 'geopolitical', response_mode: 'spoken' });
    const staleText = JSON.parse(stale.body.result.content[0].text);
    assertSpeakable(staleText, 'dispatch prediction markets stale');
    assert.equal(staleText.stale, true);
    assert.match(staleText.spoken, /This snapshot was taken about 4 hours ago and is flagged as stale, so some figures may be out of date\.$/);
    assert.ok(staleText.citations.every((c) => c.stale === true));
  });

  it('every spoken tool narrates its fixture through dispatch within the speech invariants', async () => {
    const fixtures = {
      get_country_risk: [COUNTRY_RISK, { country_code: 'IQ' }],
      get_world_brief: [WORLD_BRIEF, {}],
      get_media_perspective: [MEDIA, { subject_country: 'SA' }],
      get_resilience_indicators: [RESILIENCE, { country_code: 'DE' }],
    };
    for (const [name, [payload, args]] of Object.entries(fixtures)) {
      stub(name, async () => payload);
      const { body } = await call(name, { ...args, response_mode: 'spoken' });
      assert.equal(body.error, undefined, `${name}: ${JSON.stringify(body.error ?? {})}`);
      const text = JSON.parse(body.result.content[0].text);
      assertSpeakable(text, `dispatch ${name}`);
      assert.equal(text.tool, name);
      assert.equal(strictClientVerdict(publicTools.get(name), body.result), null, name);
    }
  });
});
