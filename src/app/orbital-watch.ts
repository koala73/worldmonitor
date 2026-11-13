import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { OrbitalWatchPage, type OrbitalView } from '@/components/OrbitalWatchPage';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { formatOrbitalRoute, parseOrbitalRoute } from '@/app/orbital-route';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let raisedMap = false;

const MAP_FULLSCREEN_CLASS = 'live-news-fullscreen-active';

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cancel(): void {
  run?.abort();
  run = null;
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

const samePoint = (a: GeoPoint | null, b: GeoPoint) => !!a && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null, view: OrbitalView = 'sheet'): void {
  page ??= new OrbitalWatchPage({
    onClose: () => {
      cancel();
      lookup = null;
      point = null;
    },
    onRetry: () => void start(),
    onViewChange,
  });
  if (page.isOpen && samePoint(point, at)) {
    page.setView(view);
    return;
  }
  point = at;
  lookup = null;
  const wasFull = page.isOpen && page.currentView === 'full';
  page.open(at, returnFocusTo, view);
  if (view === 'full' || wasFull) onViewChange(view);
  void start();
}

/** Returns from the full view to the sheet, for a route that no longer names one. */
export function leaveOrbitalFullView(): void {
  if (page?.isOpen && page.currentView === 'full') page.setView('sheet');
}
