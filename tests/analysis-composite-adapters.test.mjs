import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  earthquakesToExposureEvents,
  firesToExposureEvents,
  ucdpEventsToExposureEvents,
  riskScoresToCiiInput,
  surgesToDigestInput,
  cableHealthToDigestInput,
  outagesToDigestInput,
  anomaliesToDigestInput,
  thermalToDigestInput,
  stressToDigestInput,
  buildDigestInputs,
} from '../shared/analysis-composite-adapters.ts';

describe('exposure event adapters', () => {
  it('maps seeded earthquakes to exposure events', () => {
    const events = earthquakesToExposureEvents({
      earthquakes: [
        { id: 'q1', place: '10km N of Kabul', magnitude: 5.2, location: { latitude: 34.6, longitude: 69.2 }, occurredAt: 1 },
        { id: 'q2', place: '', magnitude: 4.0, location: { latitude: 0, longitude: 0 }, occurredAt: 2 },
        { broken: true },
      ],
    });
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { id: 'q1', name: '10km N of Kabul', type: 'earthquake', lat: 34.6, lon: 69.2 });
    assert.equal(events[1].name, 'M4 earthquake');
  });

  it('maps fire detections, ranked by radiative power, capped', () => {
    const fires = Array.from({ length: 60 }, (_, i) => ({
      id: `f${i}`, frp: i, region: 'Sahel',
      location: { latitude: 14 + i * 0.01, longitude: 0.1 },
      detectedAt: 1,
    }));
    const events = firesToExposureEvents({ fireDetections: fires }, 10);
    assert.equal(events.length, 10);
    assert.equal(events[0].id, 'f59', 'highest-FRP fire first');
    assert.equal(events[0].type, 'wildfire');
    assert.match(events[0].name, /Sahel/);
  });

  it('maps UCDP events to conflict exposure events, newest first', () => {
    const events = ucdpEventsToExposureEvents({
      events: [
        { id: 7, country: 'Sudan', location: { latitude: 15.5, longitude: 32.5 }, dateStart: '2026-07-20' },
        { id: 8, country: 'Mali', location: { latitude: 17.6, longitude: -4.0 }, dateStart: '2026-07-25' },
        { id: 9, country: 'Nowhere' },
      ],
    }, 5);
    assert.equal(events.length, 2);
    assert.equal(events[0].id, '8', 'newest first');
    assert.equal(events[0].type, 'conflict');
    assert.match(events[0].name, /Mali/);
  });

  it('returns [] for null payloads', () => {
    assert.deepEqual(earthquakesToExposureEvents(null), []);
    assert.deepEqual(firesToExposureEvents(undefined), []);
    assert.deepEqual(ucdpEventsToExposureEvents({}), []);
  });
});

describe('digest input adapters', () => {
  it('maps risk scores using the region/combinedScore fields and urgency bands', () => {
    const cii = riskScoresToCiiInput({
      scores: [
        { region: 'SD', combinedScore: 82 },
        { region: 'UA', combinedScore: 55 },
        { region: 'TN', combinedScore: 30 },
        { region: 'DE', combinedScore: 5 },
      ],
    });
    assert.deepEqual(cii, [
      { code: 'SD', score: 82, level: 'critical' },
      { code: 'UA', score: 55, level: 'high' },
      { code: 'TN', score: 30, level: 'medium' },
      { code: 'DE', score: 5, level: 'low' },
    ]);
  });

  it('accepts surges as a wrapped object or bare array', () => {
    const item = { theaterId: 'centcom', surgeType: 'fighter', surgeMultiple: 2.1, strikeCapable: true, extra: 1 };
    for (const payload of [{ surges: [item] }, [item]]) {
      const surges = surgesToDigestInput(payload);
      assert.equal(surges.length, 1);
      assert.equal(surges[0].theaterId, 'centcom');
      assert.equal(surges[0].strikeCapable, true);
    }
  });

  it('maps a cable health map keyed by cable id', () => {
    const cables = cableHealthToDigestInput({
      seamewe6: { status: 'CABLE_HEALTH_STATUS_FAULT', score: 0.9 },
      curie: { status: 'CABLE_HEALTH_STATUS_OK', score: 0.1 },
    });
    assert.deepEqual(cables.map((c) => c.name).sort(), ['curie', 'seamewe6']);
    assert.equal(cables.find((c) => c.name === 'seamewe6').status, 'CABLE_HEALTH_STATUS_FAULT');
  });

  it('mirrors the cross-source thermal spike rule (status or anomalyScore > 2)', () => {
    const thermal = thermalToDigestInput({
      clusters: [
        { id: 't1', name: 'Hormuz approaches', status: 'spike', anomalyScore: 1.1 },
        { id: 't2', region: 'Red Sea', anomalyScore: 2.5 },
        { id: 't3', name: 'Quiet zone', status: 'normal', anomalyScore: 0.4 },
      ],
    });
    const byId = Object.fromEntries(thermal.map((t) => [t.id, t.level]));
    assert.equal(byId.t1, 'high');
    assert.equal(byId.t2, 'high');
    assert.equal(byId.t3, 'low');
  });

  it('maps shipping stress fields', () => {
    assert.deepEqual(stressToDigestInput({ stressScore: 61, stressLevel: 'high', carriers: [] }), {
      index: 61,
      level: 'high',
    });
  });

  it('passes outages and anomalies through with picked fields', () => {
    const outages = outagesToDigestInput({ outages: [{ country: 'Sudan', severity: 'major', endedAt: 0, noise: 'x' }] });
    assert.deepEqual(Object.keys(outages[0]).sort(), ['country', 'detectedAt', 'endedAt', 'severity']);
    const anomalies = anomaliesToDigestInput({ anomalies: [{ type: 'news', region: 'EU', zScore: 2.2, severity: 'high' }] });
    assert.equal(anomalies[0].type, 'news');
  });

  it('buildDigestInputs propagates nulls as unavailable domains', () => {
    const inputs = buildDigestInputs({
      riskScores: { scores: [{ region: 'SD', combinedScore: 80 }] },
      surges: null,
      cableHealth: null,
      outages: { outages: [] },
      temporal: { anomalies: [] },
      thermal: null,
      stress: null,
    });
    assert.equal(inputs.cii.length, 1);
    assert.equal(inputs.militarySurges, null);
    assert.equal(inputs.cables, null);
    assert.deepEqual(inputs.outages, []);
    assert.equal(inputs.shippingStress, null);
  });
});
