import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { OrbitalWatchPage, type OrbitalView, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import { OrbitalTimeline, type OrbitalTimelineInput, type PointContextState } from '@/components/OrbitalTimeline';
import { loadPointContext } from '@/services/orbital/point-context';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { formatOrbitalRoute, parseOrbitalRoute } from '@/app/orbital-route';

let page: OrbitalWatchPage | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let raisedMap = false;
let timeline: OrbitalTimeline | null = null;
let timelinePasses: Pick<OrbitalTimelineInput, 'lookup' | 'passes' | 'acquisitions'> | null = null;
let pointContext: PointContextState = { kind: 'loading' };
let selectedPass: string | null = null;

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

function drawTimeline(): void {
  const slot = page?.slot('timeline');
  if (!slot) return;
  if (!timelinePasses) {
    slot.replaceChildren();
    return;
  }
  timeline ??= new OrbitalTimeline(selectTimelinePass);
  timeline.update({ ...timelinePasses, context: pointContext, selectedKey: selectedPass });
  if (timeline.element.parentElement !== slot) slot.replaceChildren(timeline.element);
}

/** A glyph picks its pass: the sheet row takes focus and the pass detail hears which pass it was. */
function selectTimelinePass(key: string): void {
  const pass = timelinePasses?.passes.find((candidate) => `${candidate.noradId}:${candidate.timeMs}` === key);
  if (!pass || !timeline) return;
  selectedPass = key;
  drawTimeline();
  const row = document.querySelector<HTMLElement>(`.orbital-watch-sheet .ow-row[data-key="pass:${CSS.escape(key)}"]`);
  row?.scrollIntoView?.({ block: 'nearest' });
  row?.focus({ preventScroll: true });
  timeline.element.dispatchEvent(new CustomEvent('orbital-watch:select-pass', { bubbles: true, detail: { noradId: pass.noradId, timeMs: pass.timeMs } }));
}

/** Renders the sheet and keeps the timeline dock on the same passes, with archive tiers as soon as any archive answers. */
function show(state: OrbitalWatchState): void {
  page!.render(state);
  if (state.kind !== 'passes') {
    timelinePasses = null;
  } else {
    const evidence = state.archives.kind === 'answered' ? state.archives.evidence : state.archives.progress?.evidence ?? null;
    timelinePasses = { lookup: state.lookup, passes: evidence?.passes ?? state.lookup.passes, acquisitions: evidence?.acquisitions ?? [] };
  }
  drawTimeline();
}

function loadContext(found: PointPassLookup, signal: AbortSignal): void {
  pointContext = { kind: 'loading' };
  void loadPointContext(found.point, found.window, found.nowMs).then((context) => {
    if (signal.aborted) return;
    pointContext = { kind: 'loaded', context };
    drawTimeline();
  });
}

async function checkArchives(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  show({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress: null } });
  await afterDebugBearRequestWindow(signal);
  const evidence = await findArchiveEvidence(found, {
    signal,
    onProgress: (progress) => {
      if (!signal.aborted) show({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress } });
    },
  });
  if (!signal.aborted) show({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence } });
}

async function start(): Promise<void> {
  cancel();
  const controller = new AbortController();
  run = controller;
  const { signal } = controller;
  try {
    if (!lookup) {
      show({ kind: 'computing', done: 0, total: 0 });
      const found = await getOrbitalPassClient().lookup({ point: point! }, {
        signal,
        onProgress: (done, total) => {
          if (!signal.aborted) show({ kind: 'computing', done, total });
        },
      });
      if (signal.aborted) return;
      if (found.catalog.status === 'empty') {
        show({ kind: 'unavailable' });
        return;
      }
      lookup = found;
    }
    loadContext(lookup, signal);
    await checkArchives(lookup, signal);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) show({ kind: 'unavailable' });
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
      timelinePasses = null;
      selectedPass = null;
      drawTimeline();
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
  selectedPass = null;
  const wasFull = page.isOpen && page.currentView === 'full';
  page.open(at, returnFocusTo, view);
  if (view === 'full' || wasFull) onViewChange(view);
  void start();
}

/** Returns from the full view to the sheet, for a route that no longer names one. */
export function leaveOrbitalFullView(): void {
  if (page?.isOpen && page.currentView === 'full') page.setView('sheet');
}
