import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import { ARCHIVE_SEARCHES, findArchiveEvidence } from '@/services/orbital/match';
import { orbitalLookupMap, setOrbitalLookupOpen } from '@/services/orbital/lookup-host';
import { t } from '@/services/i18n';
import { OrbitalWatchPage } from '@/components/OrbitalWatchPage';
import { OrbitalPlaceTools } from '@/components/OrbitalPlaceTools';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { DASHBOARD_SITE_ORIGIN } from '@/config/dashboard-reference-links';
import { isDesktopRuntime } from '@/config/desktop-runtime';
import { buildOrbitalShareFragment, type OrbitalShareLink, type OrbitalSharePass } from '@/utils/urlState';

let page: OrbitalWatchPage | null = null;
let tools: OrbitalPlaceTools | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let returnFocus: HTMLElement | null = null;
let linkedPass: OrbitalSharePass | null = null;

const MINUTE_MS = 60_000;
/** Recomputed passes can shift by a minute when the orbit elements were refreshed in between. */
const LINKED_PASS_TOLERANCE_MS = 2 * MINUTE_MS;
const PLACE_ZOOM = 6;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
/** The map centre is written to the page URL later, so it only ever carries a place to 0.1 degree. */
const coarse = (value: number) => Math.round(value * 10) / 10;

function cancel(): void {
  run?.abort();
  run = null;
}

function applyLinkedPass(found: PointPassLookup): void {
  const wanted = linkedPass;
  linkedPass = null;
  if (!wanted) return;
  const inWindow = wanted.minuteMs + MINUTE_MS > found.window.startMs && wanted.minuteMs <= found.window.endMs;
  const match = inWindow
    ? found.passes.find((pass) => pass.noradId === wanted.noradId && Math.abs(pass.timeMs - wanted.minuteMs) <= LINKED_PASS_TOLERANCE_MS)
    : undefined;
  if (match) page!.selectPass({ noradId: match.noradId, timeMs: match.timeMs });
  else tools!.showNote(t(inWindow ? 'orbitalWatch.share.passNotFound' : 'orbitalWatch.share.passOutsideWindow'));
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
  if (!point) return;
  const controller = new AbortController();
  run = controller;
  const { signal } = controller;
  try {
    if (!lookup) {
      page!.render({ kind: 'computing', done: 0, total: 0 });
      const found = await getOrbitalPassClient().lookup({ point }, {
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
      applyLinkedPass(found);
    }
    await checkArchives(lookup, signal);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) page!.render({ kind: 'unavailable' });
  }
}

function shareLink(): string | null {
  if (!point) return null;
  // The desktop WebView origin is local, so its links point at the public dashboard.
  const base = isDesktopRuntime() ? `${DASHBOARD_SITE_ORIGIN}/dashboard` : `${location.origin}${location.pathname}`;
  return `${base}#${buildOrbitalShareFragment(point, page?.selectedPass)}`;
}

function ensurePage(): OrbitalWatchPage {
  tools ??= new OrbitalPlaceTools({ onPick: (at) => lookAt(at, { recentre: true }), shareLink });
  page ??= new OrbitalWatchPage({
    onClose: () => {
      cancel();
      lookup = null;
      point = null;
      linkedPass = null;
      returnFocus = null;
      tools!.reset();
      setOrbitalLookupOpen(false);
    },
    onRetry: () => void start(),
  }, { tools: tools.element });
  return page;
}

function lookAt(at: GeoPoint, { recentre }: { recentre: boolean }): void {
  const sheet = ensurePage();
  point = at;
  lookup = null;
  tools!.clearNote();
  tools!.setPlaceOpen(true);
  setOrbitalLookupOpen(true);
  if (recentre) orbitalLookupMap()?.setCenter(coarse(at.lat), coarse(at.lon), PLACE_ZOOM);
  sheet.open(at, returnFocus);
  void start();
}

/** Opens the satellite pass lookup for a point. The point stays in the browser. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null): void {
  returnFocus = returnFocusTo;
  linkedPass = null;
  lookAt(at, { recentre: false });
}

/** Opens the lookup with no place yet, focused on its search field. */
export function openOrbitalWatchSearch(returnFocusTo: HTMLElement | null): void {
  const sheet = ensurePage();
  if (!sheet.isOpen) {
    returnFocus = returnFocusTo;
    setOrbitalLookupOpen(true);
    sheet.open(null, returnFocus);
  }
  tools!.focusSearch();
}

/** Opens a shared place, and its pass when that pass is still in the lookup window. */
export function openOrbitalShareLink(link: OrbitalShareLink, returnFocusTo: HTMLElement | null): void {
  returnFocus = returnFocusTo;
  linkedPass = link.pass;
  lookAt(link.point, { recentre: true });
}
