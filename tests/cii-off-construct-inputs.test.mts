// Rule I1 of the CII review (docs/methodology/cii-change-brief.md §0): an
// input scores only if it measures an event or condition inside the country
// that affects its order. docs/methodology/cii-input-register.md marks these
// seven inputs **remove**:
//   sanctions entry counts, climate anomalies, FIRMS fires, foreign military
//   flights, foreign military vessels, GPS jamming and aviation delay alerts;
// and two more **context** (shown beside the score, never scored): earthquakes
// (a natural hazard) and AIS disruptions (station density).
// Each test feeds one of them at the raw-input level (what the Redis reads
// return), so parsing, attribution and scoring are all covered. Each test
// either amplifies the input in every Tier-1 country or removes it, and
// requires every country's blend and score to stay unchanged on every
// committed fixture.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadCiiFixtures, type CiiFixture } from '../scripts/lib/cii-fixtures.mts';
import { computeCiiScoreTable, type CiiRawInputs } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import { CII_CLIMATE_ZONE_COUNTRIES } from '../shared/cii-climate-zones.ts';

const FIXTURES = loadCiiFixtures();
const CODES = Object.keys(TIER1_COUNTRIES).sort();
type Obj = Record<string, any>;

function table(f: CiiFixture, inputs: CiiRawInputs) {
  const rows = computeCiiScoreTable(inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled }).rows;
  return Object.fromEntries(rows.map((r) => [r.region, { blended: Math.round(r.blended * 1e6) / 1e6, combinedScore: r.combinedScore }]));
}

/** Countries whose blend or score differs from the fixture's own table, as "XX 41.2→47.0". */
function moved(f: CiiFixture, inputs: CiiRawInputs): string[] {
  const base = table(f, f.inputs);
  const next = table(f, inputs);
  return CODES.filter((c) => base[c]!.blended !== next[c]!.blended || base[c]!.combinedScore !== next[c]!.combinedScore)
    .map((c) => `${c} ${base[c]!.blended.toFixed(1)}→${next[c]!.blended.toFixed(1)}`);
}

const name = (code: string) => TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES];

/** Each removed input, amplified in every Tier-1 country. */
const AMPLIFIED: Record<string, (inputs: Obj) => Obj> = {
  'sanctions entry counts': (inputs) => ({
    ...inputs,
    sanctionsCounts: Object.fromEntries(CODES.map((c) => [c, 2500])),
    sanctionsPressure: { countries: CODES.map((c) => ({ countryCode: c, entryCount: 2500, newEntryCount: 5 })) },
  }),
  'climate anomalies': (inputs) => ({
    ...inputs,
    climate: { anomalies: Object.keys(CII_CLIMATE_ZONE_COUNTRIES).map((zone) => ({ zone, severity: 'ANOMALY_SEVERITY_EXTREME' })) },
  }),
  'FIRMS fires': (inputs) => ({
    ...inputs,
    fires: {
      ...inputs.fires,
      byCountry: Object.fromEntries(CODES.map((c) => [c, [
        ...(inputs.fires?.byCountry?.[c] ?? []),
        ...Array.from({ length: 20 }, () => ({ brightness: 400, frp: 80 })),
      ]])),
    },
  }),
  'GPS jamming': (inputs) => ({
    ...inputs,
    // Five more high hexes at every jammed location the fixture already places in a Tier-1 country.
    gpsjam: { hexes: (inputs.gpsjam?.hexes ?? []).flatMap((h: Obj) => Array.from({ length: 6 }, () => ({ ...h, level: 'high' }))) },
  }),
  'aviation delay alerts': (inputs) => ({
    ...inputs,
    aviation: { alerts: [...(inputs.aviation?.alerts ?? []), ...CODES.flatMap((c) => Array.from({ length: 10 }, () => ({ country: name(c), delayType: 'closure', severity: 'severe' })))] },
  }),
  'foreign military flights': (inputs) => ({
    ...inputs,
    militaryCii: { byCountry: Object.fromEntries(CODES.map((c) => {
      const m = inputs.militaryCii?.byCountry?.[c] ?? {};
      return [c, { ...m, foreignFlights: Number(m.foreignFlights ?? 0) + 10 }];
    })) },
  }),
  earthquakes: (inputs) => ({
    ...inputs,
    // A magnitude 7.6 quake an hour before the build, at each country's own reported place.
    earthquakes: { earthquakes: [...(inputs.earthquakes?.earthquakes ?? []), ...CODES.map((c) => ({
      magnitude: 7.6, occurredAt: inputs.__nowMs - 3_600_000, place: `10 km N of somewhere, ${name(c)}`, location: { latitude: -89, longitude: 0 },
    }))] },
  }),
  'AIS disruptions': (inputs) => ({
    ...inputs,
    militaryCii: { byCountry: Object.fromEntries(CODES.map((c) => {
      const m = inputs.militaryCii?.byCountry?.[c] ?? {};
      return [c, { ...m, aisDisruptionHigh: Number(m.aisDisruptionHigh ?? 0) + 4 }];
    })) },
  }),
  'foreign military vessels': (inputs) => ({
    ...inputs,
    militaryCii: { byCountry: Object.fromEntries(CODES.map((c) => {
      const m = inputs.militaryCii?.byCountry?.[c] ?? {};
      return [c, { ...m, foreignVessels: Number(m.foreignVessels ?? 0) + 10 }];
    })) },
  }),
};

