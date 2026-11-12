// The deep-dive shock widget labels a gas result by its model basis: measured
// Hormuz shares, zero recorded LNG imports, or the assumed route fraction of
// the other chokepoints. Only the last may say "assumed".
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const PRE = { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, hormuzLngShare: 0.064, lngDisruptionTj: 17548.6 };
const NOW = { basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3, hormuzLngShare: 0.0044, lngDisruptionTj: 1206.5 };

function response(gasSensitivity, extra = {}) {
  return {
    countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, gulfCrudeShare: 0, crudeLossKbd: 0, products: [],
    effectiveCoverDays: 0, assessment: gasSensitivity.assessment, dataAvailable: true, jodiOilCoverage: false, comtradeCoverage: false,
    ieaStocksCoverage: false, portwatchCoverage: true, coverageLevel: 'partial', limitations: [], degraded: false, chokepointConfidence: 'none',
    gasSensitivity: {
      lngShareOfImports: 1, lngImportsTj: 274197, totalDemandTj: 299947, dataAvailable: true, dataSource: 'jodi_monthly', dataMonth: '2026-07',
      ...gasSensitivity,
    },
    ...extra,
  };
}

async function render(result) {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    return harness.createPanel().renderShockResult(result).textContent;
  } finally { harness.cleanup(); }
}

it('labels both measured baselines and the share behind the headline loss', async () => {
  const text = await render(response({ modelBasis: 'comtrade_lng_origin_share', lngDisruptionTj: 17548.6, deficitPct: 5.9, preCrisisBaseline: PRE, currentFlows: NOW, assessment: 'measured' }));
  assert.match(text, /Gas \/ liquefied natural gas Hormuz exposure/);
  assert.match(text, /Monthly loss at the pre-crisis share: 17548\.6 terajoules/);
  assert.match(text, /pre-crisis 6\.4% \(2025-02 to 2026-01\) \| current flows 0\.4% \(2026-06 to 2026-08\), monthly loss 1206\.5 terajoules/);
  assert.match(text, /LNG origin: UN Comtrade/);
  assert.doesNotMatch(text, /assumed/i);
});

it('names the current-flows share as the headline basis when the pre-crisis share is unavailable', async () => {
  const text = await render(response({ modelBasis: 'comtrade_lng_origin_share', lngDisruptionTj: 1206.5, deficitPct: 0.4, currentFlows: NOW, assessment: 'current only' }));
  assert.match(text, /Monthly loss at the current-flows share: 1206\.5 terajoules/);
  assert.match(text, /pre-crisis unavailable \| current flows 0\.4% \(2026-06 to 2026-08\)/);
  assert.doesNotMatch(text, /assumed/i);
});

it('gives zero recorded LNG imports neutral wording, also when shipping data is degraded', async () => {
  const text = await render(response(
    { modelBasis: 'observed_zero_lng_imports', lngImportsTj: 0, lngDisruptionTj: 0, deficitPct: 0, assessment: 'JP recorded zero LNG imports in 2026-07.' },
    { degraded: true },
  ));
  assert.match(text, /Monthly loss: 0\.0 terajoules/);
  assert.doesNotMatch(text, /assumed/i);
});

it('keeps the assumed wording for the fixed route fraction of other chokepoints', async () => {
  const text = await render(response(
    { modelBasis: 'assumed_route_sensitivity', lngDisruptionTj: 137098.5, deficitPct: 45.7, assessment: 'JP gas sensitivity assumes 50% of recorded LNG imports use Strait of Malacca.' },
    { chokepointId: 'malacca_strait', degraded: true },
  ));
  assert.match(text, /Gas \/ liquefied natural gas assumed sensitivity/);
  assert.match(text, /Assumed monthly loss: 137098\.5 terajoules/);
  assert.match(text, /Gas sensitivity uses an assumed route baseline/);
});
