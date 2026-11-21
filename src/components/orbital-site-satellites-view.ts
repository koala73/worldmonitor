import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import { COVERAGE_WINDOW_HOURS, type CoverageSite, type SiteSatellite } from '@/services/orbital/satellite-site-coverage';
import { untilLabel, utcTime } from './orbital-satellite-sites-view';

const KEY = 'orbitalWatch.siteSatellites';
/** Rows shown before the list folds, so a busy site does not push the rest of the sheet away. */
export const SITE_SATELLITE_ROWS = 6;

export type SiteSatellitesState =
  | { kind: 'projecting' }
  | { kind: 'not-loaded' }
  | { kind: 'failed' }
  | { kind: 'ok'; satellites: SiteSatellite[] };

export interface SiteSatellitesOptions {
  nowMs: number;
  /** The sheet's key for this satellite's pass, or null when the lookup does not list it. */
  passKey: (noradId: string, timeMs: number) => string | null;
  selectedKey: string | null;
  /** Whether the list shows every satellite rather than the first SITE_SATELLITE_ROWS. */
  expanded?: boolean;
}

function cell(label: string, value: string, className = ''): HTMLElement {
  return h('span', { className: `ies-cell ${className}`.trim(), dataset: { label } }, value);
}

function satelliteRow(satellite: SiteSatellite, { nowMs, passKey, selectedKey }: SiteSatellitesOptions): HTMLElement {
  const first = satellite.passes[0]!;
  const key = passKey(satellite.noradId, first.timeMs);
  const detail = [t('orbitalWatch.satelliteSites.offTrack', { km: Math.round(first.groundDistanceKm) })];
  if (first.edgeOfSwath) detail.push(t('orbitalWatch.satelliteSites.swathEdge'));
  if (satellite.passes.length > 1) detail.push(t('orbitalWatch.satelliteSites.passes', { count: satellite.passes.length }));
  // A row the lookup also lists selects that pass, which draws its track over the site; any other row only reads.
  return h('li', {
    className: key ? 'ies-row' : 'ies-static-row',
    tabindex: key ? '0' : null,
    'aria-current': key && key === selectedKey ? 'true' : null,
    dataset: { key: key ? `pass:${key}` : `satellite:${satellite.noradId}`, noradId: satellite.noradId },
  },
  cell(t('orbitalWatch.row.time'), utcTime(first.timeMs)),
  cell(t('orbitalWatch.row.in'), untilLabel(first.timeMs, nowMs)),
  cell(t('orbitalWatch.row.satellite'), satellite.name, 'ies-grow ies-name'),
  cell(t('orbitalWatch.row.sensor'), satellite.sensor.family),
  cell('', detail.join(' · ')));
}

/** The tracked satellites over a watched site in the next 24 h: the site's link back to the satellite cards that list it. */
export function siteSatellitesSection(site: CoverageSite, state: SiteSatellitesState, options: SiteSatellitesOptions): HTMLElement {
  const hours = COVERAGE_WINDOW_HOURS;
  const note = (text: string) => h('p', { className: 'ies-note' }, text);
  let content: Node[];
  if (state.kind === 'projecting') content = [note(t('orbitalWatch.satelliteSites.projecting'))];
  else if (state.kind === 'not-loaded') content = [note(t(`${KEY}.notLoaded`))];
  else if (state.kind === 'failed') content = [note(t(`${KEY}.failed`))];
  else if (state.satellites.length === 0) content = [note(t(`${KEY}.none`, { hours }))];
  else {
    const rows = state.satellites.map((satellite) => satelliteRow(satellite, options));
    content = [h('ul', { className: 'ies-table' }, ...rows)];
    if (rows.length > SITE_SATELLITE_ROWS) {
      const more = h('button', { type: 'button', className: 'ies-more' });
      const fold = (expanded: boolean) => {
        rows.forEach((row, i) => { row.hidden = !expanded && i >= SITE_SATELLITE_ROWS; });
        more.textContent = expanded ? t('orbitalWatch.capability.showFewer') : t('orbitalWatch.capability.showAll', { count: rows.length });
        more.setAttribute('aria-expanded', String(expanded));
      };
      more.addEventListener('click', () => fold(more.getAttribute('aria-expanded') !== 'true'));
      fold(options.expanded === true);
      content.push(more);
    }
  }
  return h('section', { className: 'ies-section', dataset: { section: 'site-satellites', state: state.kind, siteId: site.id } },
    h('h3', { className: 'ies-section-title' }, t(`${KEY}.heading`, { hours })),
    ...content);
}

/** Marks the selected pass's row without rebuilding the list, so a focused row keeps focus. */
export function markSiteSatelliteSelected(host: HTMLElement, selectedKey: string | null): void {
  for (const row of host.querySelectorAll<HTMLElement>('[data-section="site-satellites"] .ies-row[data-key^="pass:"]')) {
    if (selectedKey && row.dataset.key === `pass:${selectedKey}`) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}
