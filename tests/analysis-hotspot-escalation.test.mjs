import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPONENT_WEIGHTS,
  HISTORY_WINDOW_MS,
  MAX_HISTORY_POINTS,
  SIGNAL_COOLDOWN_MS,
  blendScores,
  calculateDynamicRaw,
  computeComponents,
  computeEscalationChange,
  computeEscalationScore,
  countMilitaryNearHotspot,
  detectTrend,
  evaluateEscalationSignal,
  findHotspotById,
  getStaticBaseline,
  haversineKm,
  normalizeCII,
  normalizeGeo,
  normalizeMilitary,
  normalizeNewsActivity,
  pruneHistory,
  rawToScore,
} from '../shared/analysis-hotspot-escalation.ts';
import { CONFLICT_ZONES, INTEL_HOTSPOTS, STRATEGIC_WATERWAYS } from '../shared/geo-data.ts';
import { getHotspotCountryScore } from '../shared/hotspot-country-map.ts';
import * as clientGeo from '../src/config/geo.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Fixed clock so every score/trend assertion is reproducible. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

const FIXTURE_HOTSPOT = {
  id: 'fixture-theater',
  name: 'Fixture Theater',
  lat: 25,
  lon: 55,
  keywords: ['fixture'],
  escalationScore: 4,
};

const QUIET_INPUTS = {
  newsMatches: 0,
  hasBreaking: false,
  newsVelocity: 0,
  ciiScore: null,
  geoAlertScore: 0,
  geoAlertTypes: 0,
  flightsNearby: 0,
  vesselsNearby: 0,
};

describe('hotspot country score mapping', () => {
  it('uses the maximum available score for regional hotspots', () => {
    const scores = new Map([['ML', 44], ['NE', null], ['BF', 71]]);
    assert.equal(getHotspotCountryScore('sahel', (code) => scores.get(code) ?? null), 71);
    assert.equal(getHotspotCountryScore('pak_afghan', (code) => ({ PK: 66, AF: 82 })[code] ?? null), 82);
  });

  it('returns null when no mapped country has a score', () => {
    assert.equal(getHotspotCountryScore('sahel', () => null), null);
    assert.equal(getHotspotCountryScore('not-a-hotspot', () => 99), null);
  });
});

describe('hotspot escalation component normalization', () => {
  it('weights the four components at 0.35 / 0.25 / 0.25 / 0.15', () => {
    assert.deepEqual(COMPONENT_WEIGHTS, { news: 0.35, cii: 0.25, geo: 0.25, military: 0.15 });
    const total = COMPONENT_WEIGHTS.news + COMPONENT_WEIGHTS.cii + COMPONENT_WEIGHTS.geo + COMPONENT_WEIGHTS.military;
    assert.equal(total, 1);
  });

  it('scores news activity from match count, breaking flag and velocity', () => {
    assert.equal(normalizeNewsActivity(0, false, 0), 0);
    assert.equal(normalizeNewsActivity(2, false, 0), 30);
    assert.equal(normalizeNewsActivity(2, true, 0), 60);
    assert.equal(normalizeNewsActivity(2, true, 1), 65);
  });

  it('substitutes a neutral 30 when CII is unavailable', () => {
    assert.equal(normalizeCII(null), 30);
    assert.equal(normalizeCII(0), 0);
    assert.equal(normalizeCII(72), 72);
  });

  it('returns zero geo convergence when no alert scored, and adds 10 per alert type otherwise', () => {
    assert.equal(normalizeGeo(0, 0), 0);
    assert.equal(normalizeGeo(0, 5), 0, 'alert types alone must not manufacture convergence');
    assert.equal(normalizeGeo(40, 2), 60);
  });

  it('weights vessels heavier than flights for military activity', () => {
    assert.equal(normalizeMilitary(0, 0), 0);
    assert.equal(normalizeMilitary(3, 1), 45);
  });

  it('clamps every normalized component at 100', () => {
    assert.equal(normalizeNewsActivity(100, true, 100), 100);
    assert.equal(normalizeGeo(95, 5), 100);
    assert.equal(normalizeMilitary(20, 20), 100);
  });

  it('applies the weights to produce the raw 0-100 composite', () => {
    const raw = calculateDynamicRaw({
      newsActivity: 65,
      ciiContribution: 80,
      geoConvergence: 60,
      militaryActivity: 45,
    });
    assert.equal(raw, 64.5);
  });

  it('maps the raw 0-100 composite onto the published 1-5 scale', () => {
    assert.equal(rawToScore(0), 1);
    assert.equal(rawToScore(100), 5);
    assert.equal(rawToScore(50), 3);
  });

  it('blends the static baseline and dynamic score 30/70', () => {
    assert.equal(blendScores(5, 5), 5);
    assert.equal(blendScores(1, 1), 1);
    assert.equal(Math.round(blendScores(4, 3.58) * 1000) / 1000, 3.706);
  });

  it('falls back to a baseline of 3 for hotspots with no curated escalationScore', () => {
    assert.equal(getStaticBaseline({ escalationScore: 5 }), 5);
    assert.equal(getStaticBaseline({}), 3);
  });
});

