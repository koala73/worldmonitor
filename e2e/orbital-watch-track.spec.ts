import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { findPasses, parseOrbitElements, type GeoPoint, type OmmRecord } from '../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import { buildPassTrack, type PassTrack, type TrackPoint } from '../src/services/orbital/track-geometry';

type HarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    setCamera: (camera: { lon: number; lat: number; zoom: number }) => void;
    getDeckLayerSnapshot: () => { id: string; dataCount: number }[];
    setOrbitalTrack: (track: PassTrack | null, marker?: TrackPoint | null) => void;
    setOrbitalTarget: (point: GeoPoint | null) => void;
    moveOrbitalMarkerCountingRenders: (points: TrackPoint[]) => { renders: number; marker: unknown };
  };
};

const { records } = JSON.parse(readFileSync(new URL('../tests/fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8')) as { records: OmmRecord[] };
const NOW = Date.parse('2026-11-13T12:00:00Z');

function trackOver(name: string, point: GeoPoint, accept: (track: PassTrack) => boolean = () => true): PassTrack {
  const elements = parseOrbitElements(records.find((record) => record.OBJECT_NAME === name)!);
  const profile = matchSensorProfile(elements.noradId, elements.name)!;
  const { passes } = findPasses({ elements, profile, point, window: { start: NOW - 72 * 3_600_000, end: NOW }, now: NOW });
  const track = passes.map((pass) => buildPassTrack(elements, profile.footprint, pass)).find((t): t is PassTrack => t !== null && accept(t));
  if (!track) throw new Error(`no ${name} track over ${point.lat}, ${point.lon}`);
  return track;
}

const ORBITAL_LAYERS = ['orbital-footprint-layer', 'orbital-target-layer', 'orbital-track-layer', 'orbital-track-marker-layer'];

const ready = async (page: Page) => {
  await page.goto('/tests/map-harness.html');
  await page.waitForFunction(() => (window as HarnessWindow).__mapHarness?.ready);
  await page.evaluate(() => document.body.classList.remove('e2e-deterministic'));
};

const orbitalLayers = (page: Page) => page.evaluate((ids) => (window as HarnessWindow).__mapHarness!.getDeckLayerSnapshot()
  .filter((layer) => ids.includes(layer.id))
  .map((layer) => `${layer.id}:${layer.dataCount}`)
  .sort(), ORBITAL_LAYERS);

test('draws a selected pass track and footprint on the flat map, moves its marker, and removes them', async ({ page }) => {
  const track = trackOver('SENTINEL-2A', { lat: 48.85, lon: 2.35 });
  await ready(page);
  await page.evaluate(() => (window as HarnessWindow).__mapHarness!.setCamera({ lon: 2.35, lat: 48.85, zoom: 3 }));
  await page.evaluate((t) => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(t), track);
  await expect.poll(() => orbitalLayers(page)).toEqual([`orbital-footprint-layer:${track.footprint.length}`, `orbital-track-layer:${track.segments.length}`]);
  await page.evaluate((t) => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(t, t.closest), track);
  await expect.poll(() => orbitalLayers(page)).toContain('orbital-track-marker-layer:1');
  await page.screenshot({ path: '.claude/verify-evidence/orbital-track-flat.png' });
  const moved = await page.evaluate((points) => (window as HarnessWindow).__mapHarness!.moveOrbitalMarkerCountingRenders(points), track.segments.flat().slice(0, 5));
  expect(moved).toEqual({ renders: 0, marker: track.segments.flat()[4] });
  await page.evaluate(() => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(null));
  await expect.poll(() => orbitalLayers(page)).toEqual([]);
});

test('pins the looked-up point with or without a drawn pass', async ({ page }) => {
  const point = { lat: 25.112, lon: 55.139 };
  const track = trackOver('SENTINEL-2A', point);
  await ready(page);
  await page.evaluate((p) => (window as HarnessWindow).__mapHarness!.setOrbitalTarget(p), point);
  await expect.poll(() => orbitalLayers(page)).toEqual(['orbital-target-layer:1']);
  await page.evaluate((t) => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(t), track);
  await expect.poll(() => orbitalLayers(page)).toContain('orbital-target-layer:1');
  await page.evaluate(() => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(null));
  await expect.poll(() => orbitalLayers(page)).toEqual(['orbital-target-layer:1']);
  await page.evaluate(() => (window as HarnessWindow).__mapHarness!.setOrbitalTarget(null));
  await expect.poll(() => orbitalLayers(page)).toEqual([]);
});

test('draws a track over the antimeridian as two paths', async ({ page }) => {
  const track = trackOver('SENTINEL-2A', { lat: -17.7, lon: 178.5 }, (t) => t.segments.length > 1);
  await ready(page);
  await page.evaluate((t) => (window as HarnessWindow).__mapHarness!.setOrbitalTrack(t), track);
  await expect.poll(() => orbitalLayers(page)).toContain('orbital-track-layer:2');
});
