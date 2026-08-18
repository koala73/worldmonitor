import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../src/app/search-manager.ts', import.meta.url),
  'utf8',
);
const sourceFile = ts.createSourceFile(
  'search-manager.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const managerNode = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
  ts.isClassDeclaration(statement) && statement.name?.text === 'SearchManager'
));
assert.ok(managerNode, 'SearchManager class must remain available');
const helperNames = new Set(['flightObservationTime', 'buildFlightSearchItems']);
const helperMethods = managerNode.members.filter((member): member is ts.MethodDeclaration => (
  ts.isMethodDeclaration(member)
  && ts.isIdentifier(member.name)
  && helperNames.has(member.name.text)
));
assert.equal(helperMethods.length, helperNames.size, 'flight freshness helpers must remain testable');

const helperClassSource = `class SearchManager {\n${helperMethods
  .map((method) => method.getText(sourceFile))
  .join('\n')}\n}`;
const helperJs = ts.transpileModule(helperClassSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
}).outputText;

// eslint-disable-next-line no-new-func
const helpers = new Function(
  'FLIGHT_SEARCH_SOURCE_TTL_MS',
  't',
  `${helperJs}\nreturn SearchManager;`,
)(
  120_000,
  (key: string, vars?: Record<string, string>) => `${key}:${JSON.stringify(vars ?? {})}`,
) as {
  buildFlightSearchItems(
    adsb: any[],
    military: any[],
    adsbUpdatedAt: number,
    now: number,
  ): Array<{ data: { kind: string }; expiresAt: number }>;
};

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

function adsbPosition(observedAt: Date) {
  return {
    icao24: 'abc123',
    callsign: 'TEST1',
    altitudeFt: 30_000,
    groundSpeedKts: 420,
    onGround: false,
    lat: 1,
    lon: 2,
    observedAt,
  };
}

function militaryFlight(lastSeen: Date) {
  return {
    hexCode: 'def456',
    callsign: 'MIL1',
    aircraftType: 'transport',
    altitude: 20_000,
    onGround: false,
    lat: 3,
    lon: 4,
    lastSeen,
  };
}

describe('search flight-source freshness', () => {
  it('does not renew stale military cache entries with a fresh ADS-B callback timestamp', () => {
    const items = helpers.buildFlightSearchItems(
      [adsbPosition(new Date(NOW - 5_000))],
      [militaryFlight(new Date(NOW - 5 * 60_000))],
      NOW,
      NOW,
    );

    assert.deepEqual(items.map((item) => item.data.kind), ['adsb']);
  });

  it('derives independent expiries from observedAt and lastSeen', () => {
    const adsbObservedAt = NOW - 10_000;
    const militaryLastSeen = NOW - 45_000;
    const items = helpers.buildFlightSearchItems(
      [adsbPosition(new Date(adsbObservedAt))],
      [militaryFlight(new Date(militaryLastSeen))],
      NOW,
      NOW,
    );

    assert.deepEqual(items.map((item) => item.expiresAt), [
      adsbObservedAt + 120_000,
      militaryLastSeen + 120_000,
    ]);
  });

  it('clamps future observation clocks to the current refresh time', () => {
    const items = helpers.buildFlightSearchItems(
      [adsbPosition(new Date(NOW + 60 * 60_000))],
      [militaryFlight(new Date(NOW + 60 * 60_000))],
      NOW,
      NOW,
    );

    assert.deepEqual(items.map((item) => item.expiresAt), [
      NOW + 120_000,
      NOW + 120_000,
    ]);
  });
});