describe('hotspot escalation scoring', () => {
  it('computes a full score from injected inputs with no ambient clock', () => {
    const result = computeEscalationScore(
      FIXTURE_HOTSPOT,
      {
        newsMatches: 2,
        hasBreaking: true,
        newsVelocity: 1,
        ciiScore: 80,
        geoAlertScore: 40,
        geoAlertTypes: 2,
        flightsNearby: 3,
        vesselsNearby: 1,
      },
      { now: NOW },
    );

    assert.equal(result.hotspotId, 'fixture-theater');
    assert.equal(result.staticBaseline, 4);
    assert.deepEqual(result.components, {
      newsActivity: 65,
      ciiContribution: 80,
      geoConvergence: 60,
      militaryActivity: 45,
    });
    assert.equal(result.dynamicScore, 3.6);
    assert.equal(result.combinedScore, 3.7);
    assert.equal(result.trend, 'stable', 'a first observation has too little history for a trend');
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].timestamp, NOW);
    assert.equal(
      Math.round(result.history[0].score * 1000) / 1000,
      3.706,
      'history keeps the unrounded blended score',
    );
    assert.equal(result.lastUpdated.getTime(), NOW);
  });

  it('is deterministic — identical inputs and clock produce an identical score', () => {
    const options = { now: NOW };
    const first = computeEscalationScore(FIXTURE_HOTSPOT, QUIET_INPUTS, options);
    const second = computeEscalationScore(FIXTURE_HOTSPOT, QUIET_INPUTS, options);
    assert.deepEqual(second, first);
  });

  it('treats a missing CII reading as the neutral 30 rather than dropping the component', () => {
    const withoutCii = computeEscalationScore(FIXTURE_HOTSPOT, QUIET_INPUTS, { now: NOW });
    const withNeutralCii = computeEscalationScore(
      FIXTURE_HOTSPOT,
      { ...QUIET_INPUTS, ciiScore: 30 },
      { now: NOW },
    );
    assert.equal(withoutCii.components.ciiContribution, 30);
    assert.equal(withoutCii.combinedScore, withNeutralCii.combinedScore);
  });

  it('clamps the combined score inside the 1-5 band at both extremes', () => {
    const floor = computeEscalationScore(
      { id: 'floor', lat: 0, lon: 0, escalationScore: 1 },
      { ...QUIET_INPUTS, ciiScore: 0 },
      { now: NOW },
    );
    assert.equal(floor.combinedScore, 1);

    const ceiling = computeEscalationScore(
      { id: 'ceiling', lat: 0, lon: 0, escalationScore: 5 },
      {
        newsMatches: 50,
        hasBreaking: true,
        newsVelocity: 50,
        ciiScore: 100,
        geoAlertScore: 100,
        geoAlertTypes: 9,
        flightsNearby: 50,
        vesselsNearby: 50,
      },
      { now: NOW },
    );
    assert.equal(ceiling.combinedScore, 5);
    assert.deepEqual(ceiling.components, {
      newsActivity: 100,
      ciiContribution: 100,
      geoConvergence: 100,
      militaryActivity: 100,
    });
  });

  it('appends to prior history and drops observations older than the 24h window', () => {
    const previousHistory = [
      { timestamp: NOW - HISTORY_WINDOW_MS - 1, score: 1 },
      { timestamp: NOW - 2 * HOUR_MS, score: 2 },
    ];
    const result = computeEscalationScore(FIXTURE_HOTSPOT, QUIET_INPUTS, { now: NOW, previousHistory });
    assert.equal(result.history.length, 2);
    assert.equal(result.history[0].timestamp, NOW - 2 * HOUR_MS);
    assert.equal(result.history[1].timestamp, NOW);
    assert.equal(previousHistory.length, 2, 'the caller-supplied history must not be mutated');
  });

  it('derives an escalating trend from a rising history', () => {
    let history;
    let result;
    for (let i = 0; i < 4; i++) {
      result = computeEscalationScore(
        FIXTURE_HOTSPOT,
        { ...QUIET_INPUTS, newsMatches: i * 2 },
        { now: NOW + i * HOUR_MS, previousHistory: history },
      );
      history = result.history;
    }
    assert.equal(result.trend, 'escalating');
  });
});

