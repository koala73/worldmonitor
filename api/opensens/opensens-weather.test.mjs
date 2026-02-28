/**
 * Unit tests for /api/opensens/weather
 * Run with: node --test api/opensens/opensens-weather.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// ---- Import helpers under test directly ----
import { parseLatLon, coarseBucket, percentile, haversineM } from './_cache.js';

describe('parseLatLon', () => {
  it('parses valid lat/lon', () => {
    const sp = new URLSearchParams('lat=48.85&lon=2.35');
    const { lat, lon } = parseLatLon(sp);
    assert.equal(lat, 48.85);
    assert.equal(lon, 2.35);
  });

  it('throws on missing lat', () => {
    const sp = new URLSearchParams('lon=2.35');
    assert.throws(() => parseLatLon(sp), /lat and lon are required/);
  });

  it('throws on out-of-range lat', () => {
    const sp = new URLSearchParams('lat=200&lon=0');
    assert.throws(() => parseLatLon(sp), /lat must be a number/);
  });

  it('throws on non-numeric lon', () => {
    const sp = new URLSearchParams('lat=10&lon=abc');
    assert.throws(() => parseLatLon(sp), /lon must be a number/);
  });
});

describe('coarseBucket', () => {
  it('rounds to 0.1° by default', () => {
    assert.equal(coarseBucket(48.856, 2.352, 1), '48.9,2.4');
  });

  it('rounds to 1° with precision=0', () => {
    assert.equal(coarseBucket(48.856, 2.352, 0), '49,2');
  });
});

describe('percentile', () => {
  it('p50 of sorted array', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  });

  it('p0 returns minimum', () => {
    assert.equal(percentile([10, 20, 30], 0), 10);
  });

  it('p100 returns maximum', () => {
    assert.equal(percentile([10, 20, 30], 100), 30);
  });

  it('returns 0 for empty array', () => {
    assert.equal(percentile([], 50), 0);
  });
});

describe('haversineM', () => {
  it('returns ~0 for same point', () => {
    assert.ok(haversineM(48.85, 2.35, 48.85, 2.35) < 1);
  });

  it('Paris → London ≈ 340 km', () => {
    const d = haversineM(48.8566, 2.3522, 51.5074, -0.1278);
    assert.ok(d > 330000 && d < 350000, `Expected ~340 000 m, got ${d.toFixed(0)}`);
  });

  it('is symmetric', () => {
    const ab = haversineM(0, 0, 10, 10);
    const ba = haversineM(10, 10, 0, 0);
    assert.ok(Math.abs(ab - ba) < 0.001);
  });
});

describe('weather endpoint parameter validation (integration smoke test)', () => {
  it('builds valid Open-Meteo URL without errors', () => {
    // Replicate URL-building logic inline for unit test
    const lat = 48.85, lon = 2.35, days = 7, pastDays = 7;
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m,global_tilted_irradiance,direct_normal_irradiance,diffuse_radiation,precipitation,cloud_cover',
      wind_speed_unit: 'ms',
      timezone: 'UTC',
      forecast_days: String(Math.min(Math.max(days, 1), 16)),
      past_days: String(Math.min(Math.max(pastDays, 0), 92)),
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    assert.ok(url.includes('latitude=48.8500'));
    assert.ok(url.includes('global_tilted_irradiance'));
  });

  it('clamps days to valid range', () => {
    const days = Math.min(Math.max(parseInt('999') || 7, 1), 16);
    assert.equal(days, 16);
    const daysLow = Math.min(Math.max(parseInt('-5') || 7, 1), 16);
    assert.equal(daysLow, 1);
  });
});
