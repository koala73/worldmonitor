import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMilitaryVesselTooltipHtml } from '../src/components/deckgl-tooltip-renderers';

const translations: Record<string, string> = {
  'popups.militaryVessel.estPosition': 'EST. POSITION',
  'popups.militaryVessel.approximatePosition': 'Position approximate - based on USNI weekly report, not real-time AIS.',
};

function t(key: string): string {
  return translations[key] ?? key;
}

describe('DeckGLMap military vessel tooltip provenance', () => {
  it('renders estimated/approximate provenance for USNI-only positions', () => {
    const html = renderMilitaryVesselTooltipHtml({
      name: 'USS Test',
      operatorCountry: 'United States',
      usniSource: true,
    }, t);

    assert.match(html, /USS Test/);
    assert.match(html, /United States/);
    assert.match(html, /EST\. POSITION/);
    assert.match(html, /Position approximate/);
    assert.match(html, /not real-time AIS/);
  });

  it('omits estimated/approximate provenance for live AIS positions', () => {
    const html = renderMilitaryVesselTooltipHtml({
      name: 'USS Live',
      operatorCountry: 'United States',
      usniSource: false,
    }, t);

    assert.match(html, /USS Live/);
    assert.doesNotMatch(html, /EST\. POSITION/);
    assert.doesNotMatch(html, /Position approximate/);
  });

  it('escapes vessel fields and translated provenance text', () => {
    const html = renderMilitaryVesselTooltipHtml({
      name: '<script>alert(1)</script>',
      operatorCountry: 'US & Allies',
      usniSource: true,
    }, (key) => key === 'popups.militaryVessel.estPosition'
      ? '<EST>'
      : 'Approx & AIS');

    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /US &amp; Allies/);
    assert.match(html, /&lt;EST&gt;/);
    assert.match(html, /Approx &amp; AIS/);
    assert.doesNotMatch(html, /<script>/);
  });
});
