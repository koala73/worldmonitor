import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fsiAsOf } from '../scripts/_fsi-as-of.mjs';

const hyg = { price: 80, at: Date.UTC(2026, 10, 24, 21) };
const tlt = { price: 88, at: Date.UTC(2026, 10, 24, 21) };
const vixObs = [{ date: '2026-11-20', value: '15.9' }, { date: '2026-11-21', value: '16.2' }];
const hyObs = [{ date: '2026-11-21', value: '3.08' }];

describe('fsiAsOf (#11270)', () => {
  it('returns the oldest input observation', () => {
    const vixData = { price: 16.4, at: Date.UTC(2026, 10, 24, 21) };
    assert.equal(fsiAsOf({ hyg, tlt, vixData, vixObs, hyObs }), Date.UTC(2026, 10, 21));
  });

  it('uses the FRED VIX date when Yahoo VIX is missing or undated', () => {
    const hyFresh = [{ date: '2026-11-24', value: '3.08' }];
    assert.equal(fsiAsOf({ hyg, tlt, vixData: null, vixObs, hyObs: hyFresh }), Date.UTC(2026, 10, 21));
    assert.equal(fsiAsOf({ hyg, tlt, vixData: { price: 16.4 }, vixObs, hyObs: hyFresh }), Date.UTC(2026, 10, 21));
  });

  it('returns null when any input lacks an observation time', () => {
    assert.equal(fsiAsOf({ hyg: { price: 80 }, tlt, vixData: null, vixObs, hyObs }), null);
    assert.equal(fsiAsOf({ hyg, tlt, vixData: null, vixObs, hyObs: null }), null);
  });
});
