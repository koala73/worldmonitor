import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeHourlyForecastPeriods } from '../src/services/saved-place-weather.ts';

test('hourly forecast analysis flags strong thunderstorm risk from NWS point forecast data', () => {
  const hazards = analyzeHourlyForecastPeriods([
    {
      startTime: '2026-03-30T18:00:00-05:00',
      endTime: '2026-03-30T19:00:00-05:00',
      temperature: 78,
      temperatureUnit: 'F',
      windSpeed: '25 to 40 mph',
      shortForecast: 'Chance Showers And Thunderstorms',
      probabilityOfPrecipitation: { value: 80 },
    },
    {
      startTime: '2026-03-30T19:00:00-05:00',
      endTime: '2026-03-30T20:00:00-05:00',
      temperature: 74,
      temperatureUnit: 'F',
      windSpeed: '30 to 45 mph',
      shortForecast: 'Showers And Thunderstorms',
      probabilityOfPrecipitation: { value: 90 },
    },
  ]);

  assert.ok(hazards.length > 0, 'forecast hazards should be emitted when strong convective weather is in the next 12 hours');
  assert.equal(hazards[0]?.type, 'thunderstorm');
  assert.match(hazards[0]?.headline ?? '', /thunderstorm/i);
  assert.ok(
    hazards.some((hazard) => hazard.severity === 'high' || hazard.severity === 'critical'),
    'severe forecast periods should produce elevated hazard severity',
  );
});

test('hourly forecast analysis flags blizzard-style winter conditions from NWS point forecast data', () => {
  const hazards = analyzeHourlyForecastPeriods([
    {
      startTime: '2026-03-30T06:00:00-05:00',
      endTime: '2026-03-30T07:00:00-05:00',
      temperature: 18,
      temperatureUnit: 'F',
      windSpeed: '30 to 45 mph',
      shortForecast: 'Heavy Snow And Blowing Snow',
      probabilityOfPrecipitation: { value: 90 },
    },
  ]);

  assert.ok(hazards.length > 0, 'winter hazards should be emitted when blizzard conditions are in the next 12 hours');
  assert.equal(hazards[0]?.type, 'winter');
  assert.match(hazards[0]?.headline ?? '', /winter|snow|blizzard/i);
  assert.ok(
    hazards.some((hazard) => hazard.severity === 'high' || hazard.severity === 'critical'),
    'blizzard-style periods should produce elevated hazard severity',
  );
});
