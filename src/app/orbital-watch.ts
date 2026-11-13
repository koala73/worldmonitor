import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { orbitalLookupMap, setOrbitalLookupOpen } from '@/services/orbital/lookup-host';
import { t } from '@/services/i18n';
import { OrbitalWatchPage, type OrbitalView } from '@/components/OrbitalWatchPage';
import { OrbitalPlaceTools } from '@/components/OrbitalPlaceTools';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { formatOrbitalRoute, parseOrbitalRoute } from '@/app/orbital-route';
import { DASHBOARD_SITE_ORIGIN } from '@/config/dashboard-reference-links';
import { isDesktopRuntime } from '@/config/desktop-runtime';
import { buildOrbitalShareFragment, type OrbitalShareLink, type OrbitalSharePass } from '@/utils/urlState';

let page: OrbitalWatchPage | null = null;
let tools: OrbitalPlaceTools | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let raisedMap = false;
let linkedPass: OrbitalSharePass | null = null;
/** The pass last selected in the sheet, so a shared link opens on it too. */
let selectedPass: { noradId: number; timeMs: number } | null = null;
let returnFocus: HTMLElement | null = null;

const MAP_FULLSCREEN_CLASS = 'live-news-fullscreen-active';
const MINUTE_MS = 60_000;
/** Recomputed passes can shift by a minute when the orbit elements were refreshed in between. */
const LINKED_PASS_TOLERANCE_MS = 2 * MINUTE_MS;
const PLACE_ZOOM = 6;
const SHARE_LABEL_RESET_MS = 2000;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
/** The map centre is written to the page URL later, so it only ever carries a place to 0.1 degree. */
const coarse = (value: number) => Math.round(value * 10) / 10;

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

/** A shared pass, once the lookup has it, is selected; a pass no longer there gets a note. */
function applyLinkedPass(found: PointPassLookup): void {
  const wanted = linkedPass;
  linkedPass = null;
  if (!wanted) return;
  const inWindow = wanted.minuteMs + MINUTE_MS > found.window.startMs && wanted.minuteMs <= found.window.endMs;
  const match = inWindow
    ? found.passes.find((pass) => pass.noradId === wanted.noradId && Math.abs(pass.timeMs - wanted.minuteMs) <= LINKED_PASS_TOLERANCE_MS)
    : undefined;
  if (match && page?.select(`${match.noradId}:${match.timeMs}`)) return;
  tools!.showNote(t(inWindow ? 'orbitalWatch.share.passNotFound' : 'orbitalWatch.share.passOutsideWindow'));
  showSearchRow(true);
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
    if (!signal.aborted) applyLinkedPass(lookup);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) page!.render({ kind: 'unavailable' });
  }
}

const samePoint = (a: GeoPoint | null, b: GeoPoint) => !!a && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

function shareLink(): string | null {
  if (!point) return null;
  // The desktop WebView origin is local, so its links point at the public dashboard.
  const base = isDesktopRuntime() ? `${DASHBOARD_SITE_ORIGIN}/dashboard` : `${location.origin}${location.pathname}`;
  return `${base}#${buildOrbitalShareFragment(point, selectedPass, page?.currentView ?? 'sheet')}`;
}

let shareReset: ReturnType<typeof setTimeout> | null = null;

async function share(button: HTMLElement): Promise<void> {
  const copied = await tools!.share();
  if (!copied) {
    showSearchRow(true);
    return;
  }
  button.textContent = t('orbitalWatch.ui.shareCopied');
  if (shareReset) clearTimeout(shareReset);
  shareReset = setTimeout(() => { button.textContent = t('orbitalWatch.ui.share'); }, SHARE_LABEL_RESET_MS);
}

/** The search row sits under the place header; CHANGE opens it and a pick closes it. */
function showSearchRow(open: boolean): void {
  if (!page) return;
  page.slot('search').hidden = !open;
}

function ensurePage(): OrbitalWatchPage {
  tools ??= new OrbitalPlaceTools({ onPick: (at, name) => lookAt(at, name, { recentre: true, view: page?.currentView ?? 'sheet' }), shareLink });
  if (!page) {
    page = new OrbitalWatchPage({
      onClose: () => {
        cancel();
        lookup = null;
        point = null;
        linkedPass = null;
        selectedPass = null;
        returnFocus = null;
        tools!.reset();
        showSearchRow(false);
        setOrbitalLookupOpen(false);
      },
      onRetry: () => void start(),
      onViewChange,
      onChangePlace: () => {
        showSearchRow(true);
        tools!.focusSearch();
      },
      onShare: (button) => void share(button),
    });
    page.slot('search').append(tools.element);
    document.addEventListener('orbital-watch:select', (event) => {
      const { noradId, timeMs } = (event as CustomEvent<{ noradId: number; timeMs: number }>).detail;
      selectedPass = { noradId, timeMs };
    });
  }
  return page;
}

function lookAt(at: GeoPoint, name: string | null, { recentre, view }: { recentre: boolean; view: OrbitalView }): void {
  const sheet = ensurePage();
  tools!.clearNote();
  tools!.clearShare();
  showSearchRow(false);
  setOrbitalLookupOpen(true);
  if (sheet.isOpen && samePoint(point, at)) {
    sheet.setPlaceName(name);
    sheet.setView(view);
    if (recentre) recentreOn(at, view);
    return;
  }
  point = at;
  selectedPass = null;
  lookup = null;
  const wasFull = sheet.isOpen && sheet.currentView === 'full';
  sheet.open(at, returnFocus, view);
  sheet.setPlaceName(name);
  if (view === 'full' || wasFull) onViewChange(view);
  if (recentre) recentreOn(at, view);
  void start();
}

function recentreOn(at: GeoPoint, view: OrbitalView): void {
  const centre = () => orbitalLookupMap()?.setCenter(coarse(at.lat), coarse(at.lon), PLACE_ZOOM);
  centre();
  // Raising the map to full screen resizes it after this frame, which moves its centre.
  if (view === 'full') requestAnimationFrame(() => requestAnimationFrame(centre));
}

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null, view: OrbitalView = 'sheet'): void {
  returnFocus = returnFocusTo;
  linkedPass = null;
  lookAt(at, null, { recentre: false, view });
}

/** Opens the lookup with no place yet, focused on its search field. */
export function openOrbitalWatchSearch(returnFocusTo: HTMLElement | null): void {
  const sheet = ensurePage();
  if (!sheet.isOpen) {
    returnFocus = returnFocusTo;
    setOrbitalLookupOpen(true);
    sheet.open(null, returnFocus);
  }
  showSearchRow(true);
  tools!.focusSearch();
}

/** Opens a shared place in the view the link names, and its pass when that pass is still in the lookup window. */
export function openOrbitalShareLink(link: OrbitalShareLink, returnFocusTo: HTMLElement | null): void {
  returnFocus = returnFocusTo;
  linkedPass = link.pass;
  lookAt(link.point, null, { recentre: true, view: link.view });
}

/** Returns from the full view to the sheet, for a route that no longer names one. */
export function leaveOrbitalFullView(): void {
  if (page?.isOpen && page.currentView === 'full') page.setView('sheet');
}
