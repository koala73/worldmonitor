import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { attributionFooterHtml } from '../src/utils/attribution-footer';

describe('attribution-footer', () => {
  test('renders minimal footer with only sourceType', () => {
    const html = attributionFooterHtml({ sourceType: 'ais' });
    assert.match(html, /panel-attribution-footer/);
    assert.match(html, /AIS calibration/);
    assert.match(html, /data-attr-source="ais"/);
  });

  test('includes method, sample size, and credit when provided', () => {
    const html = attributionFooterHtml({
      sourceType: 'operator',
      method: 'GIE AGSI+ daily',
      sampleSize: 142,
      sampleLabel: 'facilities',
      creditName: 'GIE',
      creditUrl: 'https://agsi.gie.eu/',
    });
    assert.match(html, /GIE AGSI\+ daily/);
    assert.match(html, /142 facilities/);
    assert.match(html, /href="https:\/\/agsi\.gie\.eu\/"/);
    assert.match(html, /data-attr-n="142"/);
  });

  test('formats "updated X ago" for a recent timestamp', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const html = attributionFooterHtml({ sourceType: 'regulator', updatedAt: tenMinAgo });
    assert.match(html, /updated 10m ago/);
  });

  test('maps confidence to high/medium/low bands', () => {
    assert.match(attributionFooterHtml({ sourceType: 'classifier', confidence: 0.95 }), /high confidence/);
    assert.match(attributionFooterHtml({ sourceType: 'classifier', confidence: 0.6 }),  /medium confidence/);
    assert.match(attributionFooterHtml({ sourceType: 'classifier', confidence: 0.2 }),  /low confidence/);
    assert.match(attributionFooterHtml({ sourceType: 'classifier', confidence: 0.5 }),  /data-attr-confidence="0\.50"/);
  });

  test('exposes agent-readable data-attributes on every public number', () => {
    const html = attributionFooterHtml({
      sourceType: 'ais',
      method: 'AIS-DWT calibrated',
      sampleSize: 2341,
      confidence: 0.78,
      classifierVersion: 'v3',
    });
    assert.match(html, /data-attr-source="ais"/);
    assert.match(html, /data-attr-method="AIS-DWT calibrated"/);
    assert.match(html, /data-attr-n="2341"/);
    assert.match(html, /data-attr-confidence="0\.78"/);
    assert.match(html, /data-attr-classifier="v3"/);
  });

  test('omits credit section when creditName is absent', () => {
    const html = attributionFooterHtml({ sourceType: 'derived' });
    assert.doesNotMatch(html, /attr-credit/);
  });

  test('escapes HTML in method and credit fields', () => {
    const html = attributionFooterHtml({
      sourceType: 'press',
      method: 'attack<script>alert(1)</script>',
      creditName: 'Rogue<a>',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /Rogue<a>/);
    assert.match(html, /&lt;script&gt;/);
  });
});