/** Each removed input, as if its key were missing. Military presence shares a key with AIS disruptions, which stay. */
const REMOVED: Record<string, (inputs: Obj) => Obj> = {
  'sanctions entry counts': (inputs) => ({ ...inputs, sanctionsCounts: null, sanctionsPressure: null }),
  'climate anomalies': (inputs) => ({ ...inputs, climate: null }),
  'FIRMS fires': (inputs) => ({ ...inputs, fires: null }),
  'GPS jamming': (inputs) => ({ ...inputs, gpsjam: null }),
  'aviation delay alerts': (inputs) => ({ ...inputs, aviation: null }),
  earthquakes: (inputs) => ({ ...inputs, earthquakes: null }),
  'AIS disruptions': (inputs) => ({ ...inputs, militaryCii: null }),
  // Already covered by 'AIS disruptions' (the whole key missing); kept for the flight and vessel counts alone.
  'foreign military flights and vessels': (inputs) => ({
    ...inputs,
    militaryCii: inputs.militaryCii && { byCountry: Object.fromEntries(Object.entries(inputs.militaryCii.byCountry ?? {})
      .map(([c, m]) => [c, { ...(m as Obj), ownFlights: 0, foreignFlights: 0, ownVessels: 0, foreignVessels: 0 }])) },
  }),
};

describe('CII inputs the register removes move no score (rule I1)', () => {
  for (const [input, amplify] of Object.entries(AMPLIFIED)) {
    it(`more ${input} in every country leave every blend and score unchanged`, () => {
      for (const f of FIXTURES) {
        const inputs = amplify({ ...structuredClone(f.inputs) as Obj, __nowMs: f.nowMs });
        delete inputs.__nowMs;
        assert.deepEqual(moved(f, inputs as CiiRawInputs), [], `${f.label}: ${input} moved`);
      }
    });
  }
  for (const [input, remove] of Object.entries(REMOVED)) {
    it(`removing ${input} leaves every blend and score unchanged`, () => {
      for (const f of FIXTURES) {
        assert.deepEqual(moved(f, remove(structuredClone(f.inputs) as Obj) as CiiRawInputs), [], `${f.label}: ${input} moved`);
      }
    });
  }

  it('control: the same check detects an in-construct input (critical headlines naming each country)', () => {
    for (const f of FIXTURES) {
      const inputs = structuredClone(f.inputs) as Obj;
      inputs.newsInsights = { topStories: [...(inputs.newsInsights?.topStories ?? []),
        ...CODES.flatMap((c) => Array.from({ length: 10 }, () => ({ countryCode: c, countryCodes: [c], threatLevel: 'critical', primaryTitle: '' })))] };
      assert.ok(moved(f, inputs as CiiRawInputs).length >= 20, `${f.label}: headlines should move most countries`);
    }
  });
});
