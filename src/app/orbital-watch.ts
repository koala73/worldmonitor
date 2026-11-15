import { parseOrbitElements, type GeoPoint, type OrbitElements } from '../../shared/orbital/pass-geometry.js';
import { getOrbitalPassClient, type PointPassLookup } from '@/services/orbital/pass-client';
import type { PointPass } from '@/services/orbital/pass-job';
import { profileFor } from '@/services/orbital/pass-query';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { buildPassTrack, framingBounds, type FrameBounds, type OrbitalTarget, type PassTrack, type TrackPoint } from '@/services/orbital/track-geometry';
import { ARCHIVE_SEARCHES, findArchiveEvidence, type MatchedAcquisition, type OrbitalEvidence } from '@/services/orbital/match';
import { setOrbitalLookupOpen } from '@/services/orbital/lookup-host';
import { t } from '@/services/i18n';
import { OrbitalWatchPage, type OrbitalWatchState } from '@/components/OrbitalWatchPage';
import { OrbitalTimeline, type OrbitalTimelineInput, type PointContextState } from '@/components/OrbitalTimeline';
import { formatAcquiredLine, formatTargetCoordinates } from '@/components/orbital-target-label';
import { loadPointContext } from '@/services/orbital/point-context';
import { loadWatchedSiteRecord, watchedSiteAt as watchedSiteRecordAt } from '@/services/orbital/watched-site-at';
import { OrbitalPlaceTools } from '@/components/OrbitalPlaceTools';
import { markSiteSatelliteSelected, siteSatellitesSection, type SiteSatellitesState } from '@/components/orbital-site-satellites-view';
import { loadWatchedSites, satellitesCoveringSite, watchedSiteAt, type CoverageSite } from '@/services/orbital/satellite-site-coverage';
import { fetchSatelliteTLEs, getTrackedSatelliteTles } from '@/services/satellites';
import { confirmShareLinkCopied } from '@/components/share-link-button';
import { afterDebugBearRequestWindow } from '@/bootstrap/debugbear-rum';
import { DASHBOARD_SITE_ORIGIN } from '@/config/dashboard-reference-links';
import { isDesktopRuntime } from '@/config/desktop-runtime';
import { buildOrbitalShareFragment, type OrbitalShareLink, type OrbitalSharePass } from '@/utils/urlState';
import { ORBITAL_LOOKUP_MAX_ZOOM, claimMapUrlCentre, getOrbitalMapView, releaseMapUrlCentreOnUserMove, type MapCamera } from '@/app/orbital-map-focus';
import { visibleMapArea, type ScreenArea } from '@/utils/map-point-offset';

let page: OrbitalWatchPage | null = null;
let tools: OrbitalPlaceTools | null = null;
let point: GeoPoint | null = null;
let lookup: PointPassLookup | null = null;
let run: AbortController | null = null;
let siteRun: AbortController | null = null;
/** The open point's site record failed; reopening the point reads it again. */
let siteFailed = false;
/** The open point is the user's own located position: no site read, since a site id would name where they are. */
let pointIsLocated = false;
let evidence: OrbitalEvidence | null = null;
let linkedPass: OrbitalSharePass | null = null;
/** The pass last selected in the sheet, so a shared link opens on it too. */
let selectedPass: { noradId: number; timeMs: number } | null = null;
let returnFocus: HTMLElement | null = null;
let timeline: OrbitalTimeline | null = null;
let timelinePasses: Pick<OrbitalTimelineInput, 'lookup' | 'passes' | 'acquisitions'> | null = null;
let pointContext: PointContextState = { kind: 'loading' };
/** The watched site at the open point and the tracked satellites over it, or null for any other point. */
let siteSatellites: { site: CoverageSite; state: SiteSatellitesState } | null = null;
const SITE_SATELLITES_TICK_MS = 30_000;
let markFrame: number | null = null;
let centredFor: string | null = null;
/** Where the map was before the lookup first moved it; closing puts it back, so the point never becomes the map centre. */
let homeCamera: MapCamera | null = null;
const RETRY = 'retry';

/** The map the selected pass's ground track and footprint are drawn on. */
export interface OrbitalTrackSurface {
  setOrbitalTrack(track: PassTrack | null): void;
  setOrbitalTrackMarker(point: TrackPoint | null): void;
  setOrbitalTarget(target: OrbitalTarget | null): void;
  frameOrbitalBounds?(bounds: FrameBounds, occluders?: DOMRect[]): void;
}

let surface: OrbitalTrackSurface | null = null;
let trackRequest = 0;
let targetDrawn = false;

const MINUTE_MS = 60_000;
/** Recomputed passes can shift by a minute when the orbit elements were refreshed in between. */
const LINKED_PASS_TOLERANCE_MS = 2 * MINUTE_MS;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cancel(): void {
  run?.abort();
  run = null;
}

