import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeSanctionEntries, SEMA_SOURCE } from '../scripts/_sema-sanctions.mjs';
import { CSL_ROW_ID, CSL_SOURCES } from '../scripts/_csl-sanctions.mjs';
import { signalAggregator } from '@/services/signal-aggregator';
import { projectCountrySignalDetails } from '../shared/country-signal-details';

const seedSource = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const producer = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp, SEMA_SOURCE, CSL_SOURCES, CSL_ROW_ID });
vm.runInContext(seedSource.replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);/, '')
  .replace(/async function fetchSource[\s\S]*/, ''), producer);

beforeEach(() => signalAggregator.clear());

for (const addedIds of [0, 1, 5]) {
  it(`excludes ${addedIds} new SEMA target IDs from a country observation`, () => {
    const entry = (source: string, index: number) => ({
      id: `${source}:${index}`, name: `${source} controlled entity ${index}`,
      countryCodes: ['CN'], countryNames: ['China'], _regime: 'China', sourceLists: [source], programs: [],
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', effectiveAt: '1577836800000',
      isNew: source === SEMA_SOURCE && index < addedIds,
    });
    const entries = mergeSanctionEntries({
      ofac: Array.from({ length: 25 }, (_, index) => entry('SDN', index)),
      sema: Array.from({ length: 25 }, (_, index) => entry(SEMA_SOURCE, index)),
    });
    const countries = JSON.parse(JSON.stringify(producer.buildCountryPressure(entries)));
    assert.equal(countries[0].entryCount, 25);
    assert.equal(countries[0].newEntryCount, 0);
    const before = Date.now();
    signalAggregator.ingestSanctionsPressure(countries);
    const summary = signalAggregator.getSummary();
    const signals = summary.topCountries[0].signals;
    const expected = '25 sanctions designations tied to China (OFAC)';
    assert.equal(signals[0].title, expected);
    assert.equal(summary.totalSignals, 1);
    assert.equal(summary.byType.sanctions_pressure, 1);
    assert.equal(signals[0].severity, 'medium');
    assert.ok(signals[0].timestamp.getTime() >= before && signals[0].timestamp.getTime() <= Date.now());
    assert.deepEqual(projectCountrySignalDetails(signals).recentHigh, []);
    assert.doesNotMatch(summary.aiContext, /new OFAC|OFAC-linked/);
  });
}