describe('hotspot escalation history and trend', () => {
  it('prunes to the 24h window against an injected clock', () => {
    const history = [
      { timestamp: NOW - HISTORY_WINDOW_MS - 1, score: 1 },
      { timestamp: NOW - HISTORY_WINDOW_MS, score: 2 },
      { timestamp: NOW, score: 3 },
    ];
    assert.deepEqual(
      pruneHistory(history, NOW).map((point) => point.score),
      [2, 3],
    );
  });

  it('caps retained history at MAX_HISTORY_POINTS, keeping the newest', () => {
    const history = Array.from({ length: MAX_HISTORY_POINTS + 10 }, (_, i) => ({
      timestamp: NOW - (MAX_HISTORY_POINTS + 10 - i) * 60_000,
      score: i,
    }));
    const pruned = pruneHistory(history, NOW);
    assert.equal(pruned.length, MAX_HISTORY_POINTS);
    assert.equal(pruned[pruned.length - 1].score, MAX_HISTORY_POINTS + 9);
  });

  it('reports stable below three history points', () => {
    assert.equal(detectTrend([]), 'stable');
    assert.equal(detectTrend([{ timestamp: 1, score: 1 }]), 'stable');
    assert.equal(detectTrend([{ timestamp: 1, score: 1 }, { timestamp: 2, score: 5 }]), 'stable');
  });

  it('classifies the regression slope into the three published trend tokens', () => {
    const at = (scores) => scores.map((score, i) => ({ timestamp: NOW + i * HOUR_MS, score }));
    assert.equal(detectTrend(at([1, 2, 3])), 'escalating');
    assert.equal(detectTrend(at([3, 2, 1])), 'de-escalating');
    assert.equal(detectTrend(at([2, 2, 2])), 'stable');
    assert.equal(detectTrend(at([2, 2.05, 2.1])), 'stable', 'a slope inside +/-0.1 stays stable');
  });

  it('reports the 24h change between the oldest in-window and newest observation', () => {
    const history = [
      { timestamp: NOW - 3 * HOUR_MS, score: 2.14 },
      { timestamp: NOW - HOUR_MS, score: 2.9 },
      { timestamp: NOW, score: 3.46 },
    ];
    assert.deepEqual(computeEscalationChange(history, NOW), { change: 1.3, start: 2.1, end: 3.5 });
  });

  it('returns null when there is not enough history to compute a change', () => {
    assert.equal(computeEscalationChange([], NOW), null);
    assert.equal(computeEscalationChange([{ timestamp: NOW, score: 3 }], NOW), null);
  });
});

describe('hotspot escalation signal gating', () => {
  const base = { lastSignalAt: 0, now: NOW };

  it('never signals without a prior score to compare against', () => {
    assert.equal(evaluateEscalationSignal({ ...base, oldScore: null, newScore: 5 }), null);
  });

  it('suppresses signals inside the two-hour cooldown', () => {
    assert.equal(
      evaluateEscalationSignal({ oldScore: 1, newScore: 5, lastSignalAt: NOW - SIGNAL_COOLDOWN_MS + 1, now: NOW }),
      null,
    );
    assert.ok(
      evaluateEscalationSignal({ oldScore: 1, newScore: 5, lastSignalAt: NOW - SIGNAL_COOLDOWN_MS, now: NOW }),
      'a signal is allowed once the cooldown has fully elapsed',
    );
  });

  it('reports a threshold crossing when the integer band increases', () => {
    assert.deepEqual(evaluateEscalationSignal({ ...base, oldScore: 2.9, newScore: 3.1 }), {
      type: 'threshold_crossed',
      oldScore: 2.9,
      newScore: 3.1,
      threshold: 3,
    });
  });

  it('reports a rapid increase inside a single band', () => {
    assert.deepEqual(evaluateEscalationSignal({ ...base, oldScore: 1.1, newScore: 1.7 }), {
      type: 'rapid_increase',
      oldScore: 1.1,
      newScore: 1.7,
    });
  });

  it('reports the critical threshold on a small move across 4.5', () => {
    assert.deepEqual(evaluateEscalationSignal({ ...base, oldScore: 4.4, newScore: 4.6 }), {
      type: 'critical_reached',
      oldScore: 4.4,
      newScore: 4.6,
    });
  });

  it('stays silent on a flat or falling score', () => {
    assert.equal(evaluateEscalationSignal({ ...base, oldScore: 3.2, newScore: 3.2 }), null);
    assert.equal(evaluateEscalationSignal({ ...base, oldScore: 3.2, newScore: 2.4 }), null);
  });
});

