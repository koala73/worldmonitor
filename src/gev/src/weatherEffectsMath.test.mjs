import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWeatherEffectProfile, weatherAltitudeFactors } from './weatherEffectsMath.js';

test('missing weather fails clear instead of inventing effects', () => {
  const profile = deriveWeatherEffectProfile(null);
  assert.equal(profile.available, false);
  assert.equal(profile.cloud, 0);
  assert.equal(profile.rain, 0);
  assert.equal(profile.storm, 0);
});

test('clear weather follows observed cloud cover without precipitation', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 1,
    cloudCoverPct: 24,
    precipitationMm: 0,
    visibilityM: 24000,
    windKph: 12,
    windDirectionDeg: 270,
  });
  assert.equal(profile.available, true);
  assert.ok(profile.cloud > 0 && profile.cloud < 0.3);
  assert.equal(profile.rain, 0);
  assert.equal(profile.snow, 0);
  assert.equal(profile.fog, 0);
  assert.equal(profile.windDirectionDeg, 270);
});

test('thunderstorm activates bounded rain, cloud, droplets, and lightning', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 95,
    cloudCoverPct: 86,
    precipitationMm: 4.2,
    visibilityM: 4500,
    windKph: 58,
    windDirectionDeg: -20,
  });
  assert.ok(profile.cloud >= 0.92);
  assert.ok(profile.rain >= 0.68);
  assert.ok(profile.droplets > 0.5);
  assert.ok(profile.storm >= 0.55);
  assert.equal(profile.snow, 0);
  assert.equal(profile.windDirectionDeg, 340);
});

test('snow codes never render rain droplets', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 75,
    cloudCoverPct: 100,
    precipitationMm: 2.5,
    visibilityM: 3000,
  });
  assert.ok(profile.snow > 0.3);
  assert.equal(profile.rain, 0);
  assert.equal(profile.droplets, 0);
});

test('weather effects attenuate above the ground-weather layer', () => {
  assert.deepEqual(weatherAltitudeFactors(0), { precipitation: 1, cloud: 1, haze: 1 });
  assert.equal(weatherAltitudeFactors(14000).precipitation, 0);
  assert.equal(weatherAltitudeFactors(24000).cloud, 0);
  assert.equal(weatherAltitudeFactors(20000).haze, 0);
});
