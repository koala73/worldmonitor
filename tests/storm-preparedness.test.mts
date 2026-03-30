import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const placeBriefsSrc = readFileSync(resolve(root, 'src/services/place-briefs.ts'), 'utf8');
const servicesIndexSrc = readFileSync(resolve(root, 'src/services/index.ts'), 'utf8');
const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
const buoySrc = readFileSync(resolve(root, 'src/services/noaa-buoys.ts'), 'utf8');
const stormPreparednessSrc = readFileSync(resolve(root, 'src/services/storm-preparedness.ts'), 'utf8');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');

test('place briefs accept storm preparedness context and render preparedness items', () => {
  assert.match(
    placeBriefsSrc,
    /stormPreparedness/,
    'place briefs should accept storm preparedness context in addition to breaking alerts and signals',
  );
  assert.match(
    placeBriefsSrc,
    /kind:\s*'preparedness'/,
    'place briefs should surface preparedness items when storm posture exists for a saved place',
  );
});

test('services index exports the storm preparedness service', () => {
  assert.match(
    servicesIndexSrc,
    /export \* from '\.\/storm-preparedness';/,
    'services index should expose storm preparedness helpers for place briefs and data loading',
  );
  assert.match(
    servicesIndexSrc,
    /export \* from '\.\/wpc-excessive-rainfall';/,
    'services index should expose WPC rainfall outlook ingestion for early flood preparedness',
  );
  assert.match(
    servicesIndexSrc,
    /export \* from '\.\/wpc-winter-weather';/,
    'services index should expose WPC winter outlook ingestion for snow and ice preparedness',
  );
  assert.match(
    servicesIndexSrc,
    /export \* from '\.\/saved-place-weather';/,
    'services index should expose per-place NWS forecast helpers for saved-place storm briefs',
  );
});

test('data loader integrates additional storm sources beyond raw NWS alerts', () => {
  assert.match(
    dataLoaderSrc,
    /fetchSpcSummary|fetchStormReports/,
    'data loader should ingest SPC convective outlooks and recent storm reports',
  );
  assert.match(
    dataLoaderSrc,
    /fetchMarineHazards/,
    'data loader should ingest marine hazards for coastal and surge preparedness',
  );
  assert.match(
    dataLoaderSrc,
    /fetchExcessiveRainfallOutlooks/,
    'data loader should ingest WPC excessive rainfall outlooks for pre-impact flood posture',
  );
  assert.match(
    dataLoaderSrc,
    /fetchWinterWeatherOutlooks/,
    'data loader should ingest WPC winter outlooks for snow and ice preparedness',
  );
  assert.match(
    dataLoaderSrc,
    /loadSavedPlaceWeather|fetchSavedPlaceWeather/,
    'data loader should refresh per-place point forecasts for saved-place lead-time guidance',
  );
  assert.match(
    dataLoaderSrc,
    /fetchBuoyAlerts|fetchHurricaneRecon/,
    'data loader should enrich tropical cyclone monitoring with buoy or recon signals',
  );
});

test('noaa buoy ingestion hydrates station metadata so proximity logic can work', () => {
  assert.match(
    buoySrc,
    /activestations\.xml/,
    'noaa buoy ingestion should pull official station metadata so alerts have real coordinates',
  );
  assert.match(
    buoySrc,
    /stationMeta|stationMetadata/,
    'noaa buoy ingestion should merge observation rows with station metadata before scoring alerts',
  );
});

test('storm preparedness tracks WPC excessive rainfall outlooks as first-class context', () => {
  assert.match(
    stormPreparednessSrc,
    /excessiveRainfallOutlooks/,
    'storm preparedness should carry WPC rainfall outlooks in its shared context',
  );
  assert.match(
    stormPreparednessSrc,
    /winterWeatherOutlooks/,
    'storm preparedness should carry WPC winter outlooks in its shared context',
  );
});

test('app refresh schedule includes saved-place weather refreshes', () => {
  assert.match(
    appSrc,
    /savedPlaceWeather/,
    'app refresh scheduling should keep per-place forecast data current after initial load',
  );
});
