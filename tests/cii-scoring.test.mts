import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CURATED_COUNTRIES, TIER1_COUNTRIES } from '../src/config/countries.ts';
import {
  CII_CONFLICT_ACTIVITY_CAP,
  CII_CONFLICT_ACTIVITY_PIVOT,
  CII_FORMULA_VERSION,
  STRATEGIC_RISK_POSITIONAL_DECAY,
  STRATEGIC_RISK_SCALE_FACTOR,
  STRATEGIC_RISK_SCALE_FLOOR,
  STRATEGIC_RISK_TOP_N,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES as SERVER_TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import {
  BASELINE_RISK,
  CII_TREND_BUCKET_LOOKUP_RADIUS,
  CII_TREND_BUCKET_MS,
  CII_TREND_TARGET_AGE_MS,
  EVENT_MULTIPLIER,
  computeCIIScores,
  computeStrategicRisks,
  filterRiskScoresResponse,
  geoToCountry,
  getAcledFetchWindows,
  getCiiTrendHistoryBucket,
  getCiiTrendPriorCandidateBuckets,
  normalizeCountryName,
  selectCiiTrendPriorSnapshot,
  ZONE_COUNTRY_MAP,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import {
  CII_BASELINE_RISK as SHARED_BASELINE_RISK,
  CII_COUNTRY_WEIGHTS,
  CII_EVENT_MULTIPLIER as SHARED_EVENT_MULTIPLIER,
} from '../shared/cii-weights.ts';
import { CLIMATE_ZONES } from '../scripts/_climate-zones.mjs';

function emptyAux() {
  return {
    ucdpEvents: [] as any[],
    outages: [] as any[],
    climate: [] as any[],
    cyber: [] as any[],
    fires: [] as any[],
    gpsHexes: [] as any[],
    iranEvents: [] as any[],
    orefData: null as { activeAlertCount: number; historyCount24h: number } | null,
    advisories: null as { byCountry: Record<string, 'do-not-travel' | 'reconsider' | 'caution'> } | null,
    displacedByIso3: {} as Record<string, number>,
    newsTopStories: [] as Array<{ countryCode: string | null; threatLevel: string; primaryTitle: string }>,
    threatSummaryByCountry: null as Record<string, { critical: number; high: number; medium: number; low: number; info: number }> | null,
    aviationAlerts: [] as any[],
    earthquakes: [] as any[],
    sanctionsCountries: [] as any[],
    sanctionsCountryCounts: null as Record<string, number> | null,
    temporalAnomalies: [] as any[],
    militaryCii: null as Record<string, any> | null,
  };
}

function acledEvent(country: string, type: string, fatalities = 0) {
  return { country, event_type: type, fatalities };
}

function acledEvents(country: string, type: string, count: number) {
  return Array.from({ length: count }, () => acledEvent(country, type));
}

function scoreFor(scores: ReturnType<typeof computeCIIScores>, code: string) {
  return scores.find((s) => s.region === code);
}

const TREND_TEST_NOW = 1_700_000_000_000;

function priorCiiScore(region: string, combinedScore: number, computedAt = TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS) {
  return {
    region,
    staticBaseline: 0,
    dynamicScore: 0,
    combinedScore,
    trend: 'TREND_DIRECTION_STABLE',
    components: { newsActivity: 0, ciiContribution: 0, geoConvergence: 0, militaryActivity: 0 },
    computedAt,
    methodologyVersion: CII_FORMULA_VERSION,
    eventMultiplier: 1,
  } as ReturnType<typeof computeCIIScores>[number];
}

function trendSnapshot(capturedAt: number) {
  return {
    capturedAt,
    ciiScores: [priorCiiScore('US', 42, capturedAt)],
  };
}

describe('CII signal wiring', () => {
  it('country text attribution uses token boundaries and preserves explicit aliases', () => {
    assert.equal(normalizeCountryName('Jerusalem security alert'), null,
      'Jerusalem must not match US via the embedded "usa" substring');
    assert.equal(normalizeCountryName('Sukhoi incident reported'), null,
      'Sukhoi must not match GB via the embedded "uk" substring');
    assert.equal(normalizeCountryName('New England outage'), null,
      'New England must not match GB via a bare England alias');
    assert.equal(normalizeCountryName('Fukushima plant inspection'), 'JP',
      'Fukushima is a legitimate Japan place alias, not a GB substring match');
    assert.equal(normalizeCountryName('United Kingdom sanctions update'), 'GB',
      'United Kingdom must resolve to GB');
    assert.equal(normalizeCountryName('UK sanctions update'), 'GB',
      'UK remains a valid token alias for GB');
    assert.equal(normalizeCountryName('U.K. sanctions update'), 'GB',
      'dotted U.K. remains a valid token alias for GB');
    assert.equal(normalizeCountryName('Iranian sanctions debate'), 'IR',
      'demonym aliases that raw substring matching used to cover must stay covered explicitly');
    assert.equal(normalizeCountryName('North Korean missile drill'), 'KP',
      'North Korean demonym should resolve to KP');
    assert.equal(normalizeCountryName('Taiwanese election pressure'), 'TW',
      'Taiwanese demonym should resolve to TW');
    assert.equal(normalizeCountryName('Korean export data'), null,
      'bare Korean remains ambiguous and must not resolve to KR/KP');
  });

  it('geoToCountry disambiguates known overlapping bboxes with deterministic border heuristics', () => {
    assert.equal(geoToCountry(33.5138, 36.2765), 'SY', 'Damascus must resolve to Syria, not Lebanon');
    assert.equal(geoToCountry(29.7604, -95.3698), 'US', 'southern US coordinates must resolve to US, not Mexico');
    assert.equal(geoToCountry(33.5904, 130.4017), 'JP', 'Fukuoka must resolve to Japan, not South Korea');
    assert.equal(geoToCountry(17.5656, 44.2289), 'SA', 'Najran must resolve to Saudi Arabia, not Yemen');

    assert.equal(geoToCountry(32.7157, -117.1611), 'US', 'San Diego remains US');
    assert.equal(geoToCountry(32.5149, -117.0382), 'MX', 'Tijuana remains Mexico');
    assert.equal(geoToCountry(31.7619, -106.4850), 'US', 'El Paso remains US');
    assert.equal(geoToCountry(31.6904, -106.4245), 'MX', 'Ciudad Juarez remains Mexico');
    assert.equal(geoToCountry(25.9017, -97.4975), 'US', 'Brownsville remains US');
    assert.equal(geoToCountry(27.4763, -99.5164), 'MX', 'Nuevo Laredo must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(28.6916, -100.5409), 'MX', 'Piedras Negras must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(29.3232, -100.9522), 'MX', 'Ciudad Acuna must resolve to Mexico, not Texas');
    assert.equal(geoToCountry(25.6866, -100.3161), 'MX', 'Monterrey remains Mexico');
    assert.equal(geoToCountry(33.8938, 35.5018), 'LB', 'Beirut remains Lebanon');
    assert.equal(geoToCountry(37.5665, 126.9780), 'KR', 'Seoul remains South Korea');
    assert.equal(geoToCountry(37.9382, 126.5878), 'KP', 'Kaesong must resolve to North Korea, not South Korea');
    assert.equal(geoToCountry(38.0400, 125.7140), 'KP', 'Haeju must resolve to North Korea, not South Korea');
    assert.equal(geoToCountry(15.3694, 44.1910), 'YE', 'Sanaa remains Yemen');
    assert.equal(geoToCountry(47.2357, 39.7015), 'RU', 'Rostov-on-Don must resolve to Russia, not Ukraine');
    assert.equal(geoToCountry(51.7304, 36.1939), 'RU', 'Kursk remains Russia');
    assert.equal(geoToCountry(50.5954, 36.5873), 'RU', 'Belgorod remains Russia');
    assert.equal(geoToCountry(50.9077, 34.7981), 'UA', 'Sumy must resolve to Ukraine, not Russia');
    assert.equal(geoToCountry(49.9935, 36.2304), 'UA', 'Kharkiv remains Ukraine');
    assert.equal(geoToCountry(31.5204, 74.3587), 'PK', 'Lahore remains Pakistan');
    assert.equal(geoToCountry(31.6340, 74.8723), 'IN', 'Amritsar must resolve to India, not Pakistan');
    assert.equal(geoToCountry(43.1155, 131.8855), 'RU', 'Vladivostok must resolve to Russia, not China');
    assert.equal(geoToCountry(50.2907, 127.5272), 'RU', 'Blagoveshchensk remains Russia');
    assert.equal(geoToCountry(50.2458, 127.4886), 'CN', 'Heihe must resolve to China, not Russia');
    assert.equal(geoToCountry(52.9721, 122.5386), 'CN', 'Mohe must resolve to China, not Russia');
    assert.equal(geoToCountry(45.8038, 126.5350), 'CN', 'Harbin remains China');
    assert.equal(geoToCountry(46.9591, 142.7380), 'RU', 'Yuzhno-Sakhalinsk must resolve to Russia, not Japan');
    assert.equal(geoToCountry(45.4500, 142.0500), 'RU', 'southern Sakhalin inside the JP bbox must resolve to Russia');
    assert.equal(geoToCountry(45.4150, 141.6730), 'JP', 'Wakkanai remains Japan');
    assert.equal(geoToCountry(43.0618, 141.3545), 'JP', 'Sapporo remains Japan');
  });

  it('climate producer zones intersect the CII consumer map for score-relevant zones', () => {
    const producerZones = new Set(CLIMATE_ZONES.map((zone) => zone.name));
    const expected: Record<string, string[]> = {
      Ukraine: ['UA'],
      California: ['US'],
      Amazon: ['BR'],
      'Taiwan Strait': ['TW'],
      Caribbean: ['CU', 'MX'],
      'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE', 'AE', 'IQ', 'LB', 'QA'],
      'South Asia': ['IN', 'PK', 'AF'],
      Myanmar: ['MM'],
    };

    for (const [zone, expectedCodes] of Object.entries(expected)) {
      assert.equal(producerZones.has(zone), true, `${zone} must still be emitted by the climate producer`);
      assert.deepEqual(
        expectedCodes.filter((code) => ZONE_COUNTRY_MAP[zone]?.includes(code)),
        expectedCodes,
        `${zone} must feed CII countries ${expectedCodes.join(', ')}`,
      );
    }
  });

  it('climate anomaly enum severities raise scores for producer zone names', () => {
    const cases: Array<[string, string]> = [
      ['California', 'US'],
      ['Ukraine', 'UA'],
      ['Amazon', 'BR'],
      ['Taiwan Strait', 'TW'],
      ['Caribbean', 'MX'],
      ['Caribbean', 'CU'],
    ];

    for (const [zone, code] of cases) {
      const countryName = TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES];
      const activity = acledEvents(countryName, 'Battles', 1000);
      const base = scoreFor(computeCIIScores(activity, emptyAux()), code);
      const aux = emptyAux();
      aux.climate = [{ zone, severity: 'ANOMALY_SEVERITY_EXTREME' }];
      const withClimate = scoreFor(computeCIIScores(activity, aux), code);
      assert.ok(
        withClimate!.combinedScore > base!.combinedScore,
        `${zone} anomaly should raise ${code} through climateBoost`,
      );
    }
  });

  it('ACLED 7d and 30d fetch windows do not double-count the 7-day boundary date', () => {
    const windows = getAcledFetchWindows(Date.UTC(2026, 5, 6, 12, 0, 0));
    assert.deepEqual(windows, {
      recent: { startDate: '2026-05-30', endDate: '2026-06-06' },
      older: { startDate: '2026-05-07', endDate: '2026-05-29' },
    });
    assert.notEqual(windows.recent.startDate, windows.older.endDate,
      'older window must end before the recent inclusive start date');
  });

  it('earthquake seed fetches the same 7-day window that CII scoring claims', () => {
    const seedPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'scripts',
      'seed-earthquakes.mjs',
    );
    const seed = readFileSync(seedPath, 'utf8');
    assert.match(seed, /summary\/4\.5_week\.geojson/,
      'seed-earthquakes must use the USGS 7-day feed because CII scores a 7-day earthquake lookback');
    assert.doesNotMatch(seed, /summary\/4\.5_day\.geojson/,
      'seed-earthquakes must not publish only a 1-day feed under the 7-day CII scoring contract');
  });

  it('Phase 3b D5/D6: earthquake / sanctions signals raise the score', () => {
    // Temporal anomalies are deliberately NOT scored — the temporal:anomalies:v1
    // producer emits region:'global' so they cannot be country-attributed. The
    // score rise asserted below comes entirely from earthquakeBoost + sanctionsBoost.
    const acled = [acledEvent('US', 'protest', 0)];
    const base = scoreFor(computeCIIScores(acled, emptyAux()), 'US');
    const aux = emptyAux();
    aux.earthquakes = [{ magnitude: 7.0, occurredAt: Date.now(), location: { latitude: 39, longitude: -98 } }];
    aux.sanctionsCountries = [
      { countryCode: 'US', entryCount: 10, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 5, newEntryCount: 0 }, // duplicate ISO2 — must accumulate, not overwrite
    ];
    const withAux = scoreFor(computeCIIScores(acled, aux), 'US');
    assert.ok(withAux, 'computeCIIScores handles the aux sources without throwing');
    assert.ok(withAux!.combinedScore > base!.combinedScore,
      'earthquake + sanctions feed earthquakeBoost + sanctionsBoost in the blend');
  });

  it('Phase 3b D7/D8: cyber severity + high-brightness fires raise the score', () => {
    const base = scoreFor(computeCIIScores([], emptyAux()), 'US');
    const aux = emptyAux();
    aux.cyber = [{ country: 'US', severity: 'critical' }, { country: 'US', severity: 'high' }];
    aux.fires = [{ lat: 39, lon: -98, brightness: 400, frp: 60 }];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.ok(us!.combinedScore > base!.combinedScore,
      'critical/high cyber feed the severity-weighted cyberBoost; a bright fire feeds fireBoost');
  });

  it('Phase 3b D7: cyber severity accepts the production proto enum form (CRITICALITY_LEVEL_*)', () => {
    // The cyber seed (seed-cyber-threats.mjs lines 52-55) emits the proto enum strings,
    // not bare lowercase — the ingestion must bucket both. Without the prefix-strip,
    // these would all fall through and cyberBoost would be 0 in production.
    const baseAux = emptyAux();
    const protoAux = emptyAux();
    protoAux.cyber = [
      { country: 'US', severity: 'CRITICALITY_LEVEL_CRITICAL' },
      { country: 'US', severity: 'CRITICALITY_LEVEL_HIGH' },
    ];
    const protoScore = scoreFor(computeCIIScores([], protoAux), 'US');
    const baseScore = scoreFor(computeCIIScores([], baseAux), 'US');
    assert.ok(protoScore!.combinedScore > baseScore!.combinedScore,
      'production CRITICALITY_LEVEL_* enums must feed cyberBoost');
  });

  it('Phase 3b D6: sanctions duplicate-ISO2 rows accumulate across the tier boundary', () => {
    const aux = emptyAux();
    aux.sanctionsCountries = [
      { countryCode: 'US', entryCount: 60, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 60, newEntryCount: 0 },
    ];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    const none = scoreFor(computeCIIScores([], emptyAux()), 'US');
    // 60+60 = 120 entries → tier ≥101 → boost 5, +2 newEntry = 7. Had the loop overwritten
    // instead of accumulated, 60 alone → tier <101 → boost 3+2 = 5. The gap proves accumulation.
    assert.ok(us!.combinedScore - none!.combinedScore >= 7,
      'duplicate-ISO2 sanctions rows accumulate (120 entries crosses the ≥101 tier)');
  });

  it('Phase 3b D6: sanctions all-country count map scores countries outside the top pressure rows', () => {
    const aux = emptyAux();
    aux.sanctionsCountries = [];
    aux.sanctionsCountryCounts = { GB: 120 };
    const gb = scoreFor(computeCIIScores([], aux), 'GB');
    const none = scoreFor(computeCIIScores([], emptyAux()), 'GB');
    assert.ok(gb!.combinedScore > none!.combinedScore,
      'CII must use sanctions:country-counts:v1 so countries outside the top-12 pressure rows are not silently ignored');
  });

  it('C3: security component scores military flights/vessels/aviation, not just GPS', () => {
    // No GPS hexes — pre-Phase-3b this would score security 0; the 4-input formula
    // must now pick up military activity and aviation.
    const aux = emptyAux();
    aux.militaryCii = {
      US: { ownFlights: 5, foreignFlights: 0, ownVessels: 0, foreignVessels: 0, aisDisruptionHigh: 0, aisDisruptionElevated: 0, aisDisruptionLow: 0 },
    };
    aux.aviationAlerts = [{ country: 'United States', delayType: 'closure' }];
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.ok(us, 'US scored');
    // flightScore = min(50, 5·3=15) = 15; aviationScore (one closure) = 20; vessels/GPS = 0
    assert.equal(us!.components!.militaryActivity, 35,
      'security = flightScore(15) + aviationScore(20), no GPS');
  });

  it('Phase 3b C1: a riot adds severityBoost vs a plain protest', () => {
    // Same unrest count (1 event), 0 fatalities, 0 outages in both — the only difference
    // is the riot classifies as high-severity → severityBoost. Isolates C1.
    const protest = scoreFor(computeCIIScores([acledEvent('Russia', 'Protests', 0)], emptyAux()), 'RU');
    const riot = scoreFor(computeCIIScores([acledEvent('Russia', 'Riots', 0)], emptyAux()), 'RU');
    assert.ok(riot!.components!.ciiContribution > protest!.components!.ciiContribution,
      'a riot is high-severity unrest and adds severityBoost; a plain protest does not');
  });

  it('C3: foreign military presence is weighted x2', () => {
    const aux = emptyAux();
    // 0 own + 5 foreign flights → reconstructed count 0 + 5·2 = 10 → flightScore min(50, 30) = 30
    aux.militaryCii = {
      US: { ownFlights: 0, foreignFlights: 5, ownVessels: 0, foreignVessels: 0, aisDisruptionHigh: 0, aisDisruptionElevated: 0, aisDisruptionLow: 0 },
    };
    const us = scoreFor(computeCIIScores([], aux), 'US');
    assert.equal(us!.components!.militaryActivity, 30, 'foreign flights weighted x2: 5·2·3 = 30');
  });
});

