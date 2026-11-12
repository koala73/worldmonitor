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
  CHOKEPOINT_NAMES_AR,
  spokenChokepointStatus,
  spokenCountryRisk,
  spokenForecastPredictions,
  spokenMediaPerspective,
  spokenPredictionMarkets,
  spokenResilienceIndicators,
  spokenWorldBrief,
} from '../api/mcp/spoken-narrators.ts';
import {
  SPOKEN_MAX_CHARS,
  arabicCount,
  buildSpokenEnvelope,
  cleanSpeech,
  joinList,
  recordStaleFreshnessKeys,
  spokenAgo,
  spokenPoints,
} from '../api/mcp/spoken.ts';
import { CHOKEPOINT_REGISTRY } from '../server/_shared/chokepoint-registry.ts';

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

function narrate(name, narrator, result, args = {}, lang = 'en') {
  return buildSpokenEnvelope({ name, _spoken: narrator }, result, args, NOW, lang);
}

// Arabic answers (`spoken_language: "ar"`, #9722). The sentence splitter above
// keys on Latin capitals, so Arabic text gets its own invariants.
const ARABIC = /\p{Script=Arabic}/u;
const numbersIn = (text) => new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);

// `titles` are data quoted in their source language (headlines, market and
// forecast titles); they are removed before the template-word check.
function assertSpeakableArabic(envelope, english, label, titles = []) {
  const text = envelope.spoken;
  const template = titles.reduce((rest, title) => rest.split(title).join(' '), text);
  assert.equal(envelope.language, 'ar', `${label}: language`);
  assert.match(text, ARABIC, `${label}: Arabic script`);
  const count = text.split(/(?<=\.)\s+/).filter((s) => s.length > 0).length;
  assert.ok(count >= 2 && count <= 3, `${label}: expected 2-3 sentences, got ${count}: ${text}`);
  assert.ok(text.length <= SPOKEN_MAX_CHARS, `${label}: ${text.length} chars exceeds ${SPOKEN_MAX_CHARS}`);
  assert.doesNotMatch(text, /https?:\/\/|www\./, `${label}: no URLs in speech`);
  assert.doesNotMatch(text, /[*_`#|<>[\]{}()%٪]/, `${label}: no markdown, brackets, parentheses or percent signs in speech`);
  assert.doesNotMatch(template, /\b(?:percent|points?|ago|the|and|is|of|for|in)\b/i, `${label}: no English template words`);
  assert.match(text, /\.$/, `${label}: ends with a full stop`);
  // The same data path: every number the Arabic answer speaks, the English
  // answer speaks too (the English one may also say "7 days" where Arabic
  // says "السبعة").
  for (const number of numbersIn(text)) {
    assert.ok(numbersIn(english.spoken).has(number), `${label}: ${number} is not in the English answer: ${english.spoken}`);
  }
  // Citations are data, not wording: identical in both languages.
  assert.deepEqual(envelope.citations, english.citations, `${label}: citations`);
  assert.equal(envelope.stale, english.stale, `${label}: stale`);
  assert.equal(envelope.asOf, english.asOf, `${label}: asOf`);
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

  it('get_chokepoint_status replaces the last sentence with a caveat naming the stale transit data and its age', () => {
    const stalled = hormuzOnly(CHOKEPOINTS);
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, {
      ...stalled, cached_at: iso(NOW - 2 * 60 * MIN), stale: true,
      data: { ...stalled.data, 'transit-summaries': { ...stalled.data['transit-summaries'], fetchedAt: NOW - 2 * 60 * MIN } },
    }, { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint stale');
    assert.match(out.spoken, /flagged as disrupted\. The vessel counts and risk ratings were last updated about 2 hours ago and are flagged as stale, so they may be out of date\.$/);
    assert.doesNotMatch(out.spoken, /transited today/);
    assert.equal(out.stale, true);
    assert.equal(out.asOf, iso(NOW - 2 * 60 * MIN));
  });

  // Production 2026-11-01: the bundle's `cached_at` is its OLDEST seed-meta,
  // which is the annual EIA baselines table (~400-day budget), and `stale` was
  // tripped by the port-activity index. Neither is narrated, yet the caveat
  // said the live Hormuz reading was "taken about 210 days ago".
  const PROD_SHAPED_HORMUZ = {
    cached_at: iso(NOW - 210 * 24 * 60 * MIN), stale: true,
    data: {
      'transit-summaries': {
        summaries: { hormuz_strait: { todayTotal: null, todayTanker: null, todayCargo: null, todayOther: null, wowChangePct: -72.5, riskLevel: 'critical', incidentCount7d: 627, disruptionPct: 100, riskSummary: '', riskReportAction: '', anomaly: {}, dataAvailable: true, todayCountsAvailable: false } },
        fetchedAt: NOW - 3 * MIN,
      },
      chokepoint_transits: { transits: { 'Strait of Hormuz': { tanker: 0, cargo: 0, other: 0, total: 0, available: false } }, fetchedAt: NOW - 3 * MIN },
      _countries: ['AE', 'SA'],
      'chokepoint-baselines': { ...CHOKEPOINTS.data['chokepoint-baselines'], updatedAt: iso(NOW - 210 * 24 * 60 * MIN), chokepoints: [CHOKEPOINTS.data['chokepoint-baselines'].chokepoints[0]] },
      ref: null,
      'chokepoint-flows': { hormuz_strait: CHOKEPOINTS.data['chokepoint-flows'].hormuz_strait },
    },
  };

  it('get_chokepoint_status never dates live transit data from a static reference key', () => {
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, PROD_SHAPED_HORMUZ, { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint prod-shaped');
    assert.doesNotMatch(out.spoken, /days ago|snapshot was taken/);
    assert.equal(out.asOf, iso(NOW - 3 * MIN), 'asOf is the narrated transit data');
    // Without per-key verdicts the narrator cannot say which part is stale,
    // so it says that much and no age.
    assert.match(out.spoken, /^Strait of Hormuz is at critical risk, with 627 incidents in the past 7 days\. /);
    assert.match(out.spoken, / Some supporting data in this snapshot is flagged as stale, so the oil flow figure may be out of date\.$/);
  });

  it('get_chokepoint_status speaks no caveat when only an unnarrated dataset is stale', () => {
    const result = structuredClone(PROD_SHAPED_HORMUZ);
    recordStaleFreshnessKeys(result, ['seed-meta:supply_chain:portwatch-ports']);
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, result, { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint unnarrated stale');
    assert.equal(out.spoken,
      'Strait of Hormuz is at critical risk, with 627 incidents in the past 7 days. '
      + 'Oil flow is 2.6 million barrels a day against a normal 21, about 12 percent of normal, and it is flagged as disrupted. '
      + "Today's transit count is not available yet.");
    assert.equal(out.stale, false);
    assert.ok(out.citations.every((c) => c.stale === false));
  });

  it('get_chokepoint_status names stale oil flows when the flow key is the stale one', () => {
    const result = structuredClone(PROD_SHAPED_HORMUZ);
    recordStaleFreshnessKeys(result, ['seed-meta:energy:chokepoint-flows']);
    const out = narrate('get_chokepoint_status', spokenChokepointStatus, result, { chokepoint: 'hormuz' });
    assertSpeakable(out, 'chokepoint flows stale');
    assert.match(out.spoken, /flagged as disrupted\. The oil flow figures are flagged as stale, so they may be out of date\.$/);
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

  it('get_forecast_predictions does not caveat fresh forecasts because the probability trail is stale', () => {
    // cached_at is the oldest seed-meta, here the unnarrated probability trail.
    const trailStale = { ...FORECASTS, cached_at: iso(NOW - 5 * 60 * MIN), stale: true };
    const fallback = narrate('get_forecast_predictions', spokenForecastPredictions, trailStale);
    assertSpeakable(fallback, 'forecasts trail stale, unattributed');
    assert.doesNotMatch(fallback.spoken, /stale|5 hours/);
    assert.equal(fallback.stale, false);
    const attributed = structuredClone(trailStale);
    recordStaleFreshnessKeys(attributed, ['seed-meta:forecast:probability-trail']);
    const out = narrate('get_forecast_predictions', spokenForecastPredictions, attributed);
    assert.equal(out.spoken, fallback.spoken);
    assert.equal(out.stale, false);
    // change24h is derived from the trail, so a stale trail drops the move
    // instead of speaking it unqualified.
    assert.doesNotMatch(out.spoken, /in the past day/);
    assert.doesNotMatch(fallback.spoken, /in the past day/);
    const trailFresh = structuredClone(trailStale);
    recordStaleFreshnessKeys(trailFresh, ['seed-meta:some-other-check']);
    assert.match(narrate('get_forecast_predictions', spokenForecastPredictions, trailFresh).spoken, /up 3 points in the past day/);
  });

  it('get_forecast_predictions caveats stale forecasts without repeating a wrong age', () => {
    const old = { ...FORECASTS, cached_at: iso(NOW - 3 * 60 * MIN), stale: true, data: { predictions: { ...FORECASTS.data.predictions, generatedAt: NOW - 3 * 60 * MIN } } };
    const out = narrate('get_forecast_predictions', spokenForecastPredictions, old);
    assertSpeakable(out, 'forecasts stale');
    assert.match(out.spoken, /^WorldMonitor currently publishes 2 forecasts, generated about 3 hours ago; /);
    assert.match(out.spoken, / These forecasts are older than their usual refresh, so treat them as the last known picture\.$/);
    assert.equal(out.stale, true);
    const flagged = structuredClone(FORECASTS);
    recordStaleFreshnessKeys(flagged, ['seed-meta:forecast:predictions']);
    assert.equal(narrate('get_forecast_predictions', spokenForecastPredictions, flagged).stale, true);
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
    assert.match(out.spoken, /so treat them as the last known picture\.$/, 'the caveat survives the cut');
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
describe('spoken_language "ar": the same narration in Modern Standard Arabic (#9722)', () => {
  const NARRATIONS = [
    ['get_country_risk', spokenCountryRisk, COUNTRY_RISK, {}],
    ['get_country_risk stale', spokenCountryRisk, { ...COUNTRY_RISK, fetchedAt: NOW - 9 * 60 * MIN }, {}],
    ['get_country_risk unavailable', spokenCountryRisk, { ...COUNTRY_RISK, upstreamUnavailable: true }, {}],
    ['get_world_brief', spokenWorldBrief, WORLD_BRIEF, {}, WORLD_BRIEF.headlines.map((h) => h.replace('U.S.', 'US'))],
    ['get_world_brief stale', spokenWorldBrief, { ...WORLD_BRIEF, stale: true, ageMinutes: 300 }, {}, WORLD_BRIEF.headlines.map((h) => h.replace('U.S.', 'US'))],
    ['get_chokepoint_status one', spokenChokepointStatus, hormuzOnly(CHOKEPOINTS), {}],
    ['get_chokepoint_status all', spokenChokepointStatus, CHOKEPOINTS, {}],
    ['get_chokepoint_status empty', spokenChokepointStatus, { ...CHOKEPOINTS, data: {} }, {}],
    ['get_prediction_markets', spokenPredictionMarkets, PREDICTION_MARKETS, {}, [...MARKETS_BOOTSTRAP.geopolitical, ...MARKETS_BOOTSTRAP.tech].map((m) => m.title.replace(/\?$/, ''))],
    ['get_prediction_markets stale', spokenPredictionMarkets, { ...PREDICTION_MARKETS, stale: true }, {}, MARKETS_BOOTSTRAP.geopolitical.map((m) => m.title.replace(/\?$/, ''))],
    ['get_forecast_predictions', spokenForecastPredictions, FORECASTS, {}, ['Energy repricing risk from Red Sea maritime disruption', 'Gulf tanker insurance premiums rise', 'Red Sea', 'Gulf']],
    ['get_media_perspective', spokenMediaPerspective, MEDIA, {}, ['Arab News']],
    ['get_media_perspective partial', spokenMediaPerspective, { ...MEDIA, state: 'partial' }, {}, ['Arab News']],
    ['get_resilience_indicators', spokenResilienceIndicators, RESILIENCE, {}],
  ];

  for (const [label, narrator, payload, args, titles = []] of NARRATIONS) {
    it(`${label}: speakable Arabic with the English answer's numbers, citations and freshness`, () => {
      const name = label.split(' ')[0];
      const english = narrate(name, narrator, payload, args);
      const arabic = narrate(name, narrator, payload, args, 'ar');
      assert.equal(english.language, 'en');
      assertSpeakableArabic(arabic, english, label, titles);
    });
  }

  it('get_country_risk reads the score, trend, driver, advisory and sanctions in Arabic', () => {
    assert.equal(
      narrate('get_country_risk', spokenCountryRisk, COUNTRY_RISK, {}, 'ar').spoken,
      'درجة العراق على مؤشر عدم الاستقرار 62 من 100، والاتجاه تصاعدي. أكبر مساهمة تأتي من النزاع المسلح، بدرجة 72. '
        + 'تحذير السفر الحالي يدعو إلى إعادة النظر في السفر، وعدد الكيانات الخاضعة للعقوبات والمرتبطة بالبلد 132.',
    );
  });

  it('get_chokepoint_status names the chokepoint in Arabic and keeps the flow figures', () => {
    assert.equal(
      narrate('get_chokepoint_status', spokenChokepointStatus, hormuzOnly(CHOKEPOINTS), {}, 'ar').spoken,
      'مستوى المخاطر في مضيق هرمز حرج، وعدد الحوادث خلال الأيام السبعة الماضية 627. '
        + 'تدفق النفط 2.6 مليون برميل يوميًا مقابل 21 في الوضع الطبيعي، أي نحو 12 في المئة من المعتاد، وهو مصنف على أنه متعطل. '
        + 'عدد السفن التي عبرت اليوم 41، بانخفاض 12 في المئة عن الأسبوع الماضي.',
    );
  });

  it('get_media_perspective reads an Arabic-language headline as published and an English one as written', () => {
    const arabic = narrate('get_media_perspective', spokenMediaPerspective, MEDIA, {}, 'ar');
    assert.match(arabic.spoken, /^خلال آخر 72 ساعة، بلغ عدد العناوين التي تناولت المملكة العربية السعودية 18،/);
    assert.match(arabic.spoken, /أحدثها من Arab News: المملكة تكشف عن الميزانية\.$/);
    // English keeps the English rendering of the same headline.
    assert.match(narrate('get_media_perspective', spokenMediaPerspective, MEDIA).spoken, /Arab News: Kingdom unveils budget\.$/);
  });

  it('an Arabic headline with a percent sign reads "في المئة" in Arabic, while its citation keeps the English rendering', () => {
    for (const sign of ['%', '٪']) {
      const media = structuredClone(MEDIA);
      Object.assign(media.groups[0].headlines[0], { title: `التضخم يرتفع إلى 3${sign}`, englishTitle: 'Inflation rises to 3%' });
      const arabic = narrate('get_media_perspective', spokenMediaPerspective, media, {}, 'ar');
      assert.match(arabic.spoken, /أحدثها من Arab News: التضخم يرتفع إلى 3 في المئة\.$/, sign);
      assert.equal(arabic.citations[0].title, 'Inflation rises to 3 percent', sign);
    }
    // The English answer reads either sign as "percent".
    assert.equal(cleanSpeech('up 3٪'), 'up 3 percent.');
  });

  it('get_resilience_indicators names dimensions and the data month in Arabic', () => {
    assert.equal(
      narrate('get_resilience_indicators', spokenResilienceIndicators, RESILIENCE, { country_code: 'DE' }, 'ar').spoken,
      'يغطي تفصيل مؤشر الصمود عن ألمانيا أبعادًا عددها 4، استنادًا إلى بيانات سبتمبر 2026. '
        + 'أقوى المجالات المالية العامة بدرجة 81 والتماسك الاجتماعي بدرجة 77، وأضعفها الأمن السيبراني والرقمي بدرجة 45 والطاقة بدرجة 58. '
        + 'عدد المؤشرات النشطة المرصودة مباشرة 3 من أصل 4، والباقي: 1 مقدّرة إحصائيًا.',
    );
  });

  it('a stale caveat displaces the third sentence in Arabic too', () => {
    const stale = narrate('get_prediction_markets', spokenPredictionMarkets, { ...PREDICTION_MARKETS, stale: true }, {}, 'ar');
    assert.match(stale.spoken, / أُخذت هذه اللقطة قبل نحو 30 دقيقة وهي مصنفة على أنها قديمة، لذا قد لا تكون بعض الأرقام محدّثة\.$/);
    assert.equal(stale.stale, true);
  });

  it('every chokepoint in the registry has an Arabic name', () => {
    for (const point of CHOKEPOINT_REGISTRY) {
      assert.match(CHOKEPOINT_NAMES_AR[point.id] ?? '', ARABIC, `${point.id} needs an Arabic name in CHOKEPOINT_NAMES_AR`);
    }
  });

  it('arabicCount picks the noun form by CLDR plural category', () => {
    const hours = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
    assert.equal(arabicCount(1, hours), 'ساعة');
    assert.equal(arabicCount(2, hours), 'ساعتين');
    assert.equal(arabicCount(3, hours), '3 ساعات');
    assert.equal(arabicCount(10, hours), '10 ساعات');
    assert.equal(arabicCount(11, hours), '11 ساعة');
    assert.equal(arabicCount(99, hours), '99 ساعة');
    assert.equal(arabicCount(0, hours), '0 ساعات');
    const days = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم' };
    assert.equal(arabicCount(15, days), '15 يومًا');
    assert.equal(arabicCount(100, days), '100 يوم');
    assert.equal(arabicCount(103, days), '103 أيام');
  });

  it('ages, moves, lists and punctuation read in Arabic', () => {
    assert.equal(spokenAgo(NOW - MIN, NOW, 'ar'), 'قبل لحظات');
    assert.equal(spokenAgo(NOW - 2 * MIN, NOW, 'ar'), 'قبل نحو دقيقتين');
    assert.equal(spokenAgo(NOW - 25 * MIN, NOW, 'ar'), 'قبل نحو 25 دقيقة');
    assert.equal(spokenAgo(NOW - 60 * MIN, NOW, 'ar'), 'قبل نحو ساعة');
    assert.equal(spokenAgo(NOW - 5 * 60 * MIN, NOW, 'ar'), 'قبل نحو 5 ساعات');
    assert.equal(spokenAgo(NOW - 3 * 24 * 60 * MIN, NOW, 'ar'), 'قبل نحو 3 أيام');
    assert.equal(spokenPoints(3, 'ar'), 'بارتفاع 3 نقاط');
    assert.equal(spokenPoints(-1, 'ar'), 'بانخفاض نقطة واحدة');
    assert.equal(spokenPoints(0.2, 'ar'), 'دون تغيير');
    assert.equal(joinList(['أ', 'ب', 'ج'], 'ar'), 'أ، ب وج');
    assert.equal(cleanSpeech('النسبة 12% (تقديرية)', 'ar'), 'النسبة 12 في المئة، تقديرية.');
    // English is unchanged by the language parameter's default.
    assert.equal(cleanSpeech('share 12% (est)'), 'share 12 percent, est.');
  });
});

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

  it('get_chokepoint_status through dispatch: a stale port-activity index and an April baselines key do not age the live Hormuz reading', async () => {
    // Shaped like production on 2026-11-01: transit keys minutes old, the
    // annual EIA baselines key last written in April (inside its 400-day
    // budget), and the port-activity index past its 36-hour budget with a
    // failed last run, which is what trips the bundle's `stale`.
    const ago = (minutes) => NOW - minutes * MIN;
    redisKeys.set('supply_chain:transit-summaries:v1', {
      summaries: { hormuz_strait: { todayTotal: null, wowChangePct: -72.5, riskLevel: 'critical', incidentCount7d: 627, disruptionPct: 100, riskSummary: 'x', riskReportAction: 'y', anomaly: {}, dataAvailable: true, todayCountsAvailable: false } },
      fetchedAt: ago(3),
    });
    redisKeys.set('seed-meta:supply_chain:transit-summaries', { fetchedAt: ago(3), recordCount: 13 });
    redisKeys.set('supply_chain:chokepoint_transits:v1', { transits: { 'Strait of Hormuz': { tanker: 0, cargo: 0, other: 0, total: 0, available: false } }, fetchedAt: ago(3) });
    redisKeys.set('seed-meta:supply_chain:chokepoint_transits', { fetchedAt: ago(3), recordCount: 13 });
    redisKeys.set('supply_chain:portwatch-ports:v1:_countries', ['AE', 'SA']);
    redisKeys.set('seed-meta:supply_chain:portwatch-ports', { fetchedAt: ago(5719), recordCount: 174, status: 'error' });
    redisKeys.set('energy:chokepoint-baselines:v1', CHOKEPOINTS.data['chokepoint-baselines']);
    redisKeys.set('seed-meta:energy:chokepoint-baselines', { fetchedAt: ago(210 * 24 * 60), recordCount: 7 });
    redisKeys.set('portwatch:chokepoints:ref:v1', { hormuz_strait: { name: 'Strait of Hormuz' } });
    redisKeys.set('seed-meta:portwatch:chokepoints-ref', { fetchedAt: ago(2 * 24 * 60), recordCount: 13 });
    redisKeys.set('energy:chokepoint-flows:v1', { hormuz_strait: CHOKEPOINTS.data['chokepoint-flows'].hormuz_strait });
    redisKeys.set('seed-meta:energy:chokepoint-flows', { fetchedAt: ago(3 * 60), recordCount: 7 });

    const full = await call('get_chokepoint_status', { chokepoint: 'hormuz' });
    const envelope = JSON.parse(full.body.result.content[0].text);
    assert.equal(envelope.stale, true, 'the bundle verdict is unchanged');
    assert.equal(envelope.cached_at, iso(ago(210 * 24 * 60)));

    const { body } = await call('get_chokepoint_status', { chokepoint: 'hormuz', response_mode: 'spoken' });
    assert.equal(body.error, undefined, JSON.stringify(body.error ?? {}));
    const text = JSON.parse(body.result.content[0].text);
    assertSpeakable(text, 'dispatch chokepoint prod-shaped');
    assert.equal(text.spoken,
      'Strait of Hormuz is at critical risk, with 627 incidents in the past 7 days. '
      + 'Oil flow is 2.6 million barrels a day against a normal 21, about 12 percent of normal, and it is flagged as disrupted. '
      + "Today's transit count is not available yet.");
    assert.equal(text.stale, false);
    assert.equal(text.asOf, iso(ago(3)));
    assert.equal(strictClientVerdict(publicTools.get('get_chokepoint_status'), body.result), null);

    // The same bundle with the transit relay stalled: now the caveat names it.
    redisKeys.set('seed-meta:supply_chain:transit-summaries', { fetchedAt: ago(95), recordCount: 13 });
    redisKeys.set('supply_chain:transit-summaries:v1', { ...redisKeys.get('supply_chain:transit-summaries:v1'), fetchedAt: ago(95) });
    const stalled = JSON.parse((await call('get_chokepoint_status', { chokepoint: 'hormuz', response_mode: 'spoken' })).body.result.content[0].text);
    assertSpeakable(stalled, 'dispatch chokepoint transit stalled');
    assert.match(stalled.spoken, / The vessel counts and risk ratings were last updated about 2 hours ago and are flagged as stale, so they may be out of date\.$/);
    assert.equal(stalled.stale, true);
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

  it('advertises spoken_language beside response_mode, and only there', () => {
    for (const tool of registry) {
      const pub = publicTools.get(tool.name);
      const expected = SPOKEN_TOOLS.includes(tool.name);
      assert.equal('spoken_language' in pub.inputSchema.properties, expected, `${tool.name}: spoken_language advertised`);
      if (expected) assert.deepEqual(pub.inputSchema.properties.spoken_language.enum, ['en', 'ar']);
    }
  });

  it('spoken_language "ar" answers in Arabic through dispatch, and the argument never reaches the tool', async () => {
    stub('get_country_risk', async (params) => {
      assert.equal(params.spoken_language, undefined, 'the language is not forwarded to the tool');
      return COUNTRY_RISK;
    });
    const { body } = await call('get_country_risk', { country_code: 'IQ', response_mode: 'spoken', spoken_language: 'ar' });
    assert.equal(body.error, undefined, JSON.stringify(body.error ?? {}));
    const text = JSON.parse(body.result.content[0].text);
    assert.equal(text.language, 'ar');
    assert.match(text.spoken, /^درجة العراق على مؤشر عدم الاستقرار 62 من 100/);
    assert.equal(strictClientVerdict(publicTools.get('get_country_risk'), body.result), null);
  });

  it('spoken_language passes the strict prediction-market argument path', async () => {
    redisKeys.set('prediction:markets-bootstrap:v1', MARKETS_BOOTSTRAP);
    redisKeys.set('seed-meta:prediction:markets', { fetchedAt: NOW - 30 * MIN, recordCount: 3 });
    const { body } = await call('get_prediction_markets', { response_mode: 'spoken', spoken_language: 'ar' });
    assert.equal(body.error, undefined, JSON.stringify(body.error ?? {}));
    const text = JSON.parse(body.result.content[0].text);
    assert.equal(text.language, 'ar');
    assert.match(text.spoken, /^عدد العقود في أسواق التنبؤ/);
  });

  it('a spoken English call reports language "en"', async () => {
    stub('get_country_risk', async () => COUNTRY_RISK);
    const { body } = await call('get_country_risk', { country_code: 'IQ', response_mode: 'spoken' });
    assert.equal(JSON.parse(body.result.content[0].text).language, 'en');
  });

  it('rejects spoken_language without response_mode "spoken", on a tool without a narrator, and an unknown language', async () => {
    stub('get_country_risk', async () => COUNTRY_RISK);
    const cases = [
      ['get_country_risk', { country_code: 'IQ', spoken_language: 'ar' }, /only with response_mode "spoken"/],
      ['get_country_risk', { country_code: 'IQ', response_mode: 'full', spoken_language: 'ar' }, /only with response_mode "spoken"/],
      ['get_sources', { spoken_language: 'ar' }, /no spoken mode/i],
      ['get_country_risk', { country_code: 'IQ', response_mode: 'spoken', spoken_language: 'fr' }, /en, ar/],
    ];
    stub('get_sources', async () => ({ view: 'summary', summary: { providerCount: 1 }, providers: [] }));
    for (const [name, args, pattern] of cases) {
      const { body } = await call(name, args);
      assert.equal(body.error?.code, -32602, `${name} ${JSON.stringify(args)}: ${JSON.stringify(body)}`);
      const violation = body.error.data.violations.find((v) => v.field === 'spoken_language');
      assert.ok(violation, JSON.stringify(body.error));
      assert.match(violation.description, pattern);
    }
  });
});
