// GDELT is WorldMonitor's only live conflict-event source (no ACLED access), so
// GDELT_COUNTRY_NAMES is the whole country gate for the conflict feed: the bulk
// mapper drops every material-conflict row whose ActionGeo country is not in it.
// In October 2026 Houthi strikes hit Riyadh and Dammam, yet the feed carried no
// Saudi rows because the set stopped at the original 20 crisis countries.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveCountryCode } from '../shared/country-code-resolve.ts';
import { GDELT_COUNTRY_NAMES } from '../scripts/_conflict-gdelt.mjs';
import { mapGdeltExportToConflictEvents } from '../scripts/_conflict-gdelt-bulk.mjs';
import {
  CONFLICT_COUNTRIES,
  GDELT_MIN_SUCCESSFUL_COUNTRIES,
  HAPI_CRISIS_COUNTRIES,
} from '../scripts/seed-conflict-intel.mjs';

// The 20 priority conflict countries the gate started with (#5099).
const LEGACY_PRIORITY = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];

function exportRow(fipsCountry: string, id: string): string {
  const fields: string[] = Array(61).fill('');
  fields[0] = id;
  fields[25] = '1';
  fields[26] = '190';
  fields[28] = '19';
  fields[29] = '4';
  fields[53] = fipsCountry;
  fields[59] = '20261012110000';
  fields[60] = `https://example.com/${id}`;
  return fields.join('\t');
}

describe('GDELT conflict country coverage', () => {
  it('is exactly the legacy priority set plus every crisis-tracker country', () => {
    // A tracker page whose country the conflict feed never collects shows a
    // crisis with no conflict events. HAPI_CRISIS_COUNTRIES is read from
    // shared/crawlable-crises.json, so a new tracker fails here until its
    // countries are added, and nothing outside the two registries can be.
    assert.ok(HAPI_CRISIS_COUNTRIES.length > 0);
    const expectedCodes = [...new Set([...LEGACY_PRIORITY, ...HAPI_CRISIS_COUNTRIES])].sort();
    assert.deepEqual(Object.keys(GDELT_COUNTRY_NAMES).sort(), expectedCodes);
  });

  it('now covers the Gulf and Levant states the crisis trackers name', () => {
    // The October 2026 Houthi strikes on Riyadh and Dammam produced no rows.
    for (const code of ['SA', 'IR', 'IL', 'LB', 'QA', 'AE', 'KW', 'BH', 'OM']) {
      assert.ok(GDELT_COUNTRY_NAMES[code], `${code} missing`);
    }
  });

  it('names every country so the shared resolver maps it back to its own code', () => {
    // Downstream readers (coverage, CII) re-resolve the emitted display name.
    // CD is the one known gap: the shared resolver does not know ACLED's
    // "Democratic Republic of Congo" spelling, so readers go through
    // list-acled-events' acledCountryCode, which special-cases it.
    const wrong = Object.entries(GDELT_COUNTRY_NAMES)
      .filter(([code, name]) => resolveCountryCode(name) !== code && code !== 'CD')
      .map(([code, name]) => `${code}:${name}->${resolveCountryCode(name)}`);
    assert.deepEqual(wrong, []);
  });

  it('runs the DOC sweep over the same set the bulk mapper accepts', () => {
    assert.deepEqual([...CONFLICT_COUNTRIES].sort(), Object.keys(GDELT_COUNTRY_NAMES).sort());
    assert.equal(GDELT_MIN_SUCCESSFUL_COUNTRIES, Math.ceil(CONFLICT_COUNTRIES.length * 0.8));
  });

  it('keeps bulk rows located in Saudi Arabia and the other added states', () => {
    // FIPS 10-4 codes, as GDELT writes ActionGeo_CountryCode.
    const fips: Record<string, string> = {
      SA: 'SA', IR: 'IR', IS: 'IL', LE: 'LB', QA: 'QA', AE: 'AE', KU: 'KW', BA: 'BH', MU: 'OM',
    };
    const csv = Object.keys(fips).map((code, i) => exportRow(code, String(1000 + i))).join('\n');
    const events = mapGdeltExportToConflictEvents(csv);
    assert.deepEqual(
      events.map((event: { country: string }) => resolveCountryCode(event.country)).sort(),
      Object.values(fips).sort(),
    );
    assert.equal(events.find((event: { id: string }) => event.id === 'gdelt-event-1000')?.country, 'Saudi Arabia');
  });
});
