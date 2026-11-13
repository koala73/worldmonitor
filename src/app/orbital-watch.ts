import { parseOrbitElements, type GeoPoint, type OrbitElements } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import { profileFor } from '@/services/orbital/pass-query';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { buildPassTrack, type PassTrack, type TrackPoint } from '@/services/orbital/track-geometry';
import { browserReplayDeps, createTrackReplay, type TrackReplay } from '@/services/orbital/track-replay';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;

/** The map the selected pass's ground track is drawn on. */
export interface OrbitalTrackSurface {
  setOrbitalTrack(track: PassTrack | null): void;
  setOrbitalTrackMarker(point: TrackPoint | null): void;
  setOrbitalTarget(point: GeoPoint | null): void;
}

let surface: OrbitalTrackSurface | null = null;
let replay: TrackReplay | null = null;
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

async function showTrack(pass: PointPass): Promise<void> {
  clearTrack();
  const request = trackRequest;
  const target = surface;
  const track = target ? await trackFor(pass).catch(() => null) : null;
  if (request !== trackRequest) return;
  page?.setTrackState(pass, target && track ? 'shown' : 'unavailable');
  if (!target || !track) return;
  target.setOrbitalTrack(track);
  replay = createTrackReplay(track, (point) => target.setOrbitalTrackMarker(point), browserReplayDeps());
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
    onSelectPass: (pass) => void showTrack(pass),
    onReplayPass: () => replay?.play(),
  });
  clearTrack();
  if (surface !== map) surface?.setOrbitalTarget(null);
  surface = map;
  surface?.setOrbitalTarget(at);
  point = at;
  lookup = null;
  page.open(at, returnFocusTo);
  void start();
}

