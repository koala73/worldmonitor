import { parseOrbitElements, type GeoPoint, type OrbitElements } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import { profileFor } from '@/services/orbital/pass-query';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { buildPassTrack, framingBounds, type FrameBounds, type OrbitalTarget, type PassTrack, type TrackPoint } from '@/services/orbital/track-geometry';
import { browserReplayDeps, createTrackReplay, type TrackReplay } from '@/services/orbital/track-replay';
import { ARCHIVE_SEARCHES, findArchiveEvidence, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import { OrbitalWatchPage, type OrbitalView } from '@/components/OrbitalWatchPage';
import { createReplayHud } from '@/components/OrbitalReplayHud';
import { formatAcquiredLine, formatTargetCoordinates } from '@/components/orbital-target-label';
import { t } from '@/services/i18n';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { formatOrbitalRoute, parseOrbitalRoute } from '@/app/orbital-route';
import { claimMapUrlCentre, getOrbitalMapView, releaseMapUrlCentreOnUserMove, type MapCamera } from '@/app/orbital-map-focus';
import { visibleMapArea, type ScreenArea } from '@/utils/map-point-offset';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let evidence: OrbitalEvidence | null = null;
let raisedMap = false;
let markFrame: number | null = null;
let centredFor: string | null = null;
/** Where the map was before the lookup first moved it; closing puts it back, so the point never becomes the map centre. */
let homeCamera: MapCamera | null = null;
const RETRY = 'retry';

/** The map the replayed pass's ground track is drawn on. */
export interface OrbitalTrackSurface {
  setOrbitalTrack(track: PassTrack | null): void;
  setOrbitalTrackMarker(point: TrackPoint | null): void;
  setOrbitalTarget(target: OrbitalTarget | null): void;
  frameOrbitalBounds?(bounds: FrameBounds, occluders?: DOMRect[]): void;
}

let surface: OrbitalTrackSurface | null = null;
let replay: TrackReplay | null = null;
let trackRequest = 0;
let targetDrawn = false;

const MAP_FULLSCREEN_CLASS = 'live-news-fullscreen-active';

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cancel(): void {
  run?.abort();
  run = null;
}

function mapArea(): { map: DOMRect; area: ScreenArea } | null {
  const map = getOrbitalMapView()?.rect();
  if (!map || !page?.isOpen || map.width <= 0 || map.height <= 0) return null;
  return { map, area: visibleMapArea(map, page.coverRects()) };
}

const layoutKey = ({ map, area }: { map: DOMRect; area: ScreenArea }) =>
  [map.left, map.top, map.width, map.height, area.left, area.top, area.right, area.bottom].map(Math.round).join();

/** Centres the point in the part of the map the sheet leaves visible. */
function centreMap(): void {
  const view = getOrbitalMapView();
  const box = mapArea();
  if (!view || !box || !point) return;
  const { map, area } = box;
  const offset = {
    x: (area.left + area.right - map.left - map.right) / 2,
    y: (area.top + area.bottom - map.top - map.bottom) / 2,
  };
  homeCamera ??= view.camera();
  // A map still booting cannot move yet; RETRY never matches a layout, so the next frame tries again.
  centredFor = view.center(point, offset) ? layoutKey(box) : RETRY;
}

/** Keeps the reticle on the point as the map moves, while the lookup is open. */
function trackMark(): void {
  markFrame = null;
  if (!page?.isOpen || !point) return;
  const box = mapArea();
  // A resize (the map raised for the full view, a rotated phone) moves the visible area, so centre again.
  if (box && centredFor !== null && centredFor !== layoutKey(box)) centreMap();
  const at = getOrbitalMapView()?.project(point) ?? null;
  const area = box?.area;
  const inside = !!at && !!area && at.x >= area.left && at.x <= area.right && at.y >= area.top && at.y <= area.bottom;
  page.placeMapMark(inside && !targetDrawn ? at : null);
  markFrame = requestAnimationFrame(trackMark);
}

/** Flies the map to the point once the sheet's layout, and a raised map's size, have settled. */
function focusMap(): void {
  centredFor = null;
  getOrbitalMapView()?.hold(true);
  requestAnimationFrame(() => requestAnimationFrame(centreMap));
  if (markFrame === null) markFrame = requestAnimationFrame(trackMark);
}

/** The full view sits over the map, so the map is raised to fill the page while it is open. */
function syncMap(view: OrbitalView): void {
  const button = document.getElementById('mapFullscreenBtn');
  const active = document.body.classList.contains(MAP_FULLSCREEN_CLASS);
  if (view === 'full' && !active && button) {
    button.click();
    raisedMap = true;
  } else if (view === 'sheet' && raisedMap) {
    if (active) button?.click();
    raisedMap = false;
  }
  // The full view is the lookup's own map; the sheet leaves the dashboard as it is.
  getOrbitalMapView()?.suppressLayers(view === 'full');
  focusMap();
}

function writeRoute(view: OrbitalView): void {
  const url = new URL(window.location.href);
  if (view === 'full' && point) url.hash = formatOrbitalRoute(point, 'full');
  else if (parseOrbitalRoute(url.hash)) url.hash = '';
  else return;
  try {
    history.replaceState(history.state, '', url.toString());
  } catch {
    // A sandboxed or file document can refuse; the view still changes.
  }
}

function onViewChange(view: OrbitalView): void {
  writeRoute(view);
  syncMap(view);
}

async function checkArchives(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress: null } });
  await afterDebugBearRequestWindow(signal);
  const result = await findArchiveEvidence(found, {
    signal,
    onProgress: (progress) => {
      if (!signal.aborted) page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress } });
    },
  });
  if (signal.aborted) return;
  evidence = result;
  page!.render({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence: result } });
}

