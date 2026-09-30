import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

async function settleWidgets(harness) {
  for (let i = 0; i < 25 && !harness.getWidgets().length; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

it('keeps all fetched headlines while marking only the first three for summary', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('United States', 'US', null, {});
    const titles = ['Federal budget', 'Housing supply', 'Energy output', 'Port traffic', 'Crop forecast', 'Debt auction',
      'Factory orders', 'Defense contract', 'Election results', 'Storm warning', 'Technology exports'];
    panel.updateNews(titles.map((title, i) => ({ title, source: 'Reuters', link: `https://example.com/${i}`, pubDate: '2026-09-05T12:00:00Z' })));
    const root = harness.getPanelRoot();
    assert.equal(root.querySelectorAll('.cdp-news-item').length, 11);
    assert.equal(root.querySelectorAll('.cdp-expanded-only .cdp-news-item').length, 8);
    assert.match(root.querySelector('#cdp-section-news').textContent, /Read all 11 headlines/);
    await settleWidgets(harness);
    panel.hide();
  } finally {
    harness.cleanup();
  }
});

it('loads the scenario after premium access arrives and discards an older entitlement request', async () => {
  const harness = await createCountryDeepDivePanelHarness({ deferCostShock: true });
  try {
    const panel = harness.createPanel();
    panel.show('United States', 'US', null, {});
    panel.updateTradeExposure({ iso2: 'US', hs2: '27', primaryChokepointId: 'panama', vulnerabilityIndex: 20,
      exposures: [{ chokepointId: 'panama', chokepointName: 'Panama Canal', exposureScore: 20, coastSide: '', shockSupported: true }], fetchedAt: '' });
    assert.equal(harness.getCostShockRequests().length, 0);
    harness.setPremiumAccess(true);
    panel.syncCountryPremiumSectionsAccess(true);
    const first = harness.getCostShockRequests()[0];
    assert.equal(first.chokepoint, 'panama');
    harness.setPremiumAccess(false);
    panel.syncCountryPremiumSectionsAccess(false);
    assert.equal(first.signal.aborted, true);
    first.resolve(null);
    await Promise.resolve();
    assert.ok(harness.getPanelRoot().querySelector('#cdp-section-scenario .cdp-pro-locked'));
    harness.setPremiumAccess(true);
    panel.syncCountryPremiumSectionsAccess(true);
    harness.getCostShockRequests()[1].resolve(null);
    await Promise.resolve();
    assert.match(harness.getPanelRoot().querySelector('#cdp-section-scenario').textContent, /No cost shock scenario/);
    await settleWidgets(harness);
    panel.hide();
  } finally {
    harness.cleanup();
  }
});

it('lists cited evidence under the brief sources in summary and full views', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Finland', 'FI', null, {});
    panel.updateBrief({
      code: 'FI',
      country: 'Finland',
      brief: "SITUATION NOW\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]",
      sources: [{ title: 'Finland budget talks', source: 'Yle', url: 'https://example.com/fi' }],
      evidence: [{ id: 'E2', kind: 'resilience', label: 'Fiscal space', value: '28 of 100', factText: '', asOf: '2026-09-21T00:00:00.000Z', url: '' }],
    });
    // The mini DOM keeps trusted HTML as a string, so read each footer host's markup.
    const root = harness.getPanelRoot();
    const hosts = [...root.querySelectorAll('.cdp-summary-only'), ...root.querySelectorAll('.cdp-expanded-only')]
      .map((node) => node.innerHTML)
      .filter((html) => html.includes('cdp-brief-evidence'));
    assert.equal(hosts.length >= 2, true, 'summary and expanded views each list the evidence');
    for (const html of hosts) {
      assert.match(html, /<details class="cdp-brief-sources cdp-brief-evidence">E2 Fiscal space<\/details>/);
      assert.ok(html.indexOf('Finland budget talks') < html.indexOf('cdp-brief-evidence'), 'evidence follows the sources list');
    }
    await settleWidgets(harness);
    panel.hide();
  } finally {
    harness.cleanup();
  }
});
