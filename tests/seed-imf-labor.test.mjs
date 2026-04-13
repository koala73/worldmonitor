import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImfLaborCountries } from '../scripts/seed-imf-labor.mjs';

describe('seed-imf-labor', () => {
  it('maps unemployment and population to ISO2 countries', () => {
    const year = String(new Date().getFullYear());
    const countries = buildImfLaborCountries({
      unemploymentData: { USA: { [year]: 4.1 } },
      populationData: { USA: { [year]: 342.1 } },
    });

    assert.ok(countries.US, 'USA should map to US');
    assert.equal(countries.US.unemploymentPct, 4.1);
    assert.equal(countries.US.populationMillions, 342.1);
    assert.equal(countries.US.year, Number(year));
  });

  it('filters IMF aggregate rows', () => {
    const year = String(new Date().getFullYear());
    const countries = buildImfLaborCountries({
      unemploymentData: { WEOWORLD: { [year]: 6.0 }, USA: { [year]: 4.2 } },
      populationData: {},
    });

    assert.ok(countries.US, 'country rows should be preserved');
    assert.ok(!countries.WEOWORLD, 'WEOWORLD aggregate should be excluded');
  });
});