async function start(): Promise<void> {
  cancel();
  const controller = new AbortController();
  run = controller;
  const { signal } = controller;
  try {
    if (!lookup) {
      page!.render({ kind: 'computing', done: 0, total: 0 });
      const found = await getOrbitalPassClient().lookup({ point: point! }, {
        signal,
        onProgress: (done, total) => {
          if (!signal.aborted) page!.render({ kind: 'computing', done, total });
        },
      });
      if (signal.aborted) return;
      if (found.catalog.status === 'empty') {
        page!.render({ kind: 'unavailable' });
        return;
      }
      lookup = found;
    }
    await checkArchives(lookup, signal);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) page!.render({ kind: 'unavailable' });
  }
}

function clearTrack(): void {
  trackRequest += 1;
  replay?.stop();
  replay = null;
  page?.slot('replay-hud').replaceChildren();
  surface?.setOrbitalTrack(null);
}

function parseSets(records: Parameters<typeof parseOrbitElements>[0][]): OrbitElements[] {
  return records.flatMap((record) => {
    try {
      return [parseOrbitElements(record)];
    } catch {
      return [];
    }
  });
}

async function trackFor(pass: PointPass): Promise<PassTrack | null> {
  const profile = profileFor(pass.profileId);
  const satellite = (await loadOrbitalCatalog()).satellites.find((s) => s.noradId === pass.noradId);
  if (!profile || !satellite) return null;
  const sets = parseSets(satellite.elementSets);
  if (sets.length === 0) return null;
  const elements = sets.reduce((best, next) =>
    Math.abs(next.epochMs - pass.elementsEpochMs) < Math.abs(best.epochMs - pass.elementsEpochMs) ? next : best);
  return buildPassTrack(elements, profile.footprint, pass);
}

function targetFor(at: GeoPoint, acquisition: MatchedAcquisition | null): OrbitalTarget {
  return { lat: at.lat, lon: at.lon, lines: [formatTargetCoordinates(at), ...(acquisition ? [formatAcquiredLine(acquisition)] : [])] };
}

