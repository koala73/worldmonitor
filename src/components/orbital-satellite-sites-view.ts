import '../styles/orbital-tokens.css';
import '../styles/orbital-satellite-sites.css';
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

function utcTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function untilLabel(ms: number, nowMs: number): string {
  const delta = Math.max(0, ms - nowMs);
  if (delta < HOUR_MS) return `in ${Math.max(1, Math.round(delta / MINUTE_MS))} min`;
  return `in ${Math.floor(delta / HOUR_MS)} h ${String(Math.floor((delta % HOUR_MS) / MINUTE_MS)).padStart(2, '0')} min`;
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
  const parts = [entry.site.countryCode, untilLabel(first.timeMs, nowMs), `${Math.round(first.groundDistanceKm)} km off track`];
  if (first.edgeOfSwath) parts.push('at swath edge');
  if (entry.passes.length > 1) parts.push(`${entry.passes.length} passes`);
  row.append(el('span', 'osat-site-detail', parts.join(' \u00B7 ')));
  return row;
}

/** The body of the section for one coverage answer. Exported for tests. */
export function coverageNodes(coverage: SatelliteCoverage, nowMs: number): HTMLElement[] {
  switch (coverage.status) {
    case 'signals':
      return [note('Signals-intelligence satellite. No imager, so no ground coverage is modelled.')];
    case 'excluded':
    case 'no-profile':
      return [note('No sensor profile for this satellite, so its ground coverage is not modelled.')];
    case 'geostationary':
      return [note('Geostationary: fixed above one longitude, so no passes to list.')];
    case 'bad-elements':
      return [note('Orbit elements are unreadable.')];
    case 'too-old':
      return [note(`Orbit elements are ${Math.floor(coverage.orbitAgeDays)} days old, too old to project passes.`, 'stale')];
    case 'ok': {
      if (!coverage.sites.length) return [note(`No watched site inside its footprint within ${COVERAGE_WINDOW_HOURS} h.`)];
      const count = coverage.sites.length;
      const list = el('ul', 'osat-sites-list');
      for (const entry of coverage.sites) list.append(siteRow(entry, nowMs));
      return [note(`${count} ${count === 1 ? 'site' : 'sites'} inside the ${coverage.sensor.family} footprint`), list];
    }
  }
}

/**
 * Fills `host` with the watched sites the tracked satellite covers in the next 24 hours.
 * Everything is computed in the browser from the layer's element set and the public
 * site registry.
 */
export async function renderSatelliteSites(host: HTMLElement, noradId: string, name: string, signal?: AbortSignal): Promise<SatelliteCoverage | null> {
  host.classList.add('osat-sites');
  host.replaceChildren(el('span', 'ow-label', `Watched sites \u00B7 next ${COVERAGE_WINDOW_HOURS} h`), note('Projecting passes\u2026'));
  const loaded = getTrackedSatelliteTle(noradId);
  const tle: TrackedSatelliteTle | null = loaded ? { noradId, name: loaded.name || name, line1: loaded.line1, line2: loaded.line2 } : null;
  if (!tle) {
    host.replaceChildren(host.firstChild!, note('Click the satellite again; its orbit elements are not loaded.'));
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
    host.replaceChildren(host.firstChild!, note('Click the satellite again to retry; the projection failed.'));
    return null;
  }
  if (signal?.aborted || !host.isConnected) return null;
  host.replaceChildren(host.firstChild!, ...coverageNodes(coverage, nowMs));
  host.dataset.coverage = coverage.status;
  return coverage;
}
