import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCanadaNationalOverlay,
  RESILIENCE_BOC_VALET_KEY,
  RESILIENCE_STATCAN_WDS_KEY,
} from '../server/worldmonitor/resilience/v1/_canada-national-overlay.ts';
import {
  scoreCurrencyExternal,
  scoreMacroFiscal,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { fixtureReader } from './helpers/resilience-fixtures.mts';

const here = dirname(fileURLToPath(import.meta.url));
const scorerSrc = readFileSync(resolve(here, '../server/worldmonitor/resilience/v1/_dimension-scorers.ts'), 'utf8');

const LAGGED_IMF_INFLATION = 12.5;
const STATCAN_INFLATION = 2.8;
const LAGGED_IMF_UNEMPLOYMENT = 18;
const STATCAN_UNEMPLOYMENT = 6.4;

function canadaReader(opts: { statcan?: boolean; boc?: boolean } = {}): ResilienceSeedReader {
  const { statcan = true, boc = true } = opts;
  return async (key: string) => {
    if (key === 'economic:imf:macro:v2') {
      return { countries: { CA: { inflationPct: LAGGED_IMF_INFLATION, currentAccountPct: -1, govRevenuePct: 40, year: 2024 } } };
    }
    if (key === 'economic:imf:labor:v1') {
      return { countries: { CA: { unemploymentPct: LAGGED_IMF_UNEMPLOYMENT, populationMillions: 40, year: 2024 } } };
    }
    if (key === RESILIENCE_STATCAN_WDS_KEY) {
      return statcan
        ? { inflationPct: STATCAN_INFLATION, inflationRefPer: '2026-06-01', unemploymentPct: STATCAN_UNEMPLOYMENT, unemploymentRefPer: '2026-07-01' }
        : null;
    }
    if (key === RESILIENCE_BOC_VALET_KEY) {
      return boc
        ? { rates: { USD: { rate: 1.3938, date: '2026-08-13' } }, policyRate: { rate: 2.25, observedAt: '2026-08-12' } }
        : null;
    }
    return fixtureReader(key);
  };
}

describe('Canada national overlay', () => {
  it('replaces lagged IMF inflation and unemployment for CA only', () => {
    const ca = applyCanadaNationalOverlay(
      'CA',
      { inflationPct: LAGGED_IMF_INFLATION, currentAccountPct: -1, govRevenuePct: 40, year: 2024 },
      { unemploymentPct: LAGGED_IMF_UNEMPLOYMENT, populationMillions: 40, year: 2024 },
      {
        statcan: { inflationPct: STATCAN_INFLATION, unemploymentPct: STATCAN_UNEMPLOYMENT },
        boc: { rates: { USD: { rate: 1.3938 } }, policyRate: { rate: 2.25 } },
      },
    );
    assert.equal(ca.usedStatcanInflation, true);
    assert.equal(ca.usedStatcanUnemployment, true);
    assert.equal(ca.imfEntry?.inflationPct, STATCAN_INFLATION);
    assert.equal(ca.laborEntry?.unemploymentPct, STATCAN_UNEMPLOYMENT);
    assert.equal(ca.bocUsdCad, 1.3938);
    assert.equal(ca.bocPolicyRate, 2.25);

    const us = applyCanadaNationalOverlay(
      'US',
      { inflationPct: 3.5 },
      { unemploymentPct: 4.1 },
      { statcan: { inflationPct: STATCAN_INFLATION, unemploymentPct: STATCAN_UNEMPLOYMENT } },
    );
    assert.equal(us.usedStatcanInflation, false);
    assert.equal(us.imfEntry?.inflationPct, 3.5);
  });

  it('scoreMacroFiscal and scoreCurrencyExternal read Valet and WDS keys for CA and drop IMF-lag inflation', async () => {
    const withNational = await scoreCurrencyExternal('CA', canadaReader());
    const imfOnly = await scoreCurrencyExternal('CA', canadaReader({ statcan: false, boc: false }));
    assert.ok(withNational.score > imfOnly.score, `national CPI YoY (${withNational.score}) should beat lagged IMF inflation (${imfOnly.score})`);

    const keys: string[] = [];
    const spy: ResilienceSeedReader = async (key) => {
      keys.push(key);
      return canadaReader()(key);
    };
    await scoreMacroFiscal('CA', spy);
    assert.ok(keys.includes(RESILIENCE_STATCAN_WDS_KEY));
    assert.ok(keys.includes(RESILIENCE_BOC_VALET_KEY));

    const usKeys: string[] = [];
    await scoreMacroFiscal('US', async (key) => {
      usKeys.push(key);
      return fixtureReader(key);
    });
    assert.ok(!usKeys.includes(RESILIENCE_STATCAN_WDS_KEY));
  });

  it('scorers import the overlay keys rather than leaving CA on IMF-only reads', () => {
    assert.match(scorerSrc, /RESILIENCE_BOC_VALET_KEY/);
    assert.match(scorerSrc, /RESILIENCE_STATCAN_WDS_KEY/);
    assert.match(scorerSrc, /applyCanadaNationalOverlay/);
  });
});
