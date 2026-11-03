import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

it('keeps WORLD ratios with their own marketing year and preserves absent-stock states', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    const country = { records: [{ commodity: 'wheat', marketingYear: '2023/24', stocksToUse: .197, hasStocksToUse: true, source: 'psd', totalUseTmt: 100 }], unavailable: false };
    const base = { commodity: 'wheat', marketingYear: '2024/25', stocksToUse: .25, hasStocksToUse: true, source: 'psd', totalUseTmt: 100 };
    for (const [row, expected] of [
      [base, '25.0% (2024/25)'],
      [{ ...base, marketingYear: '2023/24' }, '25.0% (2023/24)'],
      [{ ...base, stocksToUse: 0 }, '0.0% (2024/25)'],
      [{ ...base, hasStocksToUse: false, stocksToUse: 0 }, '—'],
      [{ ...base, source: 'faostat', hasStocksToUse: false }, '—'],
      [{ ...base, marketingYear: '' }, '25.0%'],
      [null, '—'],
    ]) {
      const world = { records: row ? [row] : [], unavailable: !row };
      const body = harness.document.createElement('div');
      panel.source = { food: async code => code === 'WORLD' ? world : country };
      await panel.renderFoodStocks('EG', body);
      const cells = [...body.querySelector('tbody').querySelectorAll('td')].map(cell => cell.textContent);
      assert.deepEqual(cells.slice(1), ['2023/24', '19.7%', expected]);
      assert.equal(country.records.length, 1);
      assert.equal(country.records[0].stocksToUse, .197);
      assert.equal(country.records[0].marketingYear, '2023/24');
    }
    const body = harness.document.createElement('div');
    panel.source = { food: async code => {
      if (code === 'WORLD') throw new Error('Controlled WORLD failure');
      return country;
    } };
    await panel.renderFoodStocks('EG', body);
    assert.deepEqual([...body.querySelector('tbody').querySelectorAll('td')].slice(1).map(cell => cell.textContent), ['2023/24', '19.7%', '—']);
  } finally { harness.cleanup(); }
});
