import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DATA_MODE,
  buildVesselCardManifest,
  isHardwareRenderer,
  isHeadfulMode,
  parseDataMode,
  vesselCardManifestFilename,
  vesselCardProvenanceLines,
  vesselCardScreenshotFilename,
} from '../scripts/qa-vessel-cards.mjs';

test('vessel-card QA keeps live AISStream as the default and synthetic opt-in', () => {
  assert.equal(DEFAULT_DATA_MODE, 'live');
  assert.equal(parseDataMode([]), 'live');
  assert.equal(parseDataMode(['--data', 'synthetic']), 'synthetic');
  assert.equal(isHeadfulMode([]), false);
  assert.equal(isHeadfulMode(['--headful']), true);
  assert.throws(
    () => parseDataMode(['--data', 'fixture']),
    /Unknown --data mode 'fixture'/,
  );
});

test('vessel-card QA filenames cannot collide across live and synthetic evidence', () => {
  const shared = { tag: 'new', portKey: 'rotterdam' };
  const live = vesselCardScreenshotFilename({ ...shared, dataMode: 'live' });
  const synthetic = vesselCardScreenshotFilename({ ...shared, dataMode: 'synthetic' });

  assert.equal(live, 'vessel-cards-live-aisstream-new-rotterdam.png');
  assert.equal(synthetic, 'vessel-cards-synthetic-fixture-new-rotterdam.png');
  assert.notEqual(live, synthetic);
  assert.equal(
    vesselCardManifestFilename(synthetic),
    'vessel-cards-synthetic-fixture-new-rotterdam.json',
  );
});

test('vessel-card QA output makes synthetic provenance and upstream context explicit', () => {
  const live = vesselCardProvenanceLines('live').join('\n');
  const synthetic = vesselCardProvenanceLines('synthetic').join('\n');

  assert.match(live, /LIVE AISStream feed/);
  assert.match(live, /no synthetic vessel rows/i);
  assert.match(synthetic, /SYNTHETIC FIXTURE/);
  assert.match(synthetic, /not evidence of live AISStream availability/i);
  assert.match(synthetic, /AISStream Issue #23: https:\/\/github\.com\/aisstream\/aisstream\/issues\/23/);
  assert.match(synthetic, /AISStream Issue #15: https:\/\/github\.com\/aisstream\/aisstream\/issues\/15/);
});

test('vessel-card QA manifest binds screenshot provenance, launch mode, and renderer', () => {
  const manifest = buildVesselCardManifest({
    dataMode: 'synthetic',
    tag: 'new',
    portKey: 'houston',
    screenshot: 'vessel-cards-synthetic-fixture-new-houston.png',
    headful: true,
    renderer: { vendor: 'Apple', renderer: 'Apple M-series' },
    captureEvidence: {
      tilesAndVesselsSettled: true,
      injectedRows: 8,
      syntheticFixtureRowsRetained: true,
      overlayEntries: 8,
      overlayPainted: 8,
      hardwareAccelerated: true,
      passed: true,
    },
    appUrl: 'http://localhost:4173',
    capturedAt: '2026-08-14T00:00:00.000Z',
  });

  assert.equal(manifest.dataMode, 'synthetic');
  assert.equal(manifest.provenance, 'synthetic-fixture');
  assert.equal(manifest.liveAisStreamAvailabilityAsserted, false);
  assert.equal(manifest.launchMode, 'headful');
  assert.equal(manifest.renderer.renderer, 'Apple M-series');
  assert.equal(manifest.captureEvidence.syntheticFixtureRowsRetained, true);
  assert.equal(manifest.captureEvidence.passed, true);
  assert.deepEqual(manifest.upstreamContext, [
    'https://github.com/aisstream/aisstream/issues/23',
    'https://github.com/aisstream/aisstream/issues/15',
  ]);
});

test('vessel-card QA distinguishes hardware evidence from software rendering', () => {
  assert.equal(isHardwareRenderer({ vendor: 'Apple', renderer: 'ANGLE Metal Renderer: Apple M3' }), true);
  assert.equal(isHardwareRenderer({ vendor: 'Google Inc.', renderer: 'ANGLE (SwiftShader)' }), false);
  assert.equal(isHardwareRenderer({ vendor: 'unavailable', renderer: 'unavailable' }), false);
});