function mapArea(): { map: DOMRect; area: ScreenArea } | null {
  const map = getOrbitalMapView()?.rect();
  if (!map || !page?.isOpen || map.width <= 0 || map.height <= 0) return null;
  page.dockTo(map);
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
  // A resize (a rotated phone, the sheet changing height) moves the visible area, so centre again.
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

/** The open point's archives have answered, so a linked pass can be selected at once. */
let evidenceReady = false;

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

const selectedKey = () => (selectedPass ? `${selectedPass.noradId}:${selectedPass.timeMs}` : null);

function drawTimeline(): void {
  const slot = page?.slot('timeline');
  if (!slot) return;
  if (!timelinePasses) {
    slot.replaceChildren();
    return;
  }
  timeline ??= new OrbitalTimeline(selectTimelinePass);
  timeline.update({ ...timelinePasses, context: pointContext, selectedKey: selectedKey() });
  if (timeline.element.parentElement !== slot) slot.replaceChildren(timeline.element);
}

/** A glyph picks its pass the same way a sheet row does; both end in `selectPass`. */
function selectTimelinePass(key: string): void {
  // Focus stays on the mark that was activated; the list row is only marked.
  if (page?.select(key, { focus: false })) return;
  const [noradId, timeMs] = key.split(':').map(Number);
  selectPass(noradId!, timeMs!);
}

/** One selection for the list, the timeline and the map: each redraws from here, and the map draws the pass's track and footprint. */
function selectPass(noradId: number, timeMs: number): void {
  selectedPass = { noradId, timeMs };
  drawTimeline();
  const slot = page?.slot('satellites');
  if (slot) markSiteSatelliteSelected(slot, selectedKey());
  void showTrack(noradId, timeMs);
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
  page?.setPointContext(pointContext);
  void loadPointContext(found.point, found.window, found.nowMs).then((context) => {
    if (signal.aborted) return;
    pointContext = { kind: 'loaded', context };
    page?.setPointContext(pointContext);
    drawTimeline();
  });
}

/** When the point falls on a watched site, reads that site's public record by its id; the point stays here. */
function loadWatchedSite(at: GeoPoint): void {
  siteRun?.abort();
  siteFailed = false;
  if (pointIsLocated) { siteRun = null; page?.setWatchedSite({ kind: 'none' }); return; }
  const controller = new AbortController();
  siteRun = controller;
  const { signal } = controller;
  void watchedSiteRecordAt(at).then(async (site) => {
    if (signal.aborted || !site) return;
    page?.setWatchedSite({ kind: 'loading', site });
    try {
      const record = await loadWatchedSiteRecord(site.id, signal);
      if (!signal.aborted) page?.setWatchedSite({ kind: 'loaded', site, record });
    } catch {
      if (signal.aborted) return;
      siteFailed = true;
      page?.setWatchedSite({ kind: 'failed', site });
    }
  }, () => {});
}

/** The lookup's own pass for a tracked satellite's approach, so its row selects it. */
function lookupPassKey(noradId: string, timeMs: number): string | null {
  const pass = (evidence?.passes ?? lookup?.passes)?.find((p) =>
    String(p.noradId) === noradId && Math.abs(p.timeMs - timeMs) <= LINKED_PASS_TOLERANCE_MS && p.tier.kind !== 'daily-mosaic');
  return pass ? `${pass.noradId}:${pass.timeMs}` : null;
}

function drawSiteSatellites(): void {
  const slot = page?.slot('satellites');
  if (!slot) return;
  if (!siteSatellites) {
    slot.replaceChildren();
    return;
  }
  const expanded = slot.querySelector('[data-section="site-satellites"] .ies-more')?.getAttribute('aria-expanded') === 'true';
  const focused = document.activeElement instanceof HTMLElement && slot.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused?.classList.contains('ies-more') ? '.ies-more' : focused?.dataset.key ? `[data-key="${CSS.escape(focused.dataset.key)}"]` : null;
  slot.replaceChildren(siteSatellitesSection(siteSatellites.site, siteSatellites.state, {
    nowMs: Date.now(),
    passKey: lookupPassKey,
    selectedKey: selectedKey(),
    expanded,
  }));
  if (refocus) slot.querySelector<HTMLElement>(refocus)?.focus({ preventScroll: true });
}

/**
 * A watched site's sheet lists the tracked satellites that cover it, the reverse of a
 * satellite card's site list. The site is matched and the passes projected in the
 * browser from the public registry and element sets, so the point never leaves it.
 */
async function loadSiteSatellites(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  siteSatellites = null;
  drawSiteSatellites();
  const site = watchedSiteAt(found.point, await loadWatchedSites().catch(() => []));
  if (!site || signal.aborted) return;
  const draw = (state: SiteSatellitesState) => {
    siteSatellites = { site, state };
    drawSiteSatellites();
  };
  draw({ kind: 'projecting' });
  try {
    const tracked = getTrackedSatelliteTles();
    const tles = tracked.length > 0 ? tracked : (await fetchSatelliteTLEs()) ?? [];
    if (signal.aborted) return;
    if (tles.length === 0) {
      draw({ kind: 'not-loaded' });
      return;
    }
    const project = async () => {
      const satellites = await satellitesCoveringSite({ site, tles, nowMs: Date.now(), signal });
      if (!signal.aborted) draw({ kind: 'ok', satellites });
    };
    await project();
    if (signal.aborted) return;
    // The open list moves with the clock: elapsed passes drop out and, once its window has
    // slid far enough, the cached scans renew, so no past pass is labelled upcoming.
    const clock = setInterval(() => {
      project().catch((error: unknown) => {
        if (!isAbort(error) && !signal.aborted) draw({ kind: 'failed' });
      });
    }, SITE_SATELLITES_TICK_MS);
    signal.addEventListener('abort', () => clearInterval(clock), { once: true });
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) draw({ kind: 'failed' });
  }
}

