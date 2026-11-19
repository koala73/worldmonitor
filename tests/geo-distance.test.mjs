import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { haversineKm } from '../shared/geo-distance.ts';

const HALF_CIRCUMFERENCE_KM = Math.PI * 6371;

describe('haversineKm', () => {
  it('returns zero for identical coordinates', () => {
    assert.equal(haversineKm(0, 0, 0, 0), 0);
    assert.equal(haversineKm(25, 55, 25, 55), 0);
  });

  it('preserves the known London to Paris distance', () => {
    const distance = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(Math.abs(distance - 343.56) < 0.01, `distance: ${distance}`);
  });

  it('returns a finite half-circumference for the reported antipodal pair', () => {
    const distance = haversineKm(
      -16.476749628391147, 30.924161409453035,
      16.476749628391147, -149.07583859054697,
    );
    assert.ok(Number.isFinite(distance), `expected a finite distance, got ${distance}`);
    assert.ok(Math.abs(distance - HALF_CIRCUMFERENCE_KM) < 0.001);
  });

  it('handles near-antipodes, poles, and date-line crossings', () => {
    for (const coordinates of [
      [0, 0, 0.000001, 179.999999],
      [90, 0, -90, 0],
      [0, 0, 0, 180],
    ]) {
      const distance = haversineKm(...coordinates);
      assert.ok(Math.abs(distance - HALF_CIRCUMFERENCE_KM) < 0.001, `distance: ${distance}`);
    }
    assert.ok(haversineKm(90, 0, 90, 180) < 1e-9);
    assert.ok(Math.abs(haversineKm(0, 179.9, 0, -179.9) - 22.239) < 0.001);
  });

  it('keeps seeded geographic and exact-antipodal samples finite and bounded', () => {
    let seed = 9707;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 1000; i++) {
      const lat = random() * 180 - 90;
      const lon = random() * 360 - 180;
      const otherLat = random() * 180 - 90;
      const otherLon = random() * 360 - 180;
      const antipode = haversineKm(lat, lon, -lat, lon < 0 ? lon + 180 : lon - 180);
      const distance = haversineKm(lat, lon, otherLat, otherLon);
      for (const result of [antipode, distance]) {
        assert.ok(Number.isFinite(result), `sample ${i}: ${result}`);
        assert.ok(result >= 0 && result <= HALF_CIRCUMFERENCE_KM, `sample ${i}: ${result}`);
      }
      assert.ok(Math.abs(antipode - HALF_CIRCUMFERENCE_KM) < 0.001);
      assert.ok(Math.abs(distance - haversineKm(otherLat, otherLon, lat, lon)) < 1e-9);
    }
  });
});
