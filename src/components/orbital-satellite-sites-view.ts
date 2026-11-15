import '../styles/orbital-satellite-sites.css';
import { t } from '@/services/i18n';
import { getTrackedSatelliteTle } from '@/services/satellites';
import {
  COVERAGE_WINDOW_HOURS,
  loadWatchedSites,
  sitesCoveredBySatellite,
  type SatelliteCoverage,
  type SiteCoverage,
  type TrackedSatelliteTle,
} from '@/services/orbital/satellite-site-coverage';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** An open card scans again once its 24-hour window has slid this far. */
const WINDOW_RENEW_MS = HOUR_MS;
const KEY = 'orbitalWatch.satelliteSites';

function utcTime(ms: number): string {
  const d = new Date(ms);
  return t(`${KEY}.utc`, { time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` });
}

function untilLabel(ms: number, nowMs: number): string {
  const delta = Math.max(0, ms - nowMs);
  if (delta < HOUR_MS) return t(`${KEY}.inMinutes`, { minutes: Math.max(1, Math.round(delta / MINUTE_MS)) });
  return t(`${KEY}.inHours`, {
    hours: Math.floor(delta / HOUR_MS),
    minutes: String(Math.floor((delta % HOUR_MS) / MINUTE_MS)).padStart(2, '0'),
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(text: string, tone?: 'stale'): HTMLElement {
  const node = el('div', 'osat-sites-note', text);
  if (tone) node.dataset.tone = tone;
  return node;
}

function siteRow(entry: SiteCoverage, nowMs: number): HTMLElement {
  const first = entry.passes[0]!;
  const row = el('li', 'osat-site');
  row.dataset.siteId = entry.site.id;
  row.append(
    el('span', 'osat-site-name', entry.site.name),
    el('span', 'osat-site-time', utcTime(first.timeMs)),
  );
  const parts = [entry.site.countryCode, untilLabel(first.timeMs, nowMs), t(`${KEY}.offTrack`, { km: Math.round(first.groundDistanceKm) })];
  if (first.edgeOfSwath) parts.push(t(`${KEY}.swathEdge`));
  if (entry.passes.length > 1) parts.push(t(`${KEY}.passes`, { count: entry.passes.length }));
  row.append(el('span', 'osat-site-detail', parts.join(' · ')));
  return row;
}

/** The body of the section for one coverage answer. Exported for tests. */
export function coverageNodes(coverage: SatelliteCoverage, nowMs: number): HTMLElement[] {
  switch (coverage.status) {
    case 'signals':
      return [note(t(`${KEY}.signals`))];
    case 'excluded':
    case 'no-profile':
      return [note(t(`${KEY}.noProfile`))];
    case 'geostationary':
      return [note(t(`${KEY}.geostationary`))];
    case 'bad-elements':
      return [note(t(`${KEY}.badElements`))];
    case 'unavailable':
      return [note(t(`${KEY}.unavailable`))];
    case 'too-old':
      return [note(t(`${KEY}.tooOld`, { count: Math.floor(coverage.orbitAgeDays) }), 'stale')];
    case 'ok': {
      if (!coverage.sites.length) return [note(t(`${KEY}.none`, { hours: COVERAGE_WINDOW_HOURS }))];
      const list = el('ul', 'osat-sites-list');
      for (const entry of coverage.sites) list.append(siteRow(entry, nowMs));
      return [note(t(`${KEY}.count`, { count: coverage.sites.length, family: coverage.sensor.family })), list];
    }
  }
}

/** What a section host shows, so it can be drawn again in the current language. */
type SectionState = { kind: 'note'; key: string } | { kind: 'coverage'; coverage: SatelliteCoverage };
const sections = new WeakMap<HTMLElement, SectionState>();
/** The element set (both TLE lines) a section's scan ran on; null when none was loaded. */
const scannedFrom = new WeakMap<HTMLElement, string | null>();
/** The list's last scroll offset per section, kept across note states so a redrawn list returns to it. */
const listScroll = new WeakMap<HTMLElement, number>();

function elementSetKey(noradId: string): string | null {
  const tle = getTrackedSatelliteTle(noradId);
  return tle ? `${tle.line1}\n${tle.line2}` : null;
}

function draw(host: HTMLElement, state: SectionState, nowMs: number): void {
  sections.set(host, state);
  const shown = host.querySelector('.osat-sites-list');
  if (shown) listScroll.set(host, shown.scrollTop);
  const heading = el('span', 'osat-sites-label', t(`${KEY}.heading`, { hours: COVERAGE_WINDOW_HOURS }));
  const body = state.kind === 'note' ? [note(t(state.key))] : coverageNodes(state.coverage, nowMs);
  host.replaceChildren(heading, ...body);
  const list = host.querySelector('.osat-sites-list');
  const scroll = listScroll.get(host) ?? 0;
  if (list && scroll) list.scrollTop = scroll;
  if (state.kind === 'coverage') host.dataset.coverage = state.coverage.status;
  else delete host.dataset.coverage;
}

/** Shows a one-line note under the section heading; `key` is under orbitalWatch.satelliteSites. */
export function showSatelliteSitesNote(host: HTMLElement, key: string): void {
  host.classList.add('osat-sites');
  draw(host, { kind: 'note', key: `${KEY}.${key}` }, Date.now());
}

/** Draws a section again from what it last showed, in the current language and against the current time. */
export function relabelSatelliteSites(host: HTMLElement): void {
  const state = sections.get(host);
  if (state) draw(host, state, Date.now());
}

/** True when the layer now draws a different element set than the one the section was scanned from. */
export function satelliteSitesOutdated(host: HTMLElement, noradId: string): boolean {
  return scannedFrom.has(host) && scannedFrom.get(host) !== elementSetKey(noradId);
}

/**
 * Moves a listed section to `nowMs`: passes already behind are dropped and the
 * countdowns redrawn. Returns 'rescan' once the window has slid far enough that the
 * section should be computed again.
 */
export function advanceSatelliteSites(host: HTMLElement, nowMs: number): 'current' | 'rescan' {
  const state = sections.get(host);
  if (state?.kind !== 'coverage' || state.coverage.status !== 'ok') return 'current';
  const coverage = state.coverage;
  if (nowMs - coverage.windowStartMs >= WINDOW_RENEW_MS) return 'rescan';
  const sites = coverage.sites
    .map((entry) => ({ site: entry.site, passes: entry.passes.filter((p) => p.timeMs > nowMs) }))
    .filter((entry) => entry.passes.length > 0)
    .sort((a, b) => a.passes[0]!.timeMs - b.passes[0]!.timeMs || a.site.name.localeCompare(b.site.name));
  draw(host, { kind: 'coverage', coverage: { ...coverage, sites } }, nowMs);
  return 'current';
}

/**
 * Fills `host` with the watched sites the tracked satellite covers in the next 24 hours.
 * Everything is computed in the browser from the layer's element set and the public
 * site registry.
 */
export async function renderSatelliteSites(host: HTMLElement, noradId: string, name: string, signal?: AbortSignal): Promise<SatelliteCoverage | null> {
  const loaded = getTrackedSatelliteTle(noradId);
  const key = loaded ? `${loaded.line1}\n${loaded.line2}` : null;
  // A rescan of the same element set (the window renewing) keeps the current list until
  // the new one is ready; a first scan or a new element set shows the projecting note.
  const shown = sections.get(host);
  const renewing = shown?.kind === 'coverage' && shown.coverage.status === 'ok' && scannedFrom.has(host) && scannedFrom.get(host) === key;
  if (!renewing) showSatelliteSitesNote(host, 'projecting');
  scannedFrom.set(host, key);
  const tle: TrackedSatelliteTle | null = loaded ? { noradId, name: loaded.name || name, line1: loaded.line1, line2: loaded.line2 } : null;
  if (!tle) {
    showSatelliteSitesNote(host, 'notLoaded');
    return null;
  }
  const nowMs = Date.now();
  let coverage: SatelliteCoverage;
  try {
    const sites = await loadWatchedSites();
    coverage = await sitesCoveredBySatellite({ tle, sites, nowMs, signal });
  } catch (err) {
    if (signal?.aborted) return null;
    console.warn('[orbital] satellite site coverage failed', err);
    showSatelliteSitesNote(host, 'failed');
    return null;
  }
  // A scan of an element set the layer has since replaced is never painted; the card rescans.
  if (signal?.aborted || !host.isConnected || elementSetKey(noradId) !== key) return null;
  draw(host, { kind: 'coverage', coverage }, Date.now());
  return coverage;
}