describe('military proximity counting', () => {
  it('measures great-circle distance in kilometres', () => {
    assert.equal(Math.round(haversineKm(0, 0, 0, 1)), 111);
    assert.equal(haversineKm(25, 55, 25, 55), 0);
  });

  it('counts only flights and vessels inside the radius', () => {
    const counts = countMilitaryNearHotspot(
      FIXTURE_HOTSPOT,
      [
        { lat: 25.1, lon: 55.1 },
        { lat: 45, lon: 55 },
      ],
      [{ lat: 24.9, lon: 54.9 }, { lat: -30, lon: 10 }],
      200,
    );
    assert.deepEqual(counts, { flights: 1, vessels: 1 });
  });

  it('defaults to a 200km radius', () => {
    const near = [{ lat: 26.5, lon: 55 }];
    assert.deepEqual(countMilitaryNearHotspot(FIXTURE_HOTSPOT, near, []), { flights: 1, vessels: 0 });
    assert.deepEqual(countMilitaryNearHotspot(FIXTURE_HOTSPOT, near, [], 100), { flights: 0, vessels: 0 });
  });
});

describe('shared curated geo datasets', () => {
  it('publishes the 29 curated intel hotspots with unique ids and valid coordinates', () => {
    assert.equal(INTEL_HOTSPOTS.length, 29);
    const ids = INTEL_HOTSPOTS.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, 'hotspot ids must be unique');
    for (const hotspot of INTEL_HOTSPOTS) {
      assert.ok(hotspot.id && hotspot.name, `hotspot ${hotspot.id} needs an id and a name`);
      assert.ok(Array.isArray(hotspot.keywords) && hotspot.keywords.length > 0, `${hotspot.id} needs keywords`);
      assert.ok(hotspot.lat >= -90 && hotspot.lat <= 90, `${hotspot.id} lat in range`);
      assert.ok(hotspot.lon >= -180 && hotspot.lon <= 180, `${hotspot.id} lon in range`);
      if (hotspot.escalationScore !== undefined) {
        assert.ok(
          Number.isInteger(hotspot.escalationScore) && hotspot.escalationScore >= 1 && hotspot.escalationScore <= 5,
          `${hotspot.id} escalationScore must be 1-5`,
        );
      }
    }
  });

  it('every curated hotspot is resolvable by id and scoreable', () => {
    for (const hotspot of INTEL_HOTSPOTS) {
      assert.equal(findHotspotById(hotspot.id), hotspot);
      const score = computeEscalationScore(hotspot, QUIET_INPUTS, { now: NOW });
      assert.ok(score.combinedScore >= 1 && score.combinedScore <= 5, `${hotspot.id} score inside 1-5`);
    }
    assert.equal(findHotspotById('no-such-hotspot'), undefined);
  });

  it('publishes 13 strategic waterways keyed 1:1 with the chokepoint registry', () => {
    assert.equal(STRATEGIC_WATERWAYS.length, 13);
    const ids = STRATEGIC_WATERWAYS.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length, 'waterway ids must be unique');
    for (const waterway of STRATEGIC_WATERWAYS) {
      assert.equal(waterway.chokepointId, waterway.id, `${waterway.id} chokepointId must mirror id`);
      assert.ok(waterway.name, `${waterway.id} needs a name`);
      assert.ok(waterway.lat >= -90 && waterway.lat <= 90, `${waterway.id} lat in range`);
      assert.ok(waterway.lon >= -180 && waterway.lon <= 180, `${waterway.id} lon in range`);
    }
  });

  it('publishes conflict zones with a valid [lon, lat] ring and centre', () => {
    assert.equal(CONFLICT_ZONES.length, 10);
    const ids = CONFLICT_ZONES.map((z) => z.id);
    assert.equal(new Set(ids).size, ids.length, 'conflict zone ids must be unique');
    for (const zone of CONFLICT_ZONES) {
      assert.ok(zone.name, `${zone.id} needs a name`);
      // Rings are [lon, lat] and are NOT all explicitly closed — gaza and
      // south_lebanon are bare 4-point rectangles the renderer closes itself.
      assert.ok(zone.coords.length >= 3, `${zone.id} needs at least 3 ring points`);
      for (const [lon, lat] of zone.coords) {
        assert.ok(lat >= -90 && lat <= 90, `${zone.id} ring lat in range`);
        assert.ok(lon >= -180 && lon <= 180, `${zone.id} ring lon in range`);
      }
      const [centerLon, centerLat] = zone.center;
      assert.ok(centerLat >= -90 && centerLat <= 90, `${zone.id} centre lat in range`);
      assert.ok(centerLon >= -180 && centerLon <= 180, `${zone.id} centre lon in range`);
    }
  });

  it('src/config/geo.ts re-exports the shared datasets by identity', () => {
    assert.equal(clientGeo.INTEL_HOTSPOTS, INTEL_HOTSPOTS);
    assert.equal(clientGeo.CONFLICT_ZONES, CONFLICT_ZONES);
    assert.equal(clientGeo.STRATEGIC_WATERWAYS, STRATEGIC_WATERWAYS);
    assert.deepEqual(Object.keys(clientGeo).sort(), ['CONFLICT_ZONES', 'INTEL_HOTSPOTS', 'STRATEGIC_WATERWAYS']);
  });
});
