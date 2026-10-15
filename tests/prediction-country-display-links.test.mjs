import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

it('country Open selects supported Kalshi display links without changing identity or presentation', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    const body = harness.document.createElement('div');
    panel.marketsBody = body;
    const legacy = 'https://kalshi.com/markets/KXMEETING-27-CN';
    const landing = 'https://kalshi.com/markets/kxmeeting';
    for (const [displayUrl, expected] of [[undefined, legacy], [landing, landing], ['', null], ['javascript:alert(1)', null]]) {
      const row = { title: 'Will China host the meeting?', yesPrice: 70, source: 'kalshi', url: legacy, ...(displayUrl === undefined ? {} : { displayUrl }) };
      panel.updateMarkets([row]);
      assert.equal(body.querySelector('a')?.getAttribute('href') ?? null, expected);
      assert.match(body.textContent, /Will China host the meeting\?/);
      assert.match(body.textContent, /Kalshi/);
      assert.match(body.textContent, /70%/);
      assert.equal(row.url, legacy);
    }
    const poly = { title: 'China GDP', yesPrice: 68, source: 'polymarket', url: 'https://polymarket.com/event/china-gdp', displayUrl: landing };
    panel.updateMarkets([poly]);
    assert.equal(body.querySelector('a').getAttribute('href'), poly.url);
    assert.match(body.textContent, /Polymarket/);
    assert.match(body.textContent, /68%/);
    panel.updateMarkets([{ title: 'Native RPC row', yesPrice: 70, source: 'kalshi', url: landing }]);
    assert.equal(body.querySelector('a').getAttribute('href'), landing);
  } finally { harness.cleanup(); }
});