describe('CII scoring', () => {
  it('returns scores for all 31 tier-1 countries including MX, BR, AE, LB, IQ, AF', () => {
    const scores = computeCIIScores([], emptyAux());
    assert.equal(scores.length, 31);
    assert.ok(scoreFor(scores, 'MX'), 'MX missing');
    assert.ok(scoreFor(scores, 'BR'), 'BR missing');
    assert.ok(scoreFor(scores, 'AE'), 'AE missing');
    assert.ok(scoreFor(scores, 'LB'), 'LB missing');
    assert.ok(scoreFor(scores, 'IQ'), 'IQ missing');
    assert.ok(scoreFor(scores, 'AF'), 'AF missing');
    assert.ok(scoreFor(scores, 'KR'), 'KR missing');
    assert.ok(scoreFor(scores, 'EG'), 'EG missing');
    assert.ok(scoreFor(scores, 'JP'), 'JP missing');
    assert.ok(scoreFor(scores, 'QA'), 'QA missing');
  });

  it('UCDP war floor: composite >= 70', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Ukraine', intensity_level: '2' }];
    const scores = computeCIIScores([], aux);
    const ua = scoreFor(scores, 'UA')!;
    assert.ok(ua.combinedScore >= 70, `UA score ${ua.combinedScore} should be >= 70 with UCDP war`);
  });

  it('UCDP minor conflict floor: composite >= 50', () => {
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Pakistan', intensity_level: '1' }];
    const scores = computeCIIScores([], aux);
    const pk = scoreFor(scores, 'PK')!;
    assert.ok(pk.combinedScore >= 50, `PK score ${pk.combinedScore} should be >= 50 with UCDP minor`);
  });

  it('advisory do-not-travel floor: composite >= 60', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['UA', 'SY', 'YE', 'MM']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 60, `${code} score ${s.combinedScore} should be >= 60 (do-not-travel)`);
    }
  });

  it('advisory reconsider floor: composite >= 50', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const code of ['MX', 'IR', 'PK', 'VE', 'CU']) {
      const s = scoreFor(scores, code)!;
      assert.ok(s.combinedScore >= 50, `${code} score ${s.combinedScore} should be >= 50 (reconsider)`);
    }
  });

  it('OREF active alerts boost IL conflict score', () => {
    const aux = emptyAux();
    aux.orefData = { activeAlertCount: 5, historyCount24h: 12 };
    const withOref = scoreFor(computeCIIScores([], aux), 'IL')!;
    const withoutOref = scoreFor(computeCIIScores([], emptyAux()), 'IL')!;
    assert.ok(withOref.combinedScore > withoutOref.combinedScore,
      `IL with OREF (${withOref.combinedScore}) should be > without (${withoutOref.combinedScore})`);
  });

  it('outage TOTAL severity gives higher unrest component than PARTIAL', () => {
    const auxTotal = emptyAux();
    auxTotal.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_TOTAL' }];
    const auxPartial = emptyAux();
    auxPartial.outages = [{ countryCode: 'DE', severity: 'OUTAGE_SEVERITY_PARTIAL' }];
    const total = scoreFor(computeCIIScores([], auxTotal), 'DE')!;
    const partial = scoreFor(computeCIIScores([], auxPartial), 'DE')!;
    assert.ok(total.components!.ciiContribution > partial.components!.ciiContribution,
      `TOTAL unrest (${total.components!.ciiContribution}) should be > PARTIAL (${partial.components!.ciiContribution})`);
  });

  it('GPS high level gives higher weight than medium', () => {
    const auxHigh = emptyAux();
    auxHigh.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'high' }));
    const auxMed = emptyAux();
    auxMed.gpsHexes = Array.from({ length: 5 }, () => ({ lat: 33.0, lon: 35.0, level: 'medium' }));
    const high = scoreFor(computeCIIScores([], auxHigh), 'IL')!;
    const med = scoreFor(computeCIIScores([], auxMed), 'IL')!;
    assert.ok(high.components!.militaryActivity >= med.components!.militaryActivity,
      `GPS high (${high.components!.militaryActivity}) should be >= medium (${med.components!.militaryActivity})`);
  });

  it('conflict fatalities use sqrt scaling', () => {
    const acled100 = [acledEvent('Ukraine', 'Battles', 100)];
    const acled400 = [acledEvent('Ukraine', 'Battles', 400)];
    const s100 = scoreFor(computeCIIScores(acled100, emptyAux()), 'UA')!;
    const s400 = scoreFor(computeCIIScores(acled400, emptyAux()), 'UA')!;
    const diff = s400.combinedScore - s100.combinedScore;
    assert.ok(diff < (s400.combinedScore - s100.staticBaseline) * 0.5,
      'sqrt scaling should produce diminishing returns for 4x fatalities');
  });

  it('conflict activity scaling preserves the gap between moderate and extreme event volume', () => {
    const acled = [
      ...Array.from({ length: 46 }, () => acledEvent('China', 'Battles')),
      ...Array.from({ length: 1549 }, () => acledEvent('Iran', 'Battles')),
    ];
    const scores = computeCIIScores(acled, emptyAux());
    const cn = scoreFor(scores, 'CN')!;
    const ir = scoreFor(scores, 'IR')!;
    assert.ok(
      ir.components!.geoConvergence >= cn.components!.geoConvergence + 10,
      `IR conflict component (${ir.components!.geoConvergence}) should materially exceed CN (${cn.components!.geoConvergence})`,
    );
  });

  it('log2 scaling dampens high-volume low-multiplier countries vs linear', () => {
    const manyProtests = Array.from({ length: 100 }, () => acledEvent('United States', 'Protests'));
    const fewProtests = Array.from({ length: 10 }, () => acledEvent('United States', 'Protests'));
    const many = scoreFor(computeCIIScores(manyProtests, emptyAux()), 'US')!;
    const few = scoreFor(computeCIIScores(fewProtests, emptyAux()), 'US')!;
    const ratio = many.components!.ciiContribution / Math.max(1, few.components!.ciiContribution);
    assert.ok(ratio < 5, `10x events should produce < 5x unrest ratio (got ${ratio.toFixed(2)}), log2 dampens`);
  });

  it('displacement boost preserves humanitarian scale above six figures', () => {
    const moderateAux = emptyAux();
    moderateAux.displacedByIso3 = { USA: 120_000 };
    const extremeAux = emptyAux();
    extremeAux.displacedByIso3 = { USA: 5_600_000 };
    const moderate = scoreFor(computeCIIScores([], moderateAux), 'US')!;
    const extreme = scoreFor(computeCIIScores([], extremeAux), 'US')!;
    assert.ok(
      extreme.combinedScore >= moderate.combinedScore + 10,
      `5.6M displaced (${extreme.combinedScore}) should score materially above 120K (${moderate.combinedScore})`,
    );
  });

  it('iran high severity strikes boost conflict', () => {
    const aux1 = emptyAux();
    aux1.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'high' }];
    const aux2 = emptyAux();
    aux2.iranEvents = [{ lat: 33.0, lon: 35.0, severity: 'low' }];
    const highSev = scoreFor(computeCIIScores([], aux1), 'IL')!;
    const lowSev = scoreFor(computeCIIScores([], aux2), 'IL')!;
    assert.ok(highSev.combinedScore >= lowSev.combinedScore,
      `High severity strike (${highSev.combinedScore}) should be >= low (${lowSev.combinedScore})`);
  });

  it('IL scores higher than MX with active conflict signals', () => {
    const acled = [
      acledEvent('Israel', 'Battles', 10),
      acledEvent('Israel', 'Explosions/Remote violence', 5),
      acledEvent('Mexico', 'Riots', 3),
    ];
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Israel', intensity_level: '1' }];
    aux.orefData = { activeAlertCount: 3, historyCount24h: 8 };
    const scores = computeCIIScores(acled, aux);
    const il = scoreFor(scores, 'IL')!;
    const mx = scoreFor(scores, 'MX')!;
    assert.ok(il.combinedScore > mx.combinedScore,
      `IL (${il.combinedScore}) should be > MX (${mx.combinedScore})`);
  });

  it('scores capped at 100', () => {
    const acled = Array.from({ length: 200 }, () => acledEvent('Syria', 'Battles', 50));
    const aux = emptyAux();
    aux.ucdpEvents = [{ country: 'Syria', intensity_level: '2' }];
    aux.iranEvents = Array.from({ length: 50 }, () => ({ lat: 35.0, lon: 38.0, severity: 'critical' }));
    const scores = computeCIIScores(acled, aux);
    for (const s of scores) {
      assert.ok(s.combinedScore <= 100, `${s.region} score ${s.combinedScore} should be <= 100`);
    }
  });

  it('UAE geo events attributed to AE not SA despite bbox overlap', () => {
    const aux = emptyAux();
    aux.gpsHexes = [{ lat: 25.2, lon: 55.3, level: 'high' }];
    const scores = computeCIIScores([], aux);
    const ae = scoreFor(scores, 'AE')!;
    const sa = scoreFor(scores, 'SA')!;
    assert.ok(ae.components!.militaryActivity > 0, 'AE should get the Dubai GPS hex');
    assert.equal(sa.components!.militaryActivity, 0, 'SA should not get the Dubai GPS hex');
  });

  it('empty data returns baseline-derived scores with floors', () => {
    const scores = computeCIIScores([], emptyAux());
    const us = scoreFor(scores, 'US')!;
    assert.ok(us.combinedScore >= 2 && us.combinedScore <= 10, `US baseline score ${us.combinedScore} should be ~2-10`);
  });

  it('cold-start emits flat movement instead of baseline delta', () => {
    const us = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    assert.notEqual(us.combinedScore - us.staticBaseline, 0, 'fixture should have a non-zero structural baseline gap');
    assert.equal(us.dynamicScore, 0, 'cold-start movement must not reuse combinedScore - staticBaseline');
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('derives rising trend and dynamicScore from a prior CII snapshot', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 5)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 5);
    assert.equal(us.trend, 'TREND_DIRECTION_RISING');
  });

  it('derives falling trend and negative dynamicScore from a prior CII snapshot', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore + 5)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, -5);
    assert.equal(us.trend, 'TREND_DIRECTION_FALLING');
  });

  it('keeps trend stable inside the one-point deadband while preserving the measured delta', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 1)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 1);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('rejects live-cache-age prior snapshots when deriving CII movement', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 10, TREND_TEST_NOW - 10 * 60 * 1000)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 0);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('ignores stale prior snapshots when deriving CII movement', () => {
    const current = scoreFor(computeCIIScores([], emptyAux(), { nowMs: TREND_TEST_NOW }), 'US')!;
    const us = scoreFor(
      computeCIIScores([], emptyAux(), {
        nowMs: TREND_TEST_NOW,
        priorScores: [priorCiiScore('US', current.combinedScore - 10, TREND_TEST_NOW - 25 * 60 * 60 * 1000)],
      }),
      'US',
    )!;

    assert.equal(us.dynamicScore, 0);
    assert.equal(us.trend, 'TREND_DIRECTION_STABLE');
  });

  it('targets trend history buckets around the 24-hour comparison window', () => {
    const targetBucket = getCiiTrendHistoryBucket(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS);
    const currentBucket = getCiiTrendHistoryBucket(TREND_TEST_NOW);
    const buckets = getCiiTrendPriorCandidateBuckets(TREND_TEST_NOW);

    assert.equal(buckets[0], targetBucket);
    assert.equal(new Set(buckets).size, 1 + CII_TREND_BUCKET_LOOKUP_RADIUS * 2);
    assert.equal(buckets.includes(currentBucket), false, 'trend lookup must not target the live cache bucket');
  });

  it('selects the prior snapshot closest to 24 hours and ignores outside-window snapshots', () => {
    const recent = trendSnapshot(TREND_TEST_NOW - 10 * 60 * 1000);
    const outside = trendSnapshot(
      TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS - (CII_TREND_BUCKET_LOOKUP_RADIUS + 1) * CII_TREND_BUCKET_MS,
    );
    const farther = trendSnapshot(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS - 2 * CII_TREND_BUCKET_MS);
    const closest = trendSnapshot(TREND_TEST_NOW - CII_TREND_TARGET_AGE_MS + CII_TREND_BUCKET_MS);

    assert.equal(selectCiiTrendPriorSnapshot([recent, outside], TREND_TEST_NOW), null);
    assert.equal(selectCiiTrendPriorSnapshot([recent, farther, closest], TREND_TEST_NOW), closest);
  });

  it('handler uses dedicated trend history rather than stale fallback as the movement prior', () => {
    const handlerPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'server',
      'worldmonitor',
      'intelligence',
      'v1',
      'get-risk-scores.ts',
    );
    const handlerSource = readFileSync(handlerPath, 'utf8');
    const freshGateIndex = handlerSource.indexOf("if (source === 'fresh')");
    const trendPersistIndex = handlerSource.indexOf('await persistCiiTrendSnapshot(result)');

    assert.match(handlerSource, /readCiiTrendPriorScores\(nowMs\)/);
    assert.doesNotMatch(handlerSource, /priorRiskScores/);
    assert.ok(trendPersistIndex > freshGateIndex, 'trend history writes must be gated to fresh upstream computations');
  });

  it('newsTopStories critical threat boosts newsActivity for attributed country', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'RU', threatLevel: 'critical', primaryTitle: 'Russia launches strikes' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'RU')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'RU')!;
    assert.ok(withNews.components!.newsActivity > 0, 'newsActivity should be > 0 with critical story');
    assert.ok(withNews.combinedScore > withoutNews.combinedScore,
      `RU with critical news (${withNews.combinedScore}) should exceed baseline (${withoutNews.combinedScore})`);
  });

  it('threatSummaryByCountry boosts newsActivity for target country', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { RU: { critical: 3, high: 2, medium: 1, low: 1, info: 0 } };
    const withThreat = scoreFor(computeCIIScores([], aux), 'RU')!;
    const withoutThreat = scoreFor(computeCIIScores([], emptyAux()), 'RU')!;
    assert.ok(withThreat.components!.newsActivity > 0, 'newsActivity should be > 0 with threat summary');
    assert.ok(withThreat.combinedScore > withoutThreat.combinedScore,
      `RU with threat summary (${withThreat.combinedScore}) should exceed baseline (${withoutThreat.combinedScore})`);
  });

  // Cap raised 20 → 100 per issue #3739 — the 20 cap silently limited
  // information's max contribution to 5/25 points despite the equal 0.25 weight.
  it('newsTopStories newsActivity scales above 20 with heavy input and is capped at 100', () => {
    const aux = emptyAux();
    aux.newsTopStories = Array.from({ length: 20 }, () => ({
      countryCode: 'SY', threatLevel: 'critical', primaryTitle: 'Syria conflict escalates',
    }));
    const scores = computeCIIScores([], aux);
    const sy = scoreFor(scores, 'SY')!;
    assert.ok(sy.components!.newsActivity > 20, `newsActivity ${sy.components!.newsActivity} should exceed 20 (cap raised to 100 per #3739)`);
    assert.ok(sy.components!.newsActivity <= 100, `newsActivity ${sy.components!.newsActivity} should be capped at 100`);
  });

  it('threatSummaryByCountry newsActivity is capped at 100 (per-source threatSummaryScore still inner-capped at 20)', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { SY: { critical: 100, high: 100, medium: 100, low: 100, info: 100 } };
    const scores = computeCIIScores([], aux);
    const sy = scoreFor(scores, 'SY')!;
    assert.ok(sy.components!.newsActivity <= 100, `newsActivity ${sy.components!.newsActivity} should be capped at 100`);
  });

  it('newsTopStories moderate threat contributes (not silently dropped)', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'DE', threatLevel: 'moderate', primaryTitle: 'Germany election results' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'DE')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'DE')!;
    assert.ok(withNews.components!.newsActivity > 0, 'moderate threat should produce non-zero newsActivity');
    assert.ok(withNews.combinedScore >= withoutNews.combinedScore,
      `DE with moderate news (${withNews.combinedScore}) should be >= baseline (${withoutNews.combinedScore})`);
  });

  it('newsTopStories null countryCode falls back to title keyword match', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: null, threatLevel: 'high', primaryTitle: 'Iran launches ballistic missile test' },
    ];
    const withNews = scoreFor(computeCIIScores([], aux), 'IR')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'IR')!;
    assert.ok(withNews.components!.newsActivity > 0, 'null countryCode with Iran keyword should attribute to IR');
    assert.ok(withNews.components!.newsActivity > withoutNews.components!.newsActivity,
      `IR newsActivity with keyword-matched news (${withNews.components!.newsActivity}) should exceed baseline (${withoutNews.components!.newsActivity})`);
  });

  it('newsTopStories info threat is not counted', () => {
    const aux = emptyAux();
    aux.newsTopStories = [
      { countryCode: 'JP', threatLevel: 'info', primaryTitle: 'Japan trade summit scheduled' },
    ];
    const withInfo = scoreFor(computeCIIScores([], aux), 'JP')!;
    const withoutNews = scoreFor(computeCIIScores([], emptyAux()), 'JP')!;
    assert.equal(withInfo.components!.newsActivity, withoutNews.components!.newsActivity,
      'info threat level should not affect newsActivity');
  });

  it('threatSummaryByCountry unknown country code is safely ignored', () => {
    const aux = emptyAux();
    aux.threatSummaryByCountry = { XX: { critical: 10, high: 5, medium: 2, low: 1, info: 0 } };
    assert.doesNotThrow(() => computeCIIScores([], aux), 'unknown country code should not throw');
  });

  it('null threatSummaryByCountry produces zero newsActivity', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      assert.equal(s.components!.newsActivity, 0, `${s.region} should have zero newsActivity with null threatSummary`);
    }
  });

  // ===== Disclosure fields (issue #3725) =====

  it('every score carries methodologyVersion === CII_FORMULA_VERSION', () => {
    const scores = computeCIIScores([], emptyAux());
    assert.ok(scores.length > 0, 'expected non-empty score set');
    for (const s of scores) {
      assert.equal(
        (s as unknown as { methodologyVersion: string }).methodologyVersion,
        CII_FORMULA_VERSION,
        `${s.region} methodologyVersion should equal '${CII_FORMULA_VERSION}'`,
      );
      assert.equal(typeof (s as unknown as { methodologyVersion: string }).methodologyVersion, 'string');
    }
  });

  it('every score carries the shared editorial eventMultiplier', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      const mult = (s as unknown as { eventMultiplier: number }).eventMultiplier;
      const expected = SHARED_EVENT_MULTIPLIER[s.region as keyof typeof SHARED_EVENT_MULTIPLIER];
      assert.ok(Number.isFinite(mult), `${s.region} eventMultiplier should be finite, got ${mult}`);
      assert.ok(mult > 0, `${s.region} eventMultiplier should be > 0, got ${mult}`);
      assert.ok(mult <= 5, `${s.region} eventMultiplier should be <= 5 (sanity), got ${mult}`);
      assert.equal(mult, expected, `${s.region} eventMultiplier should match shared/cii-weights.ts`);
    }
  });

  it('staticBaseline is in [0, 100] for every score', () => {
    const scores = computeCIIScores([], emptyAux());
    for (const s of scores) {
      assert.ok(s.staticBaseline >= 0 && s.staticBaseline <= 100,
        `${s.region} staticBaseline ${s.staticBaseline} out of [0, 100]`);
    }
  });

  it('server and frontend baseline/multiplier values match shared CII weights for every country', () => {
    const sharedCodes = Object.keys(CII_COUNTRY_WEIGHTS).sort();
    assert.deepEqual(Object.keys(CURATED_COUNTRIES).sort(), sharedCodes,
      'CURATED_COUNTRIES keys must match shared/cii-weights.ts keys');
    assert.deepEqual(Object.keys(TIER1_COUNTRIES).sort(), sharedCodes,
      'frontend TIER1_COUNTRIES keys must match shared/cii-weights.ts keys');
    assert.deepEqual(Object.keys(SERVER_TIER1_COUNTRIES).sort(), sharedCodes,
      'server _shared.ts TIER1_COUNTRIES keys must match shared/cii-weights.ts keys (computeCIIScores iterates this map)');

    const scores = computeCIIScores([], emptyAux());
    for (const code of sharedCodes) {
      const expected = CII_COUNTRY_WEIGHTS[code as keyof typeof CII_COUNTRY_WEIGHTS];
      assert.equal(CURATED_COUNTRIES[code]?.baselineRisk, expected.baselineRisk,
        `${code} frontend baselineRisk should come from shared/cii-weights.ts`);
      assert.equal(CURATED_COUNTRIES[code]?.eventMultiplier, expected.eventMultiplier,
        `${code} frontend eventMultiplier should come from shared/cii-weights.ts`);
      assert.equal(BASELINE_RISK[code], expected.baselineRisk,
        `${code} server BASELINE_RISK should come from shared/cii-weights.ts`);
      assert.equal(EVENT_MULTIPLIER[code], expected.eventMultiplier,
        `${code} server EVENT_MULTIPLIER should come from shared/cii-weights.ts`);
      assert.equal(SHARED_BASELINE_RISK[code as keyof typeof SHARED_BASELINE_RISK], expected.baselineRisk,
        `${code} shared baseline map should be derived from CII_COUNTRY_WEIGHTS`);
      assert.equal(SHARED_EVENT_MULTIPLIER[code as keyof typeof SHARED_EVENT_MULTIPLIER], expected.eventMultiplier,
        `${code} shared multiplier map should be derived from CII_COUNTRY_WEIGHTS`);

      const s = scoreFor(scores, code);
      assert.ok(s, `${code} score missing`);
      assert.equal(s!.staticBaseline, expected.baselineRisk,
        `${code} staticBaseline ${s!.staticBaseline} should match shared baselineRisk ${expected.baselineRisk}`);
      const actualMult = (s as unknown as { eventMultiplier: number }).eventMultiplier;
      assert.equal(actualMult, expected.eventMultiplier,
        `${code} eventMultiplier ${actualMult} should match shared eventMultiplier ${expected.eventMultiplier}`);
    }
  });

  // ===== Strategic risk roll-up (issue #3725) =====

  it('computeStrategicRisks: score is in [STRATEGIC_RISK_SCALE_FLOOR, 100]', () => {
    const scores = computeCIIScores([], emptyAux());
    const risks = computeStrategicRisks(scores);
    assert.equal(risks.length, 1);
    const score = risks[0]!.score;
    assert.ok(score >= STRATEGIC_RISK_SCALE_FLOOR && score <= 100,
      `strategic risk ${score} should be in [${STRATEGIC_RISK_SCALE_FLOOR}, 100]`);
  });

  it('computeStrategicRisks: equals STRATEGIC_RISK_SCALE_FLOOR (15) when all CII scores are 0', () => {
    const zeros = Array.from({ length: STRATEGIC_RISK_TOP_N }, (_, i) => ({
      region: `Z${i}`,
      staticBaseline: 0,
      dynamicScore: 0,
      combinedScore: 0,
      trend: 'TREND_DIRECTION_STABLE',
      components: { newsActivity: 0, ciiContribution: 0, geoConvergence: 0, militaryActivity: 0 },
      computedAt: 0,
    })) as unknown as ReturnType<typeof computeCIIScores>;
    const risks = computeStrategicRisks(zeros);
    assert.equal(risks[0]!.score, STRATEGIC_RISK_SCALE_FLOOR,
      `all-zero top-N should yield exactly STRATEGIC_RISK_SCALE_FLOOR (${STRATEGIC_RISK_SCALE_FLOOR}), got ${risks[0]!.score}`);
  });

  it('computeStrategicRisks: empty input does not throw and yields floor score', () => {
    const risks = computeStrategicRisks([]);
    assert.equal(risks.length, 1);
    assert.equal(risks[0]!.score, STRATEGIC_RISK_SCALE_FLOOR);
  });

  it('strategic risk uses positional decay 1 - i * 0.15 (top-5 weights = [1, 0.85, 0.7, 0.55, 0.4])', () => {
    // Two top entries with very different scores should produce a roll-up
    // score that respects the weighted-average — first slot heavier than
    // second by the declared decay step.
    const expected = [1, 0.85, 0.7, 0.55, 0.4];
    for (let i = 0; i < STRATEGIC_RISK_TOP_N; i++) {
      const w = 1 - i * STRATEGIC_RISK_POSITIONAL_DECAY;
      assert.ok(Math.abs(w - expected[i]!) < 1e-9,
        `position ${i} weight ${w} should equal ${expected[i]} given decay ${STRATEGIC_RISK_POSITIONAL_DECAY}`);
    }
    // STRATEGIC_RISK_SCALE_FACTOR sanity (used in the doc).
    assert.equal(STRATEGIC_RISK_SCALE_FACTOR, 0.7,
      `STRATEGIC_RISK_SCALE_FACTOR is documented as 0.7 — bump CII_FORMULA_VERSION and update docs/methodology/cii-risk-scores.mdx if changing.`);
  });

  it('region filter normalizes ISO2 input and omits global strategic risk', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const response = {
      ciiScores,
      strategicRisks: computeStrategicRisks(ciiScores),
    };

    const filtered = filterRiskScoresResponse(response, ' us ');
    assert.equal(filtered.ciiScores.length, 1);
    assert.equal(filtered.ciiScores[0]!.region, 'US');
    assert.deepEqual(filtered.strategicRisks, [],
      'country-filtered responses must not relabel the global strategic roll-up as country-scoped');
    assert.equal(response.ciiScores.length, ciiScores.length,
      'filtering is a post-cache projection and must not mutate the cached all-country payload');
    assert.equal(response.strategicRisks.length, 1);
  });

  it('region filter returns empty arrays for unknown ISO2 regions', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const filtered = filterRiskScoresResponse(
      { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) },
      'zz',
    );

    assert.deepEqual(filtered, { ciiScores: [], strategicRisks: [] });
  });

  it('region filter leaves empty requests on the all-country response and rejects malformed non-empty input', () => {
    const ciiScores = computeCIIScores([], emptyAux());
    const response = {
      ciiScores,
      strategicRisks: computeStrategicRisks(ciiScores),
    };

    assert.equal(filterRiskScoresResponse(response, '').ciiScores.length, ciiScores.length);
    assert.deepEqual(filterRiskScoresResponse(response, 'USA'), { ciiScores: [], strategicRisks: [] });
  });

  // ===== Methodology doc drift guard (issue #3725) =====

  it('docs/methodology/cii-risk-scores.mdx lists every CURATED_COUNTRIES code', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    const missing: string[] = [];
    for (const code of Object.keys(CURATED_COUNTRIES)) {
      // Match `| <CODE> |` in the per-country table.
      if (!new RegExp(`\\|\\s${code}\\s\\|`).test(doc)) missing.push(code);
    }
    assert.equal(missing.length, 0,
      `docs/methodology/cii-risk-scores.mdx is missing rows for: ${missing.join(', ')}. Update the methodology doc and bump CII_FORMULA_VERSION.`);
  });

  it('methodology doc baseline/multiplier columns match BASELINE_RISK and EVENT_MULTIPLIER exactly (numeric drift guard)', () => {
    // PR #3780 review hardening: the previous regex-existence check only
    // verified that a row exists for each code. That lets the doc and the
    // code silently disagree on the numeric values — exactly the kind of
    // drift this whole methodology disclosure was meant to prevent.
    //
    // This stricter test parses each row's numeric columns and asserts they
    // match BASELINE_RISK[code] and EVENT_MULTIPLIER[code] character-for-
    // character. Bump CII_FORMULA_VERSION and update the doc together when
    // either changes.
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    // Parse the per-country table. Rows look like:
    //   | AE | United Arab Emirates | 10 | 1.5 | — |
    // The first non-header table row defines the column count; we tolerate
    // any number of trailing columns (drift notes etc.) but require at least
    // 4 columns: code, name, baseline, multiplier.
    const drifts: string[] = [];
    for (const code of Object.keys(BASELINE_RISK)) {
      // Capture the row for this code. Anchor on `| <CODE> |` then non-greedy
      // up to end-of-line.
      const rowRe = new RegExp(`^\\|\\s${code}\\s\\|([^\\n]+)$`, 'm');
      const m = doc.match(rowRe);
      if (!m) {
        drifts.push(`${code}: no row in methodology doc`);
        continue;
      }
      // Split the remaining row on `|`, strip whitespace.
      const cols = m[1]!.split('|').map((c) => c.trim());
      // cols = [name, baseline, multiplier, driftNote, '']  (5 entries after split)
      // We need cols[1] and cols[2].
      if (cols.length < 4) {
        drifts.push(`${code}: malformed row, expected at least 4 columns, got ${cols.length}`);
        continue;
      }
      const docBaseline = Number(cols[1]);
      const docMultiplier = Number(cols[2]);
      const expectedBaseline = BASELINE_RISK[code]!;
      const expectedMultiplier = EVENT_MULTIPLIER[code]!;
      if (docBaseline !== expectedBaseline) {
        drifts.push(`${code}: baseline doc=${cols[1]} code=${expectedBaseline}`);
      }
      if (docMultiplier !== expectedMultiplier) {
        drifts.push(`${code}: multiplier doc=${cols[2]} code=${expectedMultiplier}`);
      }
    }
    assert.equal(drifts.length, 0,
      `methodology doc drift:\n  ${drifts.join('\n  ')}\nBump CII_FORMULA_VERSION and reconcile docs/methodology/cii-risk-scores.mdx with server BASELINE_RISK / EVENT_MULTIPLIER.`);
  });

  it('every TIER1_COUNTRIES code is listed in the methodology doc (server tables stay in sync)', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    const missing: string[] = [];
    for (const code of Object.keys(TIER1_COUNTRIES)) {
      if (!new RegExp(`\\|\\s${code}\\s\\|`).test(doc)) missing.push(code);
    }
    assert.equal(missing.length, 0,
      `docs/methodology/cii-risk-scores.mdx is missing rows for TIER1 codes: ${missing.join(', ')}.`);
  });

  it('methodology doc references the current CII_FORMULA_VERSION', () => {
    const docPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'docs',
      'methodology',
      'cii-risk-scores.mdx',
    );
    const doc = readFileSync(docPath, 'utf8');
    assert.ok(doc.includes(`**${CII_FORMULA_VERSION}**`) || doc.includes(`'${CII_FORMULA_VERSION}'`) || doc.includes(`"${CII_FORMULA_VERSION}"`),
      `methodology doc must mention current CII_FORMULA_VERSION '${CII_FORMULA_VERSION}' — bump the version and update the doc together.`);
  });

  it('public CII docs reference the current RPC route and backend-authoritative v3 conflict curve', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const methodologyDoc = readFileSync(resolve(root, 'docs', 'methodology', 'cii-risk-scores.mdx'), 'utf8');
    const algorithmsDoc = readFileSync(resolve(root, 'docs', 'algorithms.mdx'), 'utf8');

    assert.ok(
      methodologyDoc.includes('GET /api/intelligence/v1/get-risk-scores'),
      'methodology doc must point to the current get-risk-scores RPC route',
    );
    assert.doesNotMatch(
      methodologyDoc,
      /GET \/api\/intelligence\/risk-scores/,
      'methodology doc must not reference the retired pre-RPC CII route',
    );
    assert.match(
      algorithmsDoc,
      /Authoritative CII scores come from the server-side `GET \/api\/intelligence\/v1\/get-risk-scores` RPC/,
      'algorithms doc must identify the server RPC as the authoritative CII source',
    );
    assert.match(
      algorithmsDoc,
      /fallback\/local renderer path after cached backend scores/,
      'algorithms doc must describe frontend scoring as fallback/local rendering after cached backend scores',
    );
    assert.match(
      algorithmsDoc,
      /min\(70, log1p\(rawActivity\) \/ log1p\(4000\) \* 70\)/,
      'algorithms doc must publish the v3 conflict activity cap=70 curve',
    );
    assert.doesNotMatch(
      algorithmsDoc,
      /server-side score .* uses the same formulas as the frontend/i,
      'algorithms doc must not overclaim server/frontend formula parity',
    );
    assert.doesNotMatch(
      algorithmsDoc,
      /Weighted ACLED events .* capped at 50/i,
      'algorithms doc must not describe the server-authoritative v3 conflict activity cap as 50',
    );
  });

  it('public changelogs document the current CII_FORMULA_VERSION and cache impact', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const changelogs = [
      ['CHANGELOG.md', readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')],
      ['docs/changelog.mdx', readFileSync(resolve(root, 'docs', 'changelog.mdx'), 'utf8')],
    ] as const;

    for (const [label, changelog] of changelogs) {
      assert.match(
        changelog,
        new RegExp(`CII (?:methodology|formula)[^\\n]*${CII_FORMULA_VERSION}`),
        `${label} must publish the CII ${CII_FORMULA_VERSION} entry`,
      );
      assert.ok(
        changelog.includes('combinedScore') &&
        changelog.includes(`risk:scores:sebuf:${CII_FORMULA_VERSION}`) &&
        changelog.includes(`methodology_version`) &&
        changelog.includes(CII_FORMULA_VERSION),
        `${label} must describe combinedScore, cache-key, and methodology_version impact`,
      );
    }
  });

  it('public changelogs retain the CII v4 attribution/source semantics entry', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const changelogs = [
      ['CHANGELOG.md', readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')],
      ['docs/changelog.mdx', readFileSync(resolve(root, 'docs', 'changelog.mdx'), 'utf8')],
    ] as const;

    for (const [label, changelog] of changelogs) {
      const normalizedChangelog = changelog.replace(/\s+/g, ' ');
      assert.match(
        changelog,
        /CII (?:methodology|formula)[^\n]*`?v4`?/,
        `${label} must retain the CII v4 changelog entry`,
      );
      for (const requiredText of [
        'token exact-match',
        '4.5_week',
        'country-count map',
        'combinedScore',
        'risk:scores:sebuf:v4',
        'methodology_version',
      ]) {
        assert.ok(
          normalizedChangelog.includes(requiredText),
          `${label} CII v4 entry must mention ${requiredText}`,
        );
      }
    }
  });

  it('CII dynamicScore contract allows signed 24-hour movement deltas', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const proto = readFileSync(resolve(root, 'proto', 'worldmonitor', 'intelligence', 'v1', 'intelligence.proto'), 'utf8');
    const serviceOpenapi = readFileSync(resolve(root, 'docs', 'api', 'IntelligenceService.openapi.yaml'), 'utf8');
    const unifiedOpenapi = readFileSync(resolve(root, 'docs', 'api', 'worldmonitor.openapi.yaml'), 'utf8');

    assert.match(
      proto,
      /Approximate 24-hour score movement delta \(-100 to 100\)[\s\S]*double dynamic_score = 3 \[[\s\S]*double\.gte = -100,[\s\S]*double\.lte = 100/,
      'proto CiiScore.dynamic_score must be a signed 24-hour movement delta, not a non-negative real-time score',
    );
    for (const [label, yaml] of [
      ['IntelligenceService.openapi.yaml', serviceOpenapi],
      ['worldmonitor.openapi.yaml', unifiedOpenapi],
    ] as const) {
      const dynamicScoreBlock = yaml.match(/dynamicScore:\n(?: {20}.+\n)+/);
      assert.ok(dynamicScoreBlock, `${label} must expose CiiScore.dynamicScore`);
      assert.match(dynamicScoreBlock[0], /minimum: -100/, `${label} dynamicScore minimum must allow falling deltas`);
      assert.match(dynamicScoreBlock[0], /maximum: 100/, `${label} dynamicScore maximum must cap rising deltas`);
      assert.match(dynamicScoreBlock[0], /Approximate 24-hour score movement delta \(-100 to 100\)/, `${label} dynamicScore description must match proto semantics`);
      assert.doesNotMatch(dynamicScoreBlock[0], /Dynamic real-time score \(0-100\)/, `${label} must not retain stale non-negative dynamicScore prose`);
    }
  });

  it('current public CII docs do not reintroduce pre-v3 stale claims', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const publicDocPaths = [
      'docs/country-instability-index.mdx',
      'docs/strategic-risk.mdx',
      'docs/algorithms.mdx',
      'docs/overview.mdx',
      'docs/features.mdx',
      'docs/methodology/cii-risk-scores.mdx',
      'docs/Docs_To_Review/DOCUMENTATION.md',
      'docs/COMMUNITY-PROMOTION-GUIDE.md',
    ];
    const stalePatterns = [
      /\b(?:20|22|24)\s+(?:curated\s+)?(?:monitored\s+|strategically\s+significant\s+)?(?:Tier[- ]?1\s+)?(?:countries|nations)\b/i,
      /\b(?:20|22|24)\s+(?:curated\s+)?tier[- ]?1\b/i,
      /Information\s+score:\s+Reserved\s+\(0\)/i,
      /Information\s*\|\s*25%\s*\|\s*Reserved\s+\(0\)/i,
      /known\s+7-country\s+server\s+vs\s+frontend\s+drift/i,
      /relay\s+CII\s+seed\s+loop\s+is\s+disabled/i,
      /GPS[-/ ]only\s+security/i,
      /GPS\s+jamming\s+only/i,
      /dynamicScore[\s\S]{0,120}composite\s+−\s+staticBaseline/i,
      /dynamicScore[\s\S]{0,120}composite\s+-\s+staticBaseline/i,
      new RegExp(`\\bCII\\s+(?!${CII_FORMULA_VERSION}\\b)v\\d+\\s+(?:stability|stress|instability|scores?|formula)`, 'i'),
      new RegExp(`\\b(?:full|the)\\s+(?!${CII_FORMULA_VERSION}\\b)v\\d+\\s+formula\\b`, 'i'),
      new RegExp(`methodology_version\\s*\\(\\s*\`?(?!${CII_FORMULA_VERSION}\\b)v\\d+\`?\\s*\\)`, 'i'),
      /CII\s+v3\s+stability\s+scores/i,
      /real-time\s+CII\s+v3\s+instability\s+score/i,
      /Computes\s+CII\s+v3\s+scores/i,
      /Subsequent\s+changes\s+of\s+±5\s+points\s+trigger\s+trend\s+changes/i,
      /score\s+increased\s+by\s+at\s+least\s+5\s+points/i,
      /change\s+is\s+within\s+5\s+points/i,
      /score\s+decreased\s+by\s+at\s+least\s+5\s+points/i,
    ];

    const violations: string[] = [];
    for (const relPath of publicDocPaths) {
      const text = readFileSync(resolve(root, relPath), 'utf8');
      for (const pattern of stalePatterns) {
        if (pattern.test(text)) violations.push(`${relPath}: ${pattern}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `public CII docs contain pre-v3 stale claims:\n  ${violations.join('\n  ')}`,
    );
  });

  it('methodology doc and browser CII engine expose the current conflict curve coefficients', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const doc = readFileSync(resolve(root, 'docs', 'methodology', 'cii-risk-scores.mdx'), 'utf8');
    const browserSource = readFileSync(resolve(root, 'src', 'services', 'country-instability.ts'), 'utf8');

    assert.ok(
      doc.includes(`cap = ${CII_CONFLICT_ACTIVITY_CAP}`) && doc.includes(`pivot = ${CII_CONFLICT_ACTIVITY_PIVOT}`),
      'methodology doc must publish the current conflict activity curve cap and pivot',
    );
    assert.ok(
      browserSource.includes(`const CII_CONFLICT_ACTIVITY_CAP = ${CII_CONFLICT_ACTIVITY_CAP}`),
      'browser CII engine conflict activity cap must match server _risk-config.ts',
    );
    assert.ok(
      browserSource.includes(`const CII_CONFLICT_ACTIVITY_PIVOT = ${CII_CONFLICT_ACTIVITY_PIVOT}`),
      'browser CII engine conflict activity pivot must match server _risk-config.ts',
    );
  });

  it('risk-score Redis payload keys are derived from the CII formula version', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const source = readFileSync(
      resolve(root, 'server', 'worldmonitor', 'intelligence', 'v1', 'get-risk-scores.ts'),
      'utf8',
    );
    assert.match(
      source,
      /RISK_CACHE_KEY\s*=\s*`risk:scores:sebuf:\$\{CII_FORMULA_VERSION\}`/,
      `live CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
    assert.match(
      source,
      /RISK_STALE_CACHE_KEY\s*=\s*`risk:scores:sebuf:stale:\$\{CII_FORMULA_VERSION\}`/,
      `stale CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
    assert.match(
      source,
      /RISK_TREND_HISTORY_CACHE_KEY_PREFIX\s*=\s*`risk:scores:sebuf:trend-history:\$\{CII_FORMULA_VERSION\}`/,
      `trend-history CII cache key must derive from CII_FORMULA_VERSION ${CII_FORMULA_VERSION}`,
    );
  });

  it('downstream CII risk-score consumers use the current cache key family', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const expectedLiveKey = `risk:scores:sebuf:${CII_FORMULA_VERSION}`;
    const expectedStaleKey = `risk:scores:sebuf:stale:${CII_FORMULA_VERSION}`;
    const keyPattern = /risk:scores:sebuf(?::stale)?:v\d+/g;
    const consumers: Array<{ relPath: string; expectedKeys: string[] }> = [
      { relPath: 'api/bootstrap.js', expectedKeys: [expectedStaleKey] },
      { relPath: 'api/health.js', expectedKeys: [expectedStaleKey, expectedLiveKey] },
      { relPath: 'api/mcp/registry/cache-tools.ts', expectedKeys: [expectedStaleKey] },
      { relPath: 'server/_shared/cache-keys.ts', expectedKeys: [expectedStaleKey] },
      { relPath: 'server/worldmonitor/intelligence/v1/brief-story-context.ts', expectedKeys: [expectedStaleKey] },
      { relPath: 'server/worldmonitor/intelligence/v1/chat-analyst-context.ts', expectedKeys: [expectedStaleKey] },
      { relPath: 'server/worldmonitor/intelligence/v1/get-country-risk.ts', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/seed-cross-source-signals.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/seed-forecasts.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/regional-snapshot/balance-vector.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/regional-snapshot/evidence-collector.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/regional-snapshot/freshness.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'scripts/regional-snapshot/trigger-evaluator.mjs', expectedKeys: [expectedStaleKey] },
      { relPath: 'tests/mcp-bootstrap-parity.test.mjs', expectedKeys: [expectedLiveKey, expectedStaleKey] },
      { relPath: 'tests/regional-snapshot.test.mjs', expectedKeys: [expectedStaleKey] },
    ];

    const violations: string[] = [];
    for (const { relPath, expectedKeys } of consumers) {
      const source = readFileSync(resolve(root, relPath), 'utf8');
      for (const expectedKey of expectedKeys) {
        if (!source.includes(expectedKey)) violations.push(`${relPath}: missing ${expectedKey}`);
      }
      for (const match of source.matchAll(keyPattern)) {
        if (!expectedKeys.includes(match[0])) violations.push(`${relPath}: stale ${match[0]}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `CII risk-score cache consumers must track ${CII_FORMULA_VERSION}:\n  ${violations.join('\n  ')}`,
    );
  });

  it('legacy browser CII engine no longer carries the old compression formulas', () => {
    const sourcePath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'src',
      'services',
      'country-instability.ts',
    );
    const src = readFileSync(sourcePath, 'utf8');
    assert.ok(
      !src.includes('Math.min(60, h.eventsPoliticalViolence * 3 * multiplier)'),
      'browser HAPI fallback must not hard-cap moderate and extreme political-violence counts at the same value',
    );
    assert.ok(
      !src.includes('data.displacementOutflow >= 1_000_000 ? 8'),
      'browser displacement boost must not use the old +4/+8 two-tier scale',
    );
    assert.ok(
      !src.includes('20 * multiplier'),
      'browser news alert boost must not amplify salience with country eventMultiplier',
    );
  });
});
