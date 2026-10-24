// ACLED is an optional, licence-holder CII source (self-hosters and desktop
// users with an ACLED licence; WorldMonitor production has none). It must act
// per country: when a country has ACLED rows, Conflict and Unrest take the
// larger of its ACLED term and its GDELT term, never their sum, and no other
// country moves. Two defects this guards against:
// - a global regime switch: one ACLED row anywhere turned the GDELT Conflict,
//   Unrest and strike terms off for all 31 countries (FR -11, YE -9, UA -5 on
//   the committed fixtures);
// - eventMultiplier, a per-country editorial weight on ACLED events whose
//   compressed branch below 0.7 outscored its linear one.
// See docs/methodology/cii-change-brief.md section 1 (no regime switch with
// global side effects) and docs/methodology/cii-input-register.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { loadCiiFixtures, scoreCiiFixture } from '../scripts/lib/cii-fixtures.mts';
import {
  assessCiiInputAvailability,
  computeCIIScores,
  gdeltCountryEventsFromSeed,
  gdeltStrikeDays,
  scoreCiiAuxiliarySources,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = loadCiiFixtures();
const CODES = Object.keys(TIER1_COUNTRIES);
const ACLED_TYPES = ['Protests', 'Riots', 'Battles', 'Explosions/Remote violence', 'Violence against civilians'];

type AcledRow = { country: string; event_type: string; fatalities: number; daysAgo?: number };
const row = (code: string, event_type: string, fatalities = 0, daysAgo = 1): AcledRow => ({
  country: TIER1_COUNTRIES[code as keyof typeof TIER1_COUNTRIES], event_type, fatalities, daysAgo,
});

// Parsing a fixture is the slow part: do it once per fixture.
const FIXTURE_AUX = new Map(FIXTURES.map((f) => [f.label, scoreCiiFixture(f).aux]));
function table(fixture: (typeof FIXTURES)[number], acledEvents: AcledRow[]) {
  return scoreCiiAuxiliarySources(FIXTURE_AUX.get(fixture.label)!, { nowMs: fixture.nowMs, acledEvents });
}
/** No input at all, with live empty advisories so no fallback floor applies. */
function quietAux(extra: Record<string, unknown> = {}): any {
  return {
    ucdpEvents: [], outages: [], climate: [], fires: {}, gpsHexes: [], iranEvents: [], orefData: null,
    advisories: { byCountry: {} }, displacedByIso3: {}, crossBorderSurgeCountries: [], newsTopStories: [],
    threatSummaryByCountry: null, aviationAlerts: [], earthquakes: [], sanctionsCountries: [],
    sanctionsCountryCounts: null, temporalAnomalies: [], militaryCii: null, gdeltCountryEvents: null,
    confirmedStrikes: null, ...extra,
  };
}
const byRegion = <T extends { region: string }>(rows: T[]) => new Map(rows.map((r) => [r.region, r]));

/** Every identifier, string literal and module specifier in a file; comments are not tokens. */
function sourceFile(path: string) {
  return ts.createSourceFile(path, readFileSync(resolve(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true);
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('CII ACLED is per country: an optional source that never gates another country', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.label}: one ACLED row in BR moves only BR; the other 30 countries keep every term`, () => {
      const base = byRegion(table(fixture, []).rows);
      const withRow = table(fixture, [row('BR', 'Protests')]).rows;
      const moved = withRow
        .filter((r) => r.region !== 'BR' && JSON.stringify(r) !== JSON.stringify(base.get(r.region)))
        .map((r) => `${r.region} ${base.get(r.region)!.combinedScore} -> ${r.combinedScore}`);
      assert.deepEqual(moved, [], 'an ACLED row for BR must not change any other country');
    });

    it(`${fixture.label}: adding ACLED rows never lowers any country's score`, () => {
      const base = byRegion(table(fixture, []).rows);
      // Every type in every country, with and without deaths: Conflict and
      // Unrest take max(ACLED, GDELT), so evidence can only add.
      const rows = CODES.flatMap((code) => ACLED_TYPES.flatMap((type) => [row(code, type), row(code, type, 3, 12)]));
      for (const r of table(fixture, rows).rows) {
        const before = base.get(r.region)!;
        assert.ok(r.combinedScore >= before.combinedScore, `${r.region} ${before.combinedScore} -> ${r.combinedScore}`);
        assert.ok(r.components.conflict >= before.components.conflict, `${r.region} conflict fell`);
        assert.ok(r.components.unrest >= before.components.unrest, `${r.region} unrest fell`);
      }
    });

    it(`${fixture.label}: no ACLED credential reports not_configured and changes no score`, () => {
      const aux = FIXTURE_AUX.get(fixture.label)!;
      assert.equal(assessCiiInputAvailability([], aux, fixture.nowMs, false).acled, 'not_configured');
      assert.equal(assessCiiInputAvailability([], aux, fixture.nowMs, true).acled, 'quiet');
      const expected = fixture.expected[Object.keys(fixture.expected).at(-1)!]!;
      for (const r of table(fixture, []).rows) assert.equal(r.combinedScore, expected[r.region]!.combinedScore, r.region);
    });
  }

  it('more ACLED events or deaths never lower the ACLED term, in any country, for any type', () => {
    const quiet = quietAux();
    const parts = (rows: AcledRow[], code: string) => {
      const terms: Record<string, any> = {};
      computeCIIScores(rows, quiet, { nowMs: FIXTURES[0]!.nowMs }, terms);
      const p = terms[code].parts;
      return {
        unrest: p.unrestBase + p.unrestFatalityBoost + p.unrestSeverityBoost,
        conflict: p.acledScore + p.fatalityScore + p.civilianBoost,
        // Explosions/remote violence score as strike pressure.
        strike: terms[code].strikePressure,
      };
    };
    for (const code of CODES) {
      for (const type of ACLED_TYPES) {
        const grew = (next: ReturnType<typeof parts>, prev: ReturnType<typeof parts>) =>
          next.unrest >= prev.unrest && next.conflict >= prev.conflict && next.strike >= prev.strike;
        let prev = { unrest: 0, conflict: 0, strike: 0 };
        for (const n of [1, 2, 3, 5, 8, 13, 22, 40, 100, 400]) {
          const next = parts(Array.from({ length: n }, () => row(code, type)), code);
          assert.ok(grew(next, prev), `${code} ${type} ${n} events`);
          prev = next;
        }
        prev = { unrest: 0, conflict: 0, strike: 0 };
        for (const deaths of [0, 1, 4, 10, 50, 500]) {
          const next = parts([row(code, type, deaths)], code);
          assert.ok(grew(next, prev), `${code} ${type} ${deaths} deaths`);
          prev = next;
        }
      }
    }
  });

  it('the same ACLED evidence gives the same ACLED term in every country: no per-country multiplier', () => {
    const quiet = quietAux();
    const evidence = (code: string) => [
      ...Array.from({ length: 6 }, () => row(code, 'Protests')),
      row(code, 'Riots', 2),
      ...Array.from({ length: 20 }, () => row(code, 'Battles', 3)),
      row(code, 'Violence against civilians', 5),
    ];
    const seen = new Set<string>();
    for (const code of CODES) {
      const terms: Record<string, any> = {};
      computeCIIScores(evidence(code), quiet, { nowMs: FIXTURES[0]!.nowMs }, terms);
      const p = terms[code].parts;
      seen.add(JSON.stringify([p.unrestBase, p.unrestFatalityBoost, p.unrestSeverityBoost, p.acledScore, p.fatalityScore, p.civilianBoost]));
    }
    assert.equal(seen.size, 1, `ACLED terms differ across countries: ${[...seen].join(' | ')}`);
  });

  it('a country with ACLED rows takes the larger of its ACLED and GDELT terms, never the sum', () => {
    const fixture = FIXTURES[0]!;
    const base = byRegion(table(fixture, []).rows);
    const withRows = byRegion(table(fixture, CODES.map((code) => row(code, 'Battles', 1))).rows);
    for (const code of CODES) {
      const before = base.get(code)!;
      const after = withRows.get(code)!;
      const acled = after.parts.acledScore + after.parts.fatalityScore + after.parts.civilianBoost;
      assert.equal(after.components.conflict, Math.min(100, after.parts.orefBoost + Math.max(acled, after.parts.gdeltConflict)), code);
      assert.equal(after.parts.gdeltConflict, before.parts.gdeltConflict, `${code} GDELT conflict term must not depend on ACLED`);
      assert.equal(after.parts.gdeltUnrest, before.parts.gdeltUnrest, `${code} GDELT unrest term must not depend on ACLED`);
      assert.equal(after.strikePressure, before.strikePressure, `${code} strike pressure must not depend on ACLED battles`);
    }
  });

  it('an airstrike reported by ACLED and by GDELT counts once: strike days take the larger, never the sum (P6)', () => {
    // ACLED "Explosions/Remote violence" and GDELT CAMEO 194/195 strikes report
    // the same incidents. Each ACLED explosion row reaches one term only (strike
    // pressure), so the same days from both sources score as the larger source.
    const NOW = Date.parse('2026-10-19T12:00:00Z');
    const DAY = 86_400_000;
    const date = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
    const background = (code: string | null, share: [number, number]) => quietAux({
      gdeltCountryEvents: code ? gdeltCountryEventsFromSeed({
        byCountry: { [code]: { conflict: null, protest: null, week: null, strikes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [date(i), share])) } },
        baselineReady: false, currentComplete: false, weekReady: false,
        strikeDays: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [date(i), 96])), updatedAt: NOW - 600_000,
      }, NOW) : null,
    });
    // ACLED rows on exactly the days GDELT counts as strike days, so every day
    // has both reporters and the merge must equal the larger source.
    const explosions = (code: string, share: [number, number], perDay: number, deaths: number) => {
      const gdelt = (background(code, share).gdeltCountryEvents as any);
      const days = Object.keys(gdeltStrikeDays(gdelt.byCountry[code].strikes, gdelt.strikeDays, NOW));
      assert.ok(days.length > 0, 'the GDELT campaign counts');
      return days.flatMap((d) => {
        const ago = Math.round((NOW - Date.parse(`${d}T12:00:00Z`)) / DAY);
        return Array.from({ length: perDay }, () => row(code, 'Explosions/Remote violence', deaths, ago));
      });
    };
    const worst: string[] = [];
    for (const code of CODES) {
      for (const share of [[3, 359], [20, 359], [150, 400]] as Array<[number, number]>) {
        for (const [perDay, deaths] of [[1, 0], [3, 2], [10, 20]]) {
          const terms = (rows: AcledRow[], withGdelt: boolean) => {
            const out: Record<string, any> = {};
            computeCIIScores(rows, background(withGdelt ? code : null, share), { nowMs: NOW }, out);
            return out[code];
          };
          const acledOnly = terms(explosions(code, share, perDay, deaths), false);
          const gdeltOnly = terms([], true);
          const both = terms(explosions(code, share, perDay, deaths), true);
          const excess = both.blended - Math.max(acledOnly.blended, gdeltOnly.blended);
          if (excess > 1e-9) worst.push(`${code} share=${share} ${perDay}/day deaths=${deaths}: +${excess.toFixed(2)} blend`);
        }
      }
    }
    assert.deepEqual(worst.slice(0, 5), [], `${worst.length} double-counted cases`);
  });

  it('ACLED explosion rows raise the strike boost but never put a country on the strike floor', () => {
    // A floor that a count of ACLED rows can trip is a step on an event count:
    // three fatal shelling rows in one day once summed to P = 6, past the floor's
    // P = 5 threshold, and jumped the country onto a floor of 40+. A day takes
    // one row's weight at most, and only the confirmed feed and GDELT set the floor.
    const nowMs = FIXTURES[0]!.nowMs;
    const quiet = quietAux();
    const strike = (rows: AcledRow[], code: string) => {
      const terms: Record<string, any> = {};
      computeCIIScores(rows, quiet, { nowMs }, terms);
      return terms[code];
    };
    for (const code of CODES) {
      const calm = strike([], code);
      const oneDay = strike(Array.from({ length: 3 }, () => row(code, 'Explosions/Remote violence', 4, 0)), code);
      assert.equal(oneDay.floors.strike, 0, `${code}: 3 fatal rows in a day must not bind the strike floor`);
      assert.ok(oneDay.boosts.strikePressure > calm.boosts.strikePressure, `${code}: ACLED rows still raise the boost`);
      const oneRow = strike([row(code, 'Explosions/Remote violence', 4, 0)], code);
      assert.equal(oneDay.boosts.strikePressure, oneRow.boosts.strikePressure, `${code}: a day carries one row's weight, not a row count`);
      // A three-week ACLED-only campaign, 10 fatal rows a day: boost only.
      const campaign = strike(Array.from({ length: 21 }, (_, d) => Array.from({ length: 10 }, () => row(code, 'Explosions/Remote violence', 2, d))).flat(), code);
      assert.equal(campaign.floors.strike, 0, `${code}: an ACLED-only campaign never binds the strike floor`);
      assert.ok(campaign.boosts.strikePressure > oneDay.boosts.strikePressure, `${code}: a longer campaign raises the boost further`);
    }
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.label}: the deprecated eventMultiplier wire field is the neutral 1 for every country`, () => {
      const t = scoreCiiFixture(fixture);
      for (const score of t.scores) assert.equal(score.eventMultiplier, 1, score.region);
      for (const r of t.rows) assert.ok(!('eventMultiplier' in r), `${r.region} terms still carry eventMultiplier`);
    });
  }

  it('the scoring files define no event-multiplier table', () => {
    for (const path of ['server/worldmonitor/intelligence/v1/get-risk-scores.ts', 'server/worldmonitor/intelligence/v1/_risk-config.ts', 'shared/cii-weights.ts']) {
      const hits: string[] = [];
      walk(sourceFile(path), (node) => {
        if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /EVENT_MULTIPLIER/.test(node.text)) hits.push(node.text);
      });
      assert.deepEqual(hits, [], `${path} still defines an event multiplier`);
    }
  });

  it('the scorer never gates a term on the whole ACLED row list (no `acled.length` regime switch)', () => {
    const hits: string[] = [];
    const source = sourceFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    walk(source, (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'length' && /acled/i.test(node.expression.getText(source))) {
        hits.push(`${node.getText(source)} at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    });
    assert.deepEqual(hits, [], 'a test on the global ACLED row count switches terms for every country');
  });
});