/** Frames the pass in the part of the map the lookup's sheet, dock and HUD leave visible. */
function frameTrack(target: OrbitalTrackSurface, track: PassTrack, at: GeoPoint, slot: HTMLElement): void {
  const occluders = [...(page?.coverRects() ?? []), ...[...slot.children].map((el) => el.getBoundingClientRect())];
  target.frameOrbitalBounds?.(framingBounds(track, at), occluders);
}

/** Draws the point's reticle and tag on the map, which then stands in for the sheet's own map mark. */
function drawTarget(target: OrbitalTarget | null): void {
  surface?.setOrbitalTarget(target);
  targetDrawn = !!surface && !!target;
}

/** Draws a pass's ground track and swath on the map and plays it into the replay HUD slot. */
async function showTrack(noradId: number, timeMs: number): Promise<void> {
  const pass = lookup?.passes.find((p) => p.noradId === noradId && p.timeMs === timeMs);
  if (!pass || !point) return;
  const acquisition = evidence?.acquisitions.find((a) => a.pass?.noradId === noradId && a.pass.timeMs === timeMs) ?? null;
  clearTrack();
  const request = trackRequest;
  const target = surface;
  const at = point;
  drawTarget(targetFor(at, acquisition));
  const track = target ? await trackFor(pass).catch(() => null) : null;
  if (request !== trackRequest || !page?.isOpen) return;
  const slot = page.slot('replay-hud');
  if (!target || !track) {
    slot.replaceChildren(Object.assign(document.createElement('p'), { className: 'ow-track-note ow-label', textContent: t('orbitalWatch.track.unavailable') }));
    return;
  }
  target.setOrbitalTrack(track);
  const deps = browserReplayDeps();
  let playing = false;
  const hud = createReplayHud(track, deps.prefersReducedMotion(), {
    onToggle: () => (playing ? replay?.pause() : replay?.play()),
    onSeek: (progress) => replay?.seek(progress),
  });
  slot.replaceChildren(hud.overlay, hud.controls);
  frameTrack(target, track, at, slot);
  replay = createTrackReplay(track, (frame) => {
    playing = frame.playing;
    target.setOrbitalTrackMarker(frame.point);
    hud.update(frame);
  }, deps);
  replay.play();
}

function onReplayRequest(event: Event): void {
  const { noradId, timeMs } = (event as CustomEvent<{ noradId: number; timeMs: number }>).detail;
  void showTrack(noradId, timeMs);
}

const samePoint = (a: GeoPoint | null, b: GeoPoint) => !!a && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null, view: OrbitalView = 'sheet', map?: OrbitalTrackSurface | null): void {
  if (!page) document.addEventListener('orbital-watch:replay', onReplayRequest);
  page ??= new OrbitalWatchPage({
    onClose: () => {
      getOrbitalMapView()?.hold(false);
      getOrbitalMapView()?.suppressLayers(false);
      if (homeCamera) getOrbitalMapView()?.restore(homeCamera);
      homeCamera = null;
      releaseMapUrlCentreOnUserMove(document.getElementById('mapContainer'));
      cancel();
      clearTrack();
      drawTarget(null);
      surface = null;
      lookup = null;
      evidence = null;
      point = null;
    },
    onRetry: () => void start(),
    onViewChange,
  });
  const moved = map !== undefined && map !== surface;
  if (moved) {
    clearTrack();
    drawTarget(null);
    surface = map;
  }
  if (page.isOpen && samePoint(point, at)) {
    if (moved) drawTarget(targetFor(at, null));
    page.setView(view);
    return;
  }
  clearTrack();
  point = at;
  drawTarget(targetFor(at, null));
  lookup = null;
  evidence = null;
  claimMapUrlCentre();
  const wasFull = page.isOpen && page.currentView === 'full';
  page.open(at, returnFocusTo, view);
  if (view === 'full' || wasFull) onViewChange(view);
  else focusMap();
  void start();
}

/** Returns from the full view to the sheet, for a route that no longer names one. */
export function leaveOrbitalFullView(): void {
  if (page?.isOpen && page.currentView === 'full') page.setView('sheet');
}
