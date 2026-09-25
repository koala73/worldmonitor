/**
 * The shared vessel-class display rule from #8611 and the two export surfaces
 * that consume it.
 *
 * AIS ship type 35 only establishes "Military Ops" activity, never a hull
 * class, so such a vessel is stored as vesselType 'unknown'. Every surface that
 * prints the class has to fall back to the AIS activity instead of shipping a
 * bare "unknown" — including the CSV and PDF exports, which are the copy of the
 * data a user keeps.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { vesselTypeLabel } from '@/utils/vessel-type-label';
import { buildDataReportDocument } from '@/utils/export-report';

const LABELS = { destroyer: 'Destroyer', unknown: 'Unknown' };

function vessel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ais-235123456', mmsi: '235123456', name: 'SEA FALCON',
    vesselType: 'unknown', aisShipType: 'Military Ops',
    operator: 'other', operatorCountry: 'Yemen',
    lat: 12, lon: 44, heading: 0, speed: 4,
    lastAisUpdate: new Date('2026-09-24T00:00:00.000Z'), confidence: 'low',
    ...overrides,
  };
}

describe('vesselTypeLabel', () => {
  it('prefers the AIS activity over a bare unknown class', () => {
    assert.equal(vesselTypeLabel(vessel() as never, LABELS), 'Military Ops');
    assert.equal(vesselTypeLabel(vessel() as never), 'Military Ops');
  });

  it('falls back to the class label when there is no AIS ship type', () => {
    assert.equal(vesselTypeLabel(vessel({ aisShipType: undefined }) as never, LABELS), 'Unknown');
    assert.equal(vesselTypeLabel(vessel({ aisShipType: undefined }) as never), 'unknown');
  });

  it('never lets the AIS activity override a known class', () => {
    const known = vessel({ vesselType: 'destroyer' });
    assert.equal(vesselTypeLabel(known as never, LABELS), 'Destroyer');
    assert.equal(vesselTypeLabel(known as never), 'destroyer');
  });

  it('returns the raw class when the caller has no label for it', () => {
    assert.equal(vesselTypeLabel(vessel({ vesselType: 'icebreaker' }) as never, LABELS), 'icebreaker');
  });
});

describe('vessel class in the data report', () => {
  it('prints the AIS activity for an AIS-only military contact', () => {
    const html = buildDataReportDocument({
      timestamp: Date.parse('2026-09-24T00:00:00.000Z'),
      intelligence: { military: { vessels: [vessel()], flights: [] } },
    } as never);
    assert.match(html, /Military Ops/);
    assert.doesNotMatch(html, />unknown</i);
  });

  it('keeps the class for a vessel whose class is known', () => {
    const html = buildDataReportDocument({
      timestamp: Date.parse('2026-09-24T00:00:00.000Z'),
      intelligence: { military: { vessels: [vessel({ vesselType: 'destroyer', name: 'USS ZUMWALT' })], flights: [] } },
    } as never);
    assert.match(html, /destroyer/);
  });
});
