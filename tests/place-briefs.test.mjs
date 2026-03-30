import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const breakingAlertsSrc = readFileSync(resolve(root, 'src/services/breaking-news-alerts.ts'), 'utf8');
const placeBriefsSrc = readFileSync(resolve(root, 'src/services/place-briefs.ts'), 'utf8');
const savedPlacesPanelSrc = readFileSync(resolve(root, 'src/components/SavedPlacesPanel.ts'), 'utf8');
const alertCenterSrc = readFileSync(resolve(root, 'src/components/AlertCenterPanel.ts'), 'utf8');
const offlineCacheSrc = readFileSync(resolve(root, 'src/services/offline-alert-cache.ts'), 'utf8');

test('breaking alerts tag nearby saved places and keep recent history', () => {
  assert.match(breakingAlertsSrc, /export function tagBreakingAlertPlaces/, 'breaking alerts should expose saved-place tagging');
  assert.match(breakingAlertsSrc, /haversineKm\(/, 'breaking alerts should use distance checks for place impact');
  assert.match(breakingAlertsSrc, /placeSummary/, 'breaking alerts should carry a readable place summary');
  assert.match(breakingAlertsSrc, /getRecentBreakingAlerts/, 'breaking alerts should expose recent alert history');
});

test('place briefs use offline cache and offline fallback', () => {
  assert.match(placeBriefsSrc, /readOfflineCacheEntry/, 'place briefs should read cached snapshots');
  assert.match(placeBriefsSrc, /writeOfflineCacheEntry\(/, 'place briefs should persist cached snapshots');
  assert.match(placeBriefsSrc, /isOffline\(\)/, 'place briefs should respect offline mode when deciding fallback');
  assert.match(placeBriefsSrc, /buildPlaceBrief\(/, 'place briefs should have a dedicated builder');
  assert.match(placeBriefsSrc, /buildSavedPlaceWeatherBriefItems|getCachedSavedPlaceWeather/, 'place briefs should fold cached point forecasts into saved-place guidance');
});

test('saved places panel surfaces place brief headlines and refreshes on alert events', () => {
  assert.match(savedPlacesPanelSrc, /getSavedPlaceBrief\(/, 'saved places panel should render place briefs');
  assert.match(savedPlacesPanelSrc, /wm:breaking-news/, 'saved places panel should refresh when breaking alerts fire');
  assert.match(savedPlacesPanelSrc, /wm:intelligence-updated/, 'saved places panel should refresh when signals update');
  assert.match(savedPlacesPanelSrc, /wm:storm-data-updated/, 'saved places panel should refresh when storm context updates');
  assert.match(savedPlacesPanelSrc, /wm:saved-place-weather-updated/, 'saved places panel should refresh when cached place forecasts update');
});

test('alert center shows place context for breaking alerts and signals', () => {
  assert.match(alertCenterSrc, /getRecentBreakingAlerts/, 'alert center should seed from breaking-alert history');
  assert.match(alertCenterSrc, /placeSummary/, 'alert center should render saved-place context');
  assert.match(alertCenterSrc, /detail = a\.placeSummary/, 'alert center should append place context into the detail column');
});

test('offline cache exports raw entry helpers for saved-place brief persistence', () => {
  assert.match(offlineCacheSrc, /export function readOfflineCacheEntry/, 'offline cache should expose a read helper');
  assert.match(offlineCacheSrc, /export function writeOfflineCacheEntry/, 'offline cache should expose a write helper');
});
