import { parseOrbitElements, type GeoPoint, type OrbitElements } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import { profileFor } from '@/services/orbital/pass-query';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { buildPassTrack, framingBounds, type FrameBounds, type OrbitalTarget, type PassTrack, type TrackPoint } from '@/services/orbital/track-geometry';
import { browserReplayDeps, createTrackReplay, type TrackReplay } from '@/services/orbital/track-replay';
import { ARCHIVE_SEARCHES, findArchiveEvidence, type MatchedAcquisition } from '@/services/orbital/match';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';
import { createReplayHud } from '@/components/OrbitalReplayHud';
import { formatTargetCoordinates, formatAcquiredLine } from '@/components/orbital-target-label';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;

/** The map the selected pass's ground track is drawn on. */
export interface OrbitalTrackSurface {
  setOrbitalTrack(track: PassTrack | null): void;
  setOrbitalTrackMarker(point: TrackPoint | null): void;
  setOrbitalTarget(target: OrbitalTarget | null): void;
  frameOrbitalBounds?(bounds: FrameBounds): void;
}

let surface: OrbitalTrackSurface | null = null;
let replay: TrackReplay | null = null;
let hudOverlay: HTMLElement | null = null;
let trackRequest = 0;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cancel(): void {
  run?.abort();
  run = null;
}

async function checkArchives(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress: null } });
  await afterDebugBearRequestWindow(signal);
  const evidence = await findArchiveEvidence(found, {
    signal,
    onProgress: (progress) => {
      if (!signal.aborted) page!.render({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress } });
    },
  });
  if (!signal.aborted) page!.render({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence } });
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
  hudOverlay?.remove();
  hudOverlay = null;
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

async function showTrack(pass: PointPass, acquisition: MatchedAcquisition | null): Promise<void> {
  clearTrack();
  const request = trackRequest;
  const target = surface;
  if (point) target?.setOrbitalTarget(targetFor(point, acquisition));
  const track = target ? await trackFor(pass).catch(() => null) : null;
  if (request !== trackRequest) return;
  page?.setTrackState(pass, target && track ? 'shown' : 'unavailable');
  if (!target || !track || !point) return;
  target.setOrbitalTrack(track);
  target.frameOrbitalBounds?.(framingBounds(track, point));
  const deps = browserReplayDeps();
  const hud = createReplayHud(track, deps.prefersReducedMotion(), {
    onToggle: () => (playing ? replay?.pause() : replay?.play()),
    onSeek: (progress) => replay?.seek(progress),
  });
  let playing = false;
  hudOverlay = hud.overlay;
  document.body.append(hud.overlay);
  page?.setReplayControls(pass, hud.controls);
  replay = createTrackReplay(track, (frame) => {
    playing = frame.playing;
    target.setOrbitalTrackMarker(frame.point);
    hud.update(frame);
  }, deps);
  replay.play();
}

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null, map: OrbitalTrackSurface | null = null): void {
  page ??= new OrbitalWatchPage({
    onClose: () => {
      cancel();
      clearTrack();
      surface?.setOrbitalTarget(null);
      surface = null;
      lookup = null;
      point = null;
    },
    onRetry: () => void start(),
    onSelectPass: (pass, acquisition) => void showTrack(pass, acquisition),
  });
  clearTrack();
  if (surface !== map) surface?.setOrbitalTarget(null);
  surface = map;
  point = at;
  surface?.setOrbitalTarget(targetFor(at, null));
  lookup = null;
  page.open(at, returnFocusTo);
  void start();
}