async function checkArchives(found: PointPassLookup, signal: AbortSignal): Promise<void> {
  show({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress: null } });
  await afterDebugBearRequestWindow(signal);
  const result = await findArchiveEvidence(found, {
    signal,
    onProgress: (progress) => {
      if (!signal.aborted) show({ kind: 'passes', lookup: found, archives: { kind: 'checking', total: ARCHIVE_SEARCHES.length, progress } });
    },
  });
  if (signal.aborted) return;
  evidence = result;
  show({ kind: 'passes', lookup: found, archives: { kind: 'answered', evidence: result } });
  drawSiteSatellites();
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
    void loadSiteSatellites(lookup, signal);
    await checkArchives(lookup, signal);
    if (signal.aborted) return;
    evidenceReady = true;
    applyLinkedPass(lookup);
  } catch (error) {
    if (!isAbort(error) && !signal.aborted) show({ kind: 'unavailable' });
  }
}

function clearTrack(): void {
  trackRequest += 1;
  surface?.setOrbitalTrack(null);
  surface?.setOrbitalTrackMarker(null);
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

/** Frames the pass in the part of the map the lookup's sheet leaves visible. */
function frameTrack(target: OrbitalTrackSurface, track: PassTrack, at: GeoPoint): void {
  target.frameOrbitalBounds?.(framingBounds(track, at), page?.coverRects() ?? []);
}

/** Draws the point's reticle and tag on the map, which then stands in for the sheet's own map mark. */
function drawTarget(target: OrbitalTarget | null): void {
  surface?.setOrbitalTarget(target);
  targetDrawn = !!surface && !!target;
}

/** Draws the selected pass's ground track and footprint on the map, with the satellite at its closest approach. */
async function showTrack(noradId: number, timeMs: number): Promise<void> {
  const pass = (evidence?.passes ?? lookup?.passes)?.find((p) => p.noradId === noradId && p.timeMs === timeMs);
  if (!pass || !point) return;
  const acquisition = evidence?.acquisitions.find((a) => a.pass?.noradId === noradId && a.pass.timeMs === timeMs) ?? null;
  clearTrack();
  const request = trackRequest;
  const target = surface;
  const at = point;
  drawTarget(targetFor(at, acquisition));
  const track = target ? await trackFor(pass).catch(() => null) : null;
  if (request !== trackRequest || !page?.isOpen || !target || !track) return;
  target.setOrbitalTrack(track);
  target.setOrbitalTrackMarker(track.closest);
  frameTrack(target, track, at);
}

const samePoint = (a: GeoPoint | null, b: GeoPoint) => !!a && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

function shareLink(): string | null {
  if (!point) return null;
  // The desktop WebView origin is local, so its links point at the public dashboard.
  const base = isDesktopRuntime() ? `${DASHBOARD_SITE_ORIGIN}/dashboard` : `${location.origin}${location.pathname}`;
  return `${base}#${buildOrbitalShareFragment(point, selectedPass)}`;
}

async function share(button: HTMLElement): Promise<void> {
  if (await tools!.share()) confirmShareLinkCopied(button, t('orbitalWatch.share.copied'));
  else showSearchRow(true);
}

/** The search row sits under the place header; CHANGE opens it and a pick closes it. */
function showSearchRow(open: boolean): void {
  if (!page) return;
  page.slot('search').hidden = !open;
}

function ensurePage(): OrbitalWatchPage {
  tools ??= new OrbitalPlaceTools({ onPick: (at, name, located) => lookAt(at, name, { recentre: true, located }), shareLink });
  if (!page) {
    page = new OrbitalWatchPage({
      onClose: () => {
        getOrbitalMapView()?.hold(false);
        // Lift the cap first: the camera from before the lookup may be zoomed in past it, and carries no point.
        getOrbitalMapView()?.capZoom(null);
        if (homeCamera) getOrbitalMapView()?.restore(homeCamera);
        homeCamera = null;
        releaseMapUrlCentreOnUserMove(document.getElementById('mapContainer'));
        cancel();
        siteRun?.abort();
        siteRun = null;
        clearTrack();
        drawTarget(null);
        surface = null;
        lookup = null;
        evidence = null;
        point = null;
        linkedPass = null;
        selectedPass = null;
        returnFocus = null;
        timelinePasses = null;
        drawTimeline();
        tools!.reset();
        showSearchRow(false);
        setOrbitalLookupOpen(false);
      },
      onRetry: () => void start(),
      onChangePlace: () => {
        showSearchRow(true);
        tools!.focusSearch();
      },
      onShare: (button) => void share(button),
    });
    page.slot('search').append(tools.element);
    document.addEventListener('orbital-watch:select', (event) => {
      const { noradId, timeMs } = (event as CustomEvent<{ noradId: number; timeMs: number }>).detail;
      selectPass(noradId, timeMs);
    });
    document.addEventListener('orbital-watch:zone-change', drawTimeline);
  }
  return page;
}

/** Points the lookup at the map its pass tracks are drawn on; `undefined` keeps the current one. */
function useSurface(map: OrbitalTrackSurface | null | undefined): boolean {
  const moved = map !== undefined && map !== surface;
  if (moved) {
    clearTrack();
    drawTarget(null);
    surface = map;
  }
  return moved;
}

function lookAt(at: GeoPoint, name: string | null, { recentre, map, located = false }: { recentre: boolean; map?: OrbitalTrackSurface | null; located?: boolean }): void {
  const sheet = ensurePage();
  const moved = useSurface(map);
  tools!.clearNote();
  tools!.clearShare();
  showSearchRow(false);
  setOrbitalLookupOpen(true);
  // Every way in comes through here: the map keeps its zoom from before, then is held where a tile cannot name the point (#10704).
  const mapView = getOrbitalMapView();
  homeCamera ??= mapView?.camera() ?? null;
  mapView?.capZoom(ORBITAL_LOOKUP_MAX_ZOOM);
  if (sheet.isOpen && samePoint(point, at)) {
    if (moved) drawTarget(targetFor(at, null));
    sheet.setPlaceName(name);
    // The same point reopened as the located position drops a pending read; reopened as a picked point it reads.
    if (pointIsLocated !== located) {
      pointIsLocated = located;
      loadWatchedSite(at);
    } else if (siteFailed && !located) {
      loadWatchedSite(at);
    }
    if (recentre) focusMap();
    // A second link to the open point selects its pass now if the archives have answered, else when they do.
    if (evidenceReady && lookup) applyLinkedPass(lookup);
    return;
  }
  clearTrack();
  evidenceReady = false;
  point = at;
  drawTarget(targetFor(at, null));
  selectedPass = null;
  lookup = null;
  evidence = null;
  claimMapUrlCentre();
  sheet.open(at, returnFocus);
  sheet.setPlaceName(name);
  pointIsLocated = located;
  loadWatchedSite(at);
  focusMap();
  void start();
}

/** Opens the satellite pass lookup for a point. The point stays in the browser; `located` marks the user's own position. */
export function openOrbitalWatch(at: GeoPoint, returnFocusTo: HTMLElement | null, map?: OrbitalTrackSurface | null, { located = false }: { located?: boolean } = {}): void {
  returnFocus = returnFocusTo;
  linkedPass = null;
  lookAt(at, null, { recentre: false, map, located });
}

/** Opens the lookup with no place yet, focused on its search field. */
export function openOrbitalWatchSearch(returnFocusTo: HTMLElement | null, map?: OrbitalTrackSurface | null): void {
  const sheet = ensurePage();
  if (useSurface(map) && point) drawTarget(targetFor(point, null));
  if (!sheet.isOpen) {
    returnFocus = returnFocusTo;
    setOrbitalLookupOpen(true);
    sheet.open(null, returnFocus);
  }
  showSearchRow(true);
  tools!.focusSearch();
}

/** Opens a shared place, and its pass when that pass is still in the lookup window. */
export function openOrbitalShareLink(link: OrbitalShareLink, returnFocusTo: HTMLElement | null, map?: OrbitalTrackSurface | null): void {
  returnFocus = returnFocusTo;
  linkedPass = link.pass;
  lookAt(link.point, null, { recentre: true, map });
}
