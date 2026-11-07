import {
  escapeHtml,
  formatStaticDate,
  formatStaticDateTime,
  metric,
  renderLiveSection,
  requireFreshTimestamp,
  UnpublishableReading,
} from './common.mjs';

// The seed reads both registers hourly and its key expires after 3 h
// (scripts/seed-security-advisories.mjs), so a reading past this age is not
// the current advice.
const MAX_AGE_MS = 4 * 3_600_000;
// Each register lists ~200 destinations. Below this one of them was not read
// in full, and its column would show missing advice as "no advice".
export const MIN_REGISTER_COUNTRIES = 100;
// "Recently updated" is a fortnight of the registers' own dates.
const RECENT_WINDOW_MS = 14 * 86_400_000;
const RECENT_LISTED = 25;

const LEVELS = ['normal', 'caution', 'reconsider', 'do-not-travel'];
const RANK = { normal: 1, caution: 2, reconsider: 3, 'do-not-travel': 4 };

// Each government's own wording for its four levels.
export const REGISTERS = Object.freeze({
  US: Object.freeze({
    name: 'US State Department',
    short: 'US',
    labels: {
      normal: 'Level 1: Exercise Normal Precautions',
      caution: 'Level 2: Exercise Increased Caution',
      reconsider: 'Level 3: Reconsider Travel',
      'do-not-travel': 'Level 4: Do Not Travel',
    },
  }),
  AU: Object.freeze({
    name: 'Australia’s Smartraveller',
    short: 'Australia',
    labels: {
      normal: 'Exercise normal safety precautions',
      caution: 'Exercise a high degree of caution',
      reconsider: 'Reconsider your need to travel',
      'do-not-travel': 'Do not travel',
    },
  }),
});
const SOURCE_IDS = Object.keys(REGISTERS);

// Intl's English region names, with the few that read oddly in a list.
const NAME_OVERRIDES = { MM: 'Myanmar', CD: 'Democratic Republic of the Congo', CG: 'Republic of the Congo', PS: 'Palestinian Territories' };
let regionNames = null;
function countryName(code) {
  if (NAME_OVERRIDES[code]) return NAME_OVERRIDES[code];
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function validRow(row) {
  return row && typeof row === 'object'
    && typeof row.country === 'string' && /^[A-Z]{2}$/.test(row.country)
    && SOURCE_IDS.includes(row.sourceCountry)
    && RANK[row.level] !== undefined
    && typeof row.link === 'string' && /^https:\/\//.test(row.link);
}

function datedOrEmpty(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : '';
}

/**
 * One row per destination with each government's level side by side.
 * `fetchedAt` is when the seed last read the registers. Register rows use the
 * advisory item shape, where `pubDate` is the feed's date or '' when undated.
 */
export function travelAdvisoriesRecord(payload, now = Date.now()) {
  if (!Array.isArray(payload?.registerLevels)) throw new UnpublishableReading('travel advisories: no register levels');
  const asOf = requireFreshTimestamp(payload.fetchedAt, { now, maxAgeMs: MAX_AGE_MS, label: 'travel advisories' });
  const byCode = new Map();
  for (const row of payload.registerLevels) {
    if (!validRow(row)) continue;
    const entry = byCode.get(row.country) ?? { code: row.country, name: countryName(row.country), US: null, AU: null };
    entry[row.sourceCountry] = { level: row.level, updatedAt: datedOrEmpty(row.pubDate), link: row.link };
    byCode.set(row.country, entry);
  }
  const countries = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const counts = {};
  for (const source of SOURCE_IDS) {
    counts[source] = Object.fromEntries(LEVELS.map((level) => [level, 0]));
    for (const country of countries) if (country[source]) counts[source][country[source].level] += 1;
    const listed = LEVELS.reduce((sum, level) => sum + counts[source][level], 0);
    if (listed < MIN_REGISTER_COUNTRIES) {
      throw new UnpublishableReading(`travel advisories: the ${source} register lists ${listed} countries`);
    }
  }
  const asOfMs = Date.parse(asOf);
  const recent = [];
  for (const country of countries) {
    for (const source of SOURCE_IDS) {
      const advice = country[source];
      if (!advice?.updatedAt) continue;
      const age = asOfMs - Date.parse(advice.updatedAt);
      if (age >= 0 && age <= RECENT_WINDOW_MS) recent.push({ code: country.code, name: country.name, source, level: advice.level, updatedAt: advice.updatedAt });
    }
  }
  recent.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name, 'en'));
  const disagree = countries
    .filter((country) => country.US && country.AU && country.US.level !== country.AU.level)
    .map((country) => ({ code: country.code, name: country.name, US: country.US.level, AU: country.AU.level }))
    .sort((a, b) => Math.abs(RANK[b.US] - RANK[b.AU]) - Math.abs(RANK[a.US] - RANK[a.AU]) || a.name.localeCompare(b.name, 'en'));
  return { asOf, countries, counts, recentCount: recent.length, recent: recent.slice(0, RECENT_LISTED), disagree };
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function travelAdvisoriesAnswer(record) {
  if (!record) return 'World Monitor has no current reading of the US and Australian travel advisory registers.';
  const usTop = record.counts.US['do-not-travel'];
  const auTop = record.counts.AU['do-not-travel'];
  return `As of ${formatStaticDateTime(record.asOf)}, the US State Department rates ${countPhrase(usTop, 'country', 'countries')} Level 4: Do Not Travel, and Australia’s Smartraveller tells travellers not to go to ${countPhrase(auTop, 'country', 'countries')}. The two governments give different advice for ${countPhrase(record.disagree.length, 'country', 'countries')}.`;
}

function levelCell(advice, source) {
  if (!advice) return '<td class="lvl lvl-none">No advisory listed</td>';
  const label = REGISTERS[source].labels[advice.level];
  const updated = advice.updatedAt ? ` <small>${escapeHtml(formatStaticDate(advice.updatedAt))}</small>` : '';
  return `<td class="lvl lvl-${RANK[advice.level]}"><a href="${escapeHtml(advice.link)}" rel="nofollow">${escapeHtml(label)}</a>${updated}</td>`;
}

/**
 * Map colours for the figure the page builds around its world map (outside
 * this section): one rule per country, so the middleware's swap recolours the
 * map together with the table. The map shows the US levels.
 *
 * The built figure draws outlines only. "No US advisory" is a claim, so the
 * base fill for unlisted countries comes from here and only with a reading;
 * it follows the figure's own style in the document and wins by source order.
 */
function mapStyle(record) {
  const rules = record.countries
    .filter((country) => country.US)
    .map((country) => `.advisory-map [data-iso2="${country.code}"]{fill:var(--lvl-${RANK[country.US.level]})}`)
    .join('');
  return `        <style>.advisory-map path{fill:var(--lvl-none);stroke:#050807}${rules}</style>`;
}

export function travelAdvisoriesBody(record) {
  if (!record) return '        <p class="tool-note">Open the Security Advisories panel on the live dashboard for the current advice.</p>';
  const recentRows = record.recent
    .map((entry) => `            <tr><td>${escapeHtml(formatStaticDate(entry.updatedAt))}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(REGISTERS[entry.source].short)}</td><td class="lvl lvl-${RANK[entry.level]}">${escapeHtml(REGISTERS[entry.source].labels[entry.level])}</td></tr>`)
    .join('\n');
  const disagreeRows = record.disagree
    .map((entry) => `            <tr><td>${escapeHtml(entry.name)}</td><td class="lvl lvl-${RANK[entry.US]}">${escapeHtml(REGISTERS.US.labels[entry.US])}</td><td class="lvl lvl-${RANK[entry.AU]}">${escapeHtml(REGISTERS.AU.labels[entry.AU])}</td></tr>`)
    .join('\n');
  const allRows = record.countries
    .map((country) => `            <tr id="advisory-${country.code.toLowerCase()}"><th scope="row">${escapeHtml(country.name)}</th>${levelCell(country.US, 'US')}${levelCell(country.AU, 'AU')}</tr>`)
    .join('\n');
  return `${mapStyle(record)}
        <div class="grid">
${metric('US Level 4: Do Not Travel', String(record.counts.US['do-not-travel']))}
${metric('US Level 3: Reconsider Travel', String(record.counts.US.reconsider))}
${metric('Australia: Do not travel', String(record.counts.AU['do-not-travel']))}
${metric('US and Australia differ', String(record.disagree.length))}
        </div>
        <h3>Updated in the last 14 days</h3>
${record.recent.length === 0 ? '        <p class="tool-note">Neither register dates an update in the last 14 days.</p>' : `        <div class="table-scroll">
          <table>
            <caption>Advisories with a register date in the last 14 days${record.recentCount > record.recent.length ? `, most recent ${record.recent.length} of ${record.recentCount}` : ''}</caption>
            <thead><tr><th scope="col">Register date</th><th scope="col">Destination</th><th scope="col">Government</th><th scope="col">Current advice</th></tr></thead>
            <tbody>
${recentRows}
            </tbody>
          </table>
        </div>`}
        <h3>Where the US and Australia disagree</h3>
${record.disagree.length === 0 ? '        <p class="tool-note">Both governments give the same level for every destination they both list.</p>' : `        <div class="table-scroll">
          <table>
            <caption>Destinations both governments list at different levels, widest gap first</caption>
            <thead><tr><th scope="col">Destination</th><th scope="col">US State Department</th><th scope="col">Australia’s Smartraveller</th></tr></thead>
            <tbody>
${disagreeRows}
            </tbody>
          </table>
        </div>`}
        <h3>Every destination</h3>
        <div class="table-scroll">
          <table class="advisory-table">
            <caption>Current advice by destination, with each register’s date; each level links to the government’s advisory page</caption>
            <thead><tr><th scope="col">Destination</th><th scope="col">US State Department</th><th scope="col">Australia’s Smartraveller</th></tr></thead>
            <tbody>
${allRows}
            </tbody>
          </table>
        </div>`;
}

// Static styles for the map figure and the level cells. The per-country fills
// live in the live section (mapStyle) so they change with the reading.
const FIGURE_STYLE = `      <style>
        .advisory-figure { --lvl-1: #3f9d63; --lvl-2: #d4b13f; --lvl-3: #e07b32; --lvl-4: #e5484d; --lvl-none: #24342b; --issuer: #6b7f74; margin: 24px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
        .advisory-map { display: block; width: 100%; height: auto; }
        .advisory-map path { fill: transparent; stroke: var(--lvl-none); stroke-width: 0.6; }
        .advisory-map [data-iso2="US"] { fill: var(--issuer); }
        .advisory-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted); }
        .advisory-legend li { display: inline-flex; align-items: center; gap: 6px; }
        .advisory-legend i { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
        .advisory-figure figcaption { margin-top: 8px; color: var(--muted); font-size: 13px; }
        .live-tool { --lvl-1: #3f9d63; --lvl-2: #d4b13f; --lvl-3: #e07b32; --lvl-4: #e5484d; }
        .live-tool h3 { margin: 28px 0 8px; }
        .live-tool[data-live-topic="travel-advisory-map"] .grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .live-tool td.lvl { border-left: 4px solid var(--line); }
        .live-tool td.lvl-1 { border-left-color: var(--lvl-1); }
        .live-tool td.lvl-2 { border-left-color: var(--lvl-2); }
        .live-tool td.lvl-3 { border-left-color: var(--lvl-3); }
        .live-tool td.lvl-4 { border-left-color: var(--lvl-4); }
        .live-tool td.lvl-none { color: var(--muted); }
        .live-tool td.lvl small { display: block; color: var(--muted); font-size: 12px; }
        .advisory-table th[scope="row"] { text-align: left; font-weight: 600; }
      </style>`;

export const travelAdvisoriesPage = Object.freeze({
  slug: 'travel-advisory-map',
  path: '/tools/travel-advisory-map/',
  statusPath: '/api/intelligence/v1/list-security-advisories?public=1',
  title: 'Travel Advisory Map: US and Australia | World Monitor',
  h1: 'Travel advisory map',
  question: 'Which countries do the US and Australia warn against travelling to?',
  description: 'US State Department and Australian Smartraveller travel advisories on one world map: every country’s levels side by side and where the two disagree.',
  dashboardPanel: 'Security Advisories panel',
  record: travelAdvisoriesRecord,
  /** The map, built once; `worldMapSvg` is the page builder's Node-only renderer. */
  renderFigure({ worldMapSvg }) {
    const legend = LEVELS.map((level) => `<li><i style="background:var(--lvl-${RANK[level]})"></i>${escapeHtml(REGISTERS.US.labels[level])}</li>`).join('');
    return `${FIGURE_STYLE}
      <figure class="advisory-figure">
        ${worldMapSvg({ label: 'World map coloured by the US State Department travel advisory level for each country', className: 'advisory-map' })}
        <ul class="advisory-legend">${legend}<li><i style="background:var(--issuer)"></i>United States (issues the advice)</li><li><i style="background:var(--lvl-none)"></i>No US advisory listed</li></ul>
        <figcaption>Colours show the US State Department level. The table below gives both governments’ advice for every destination, including small countries the map cannot draw.</figcaption>
      </figure>`;
  },
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: travelAdvisoriesAnswer(record),
      bodyHtml: travelAdvisoriesBody(record),
      asOf: record?.asOf,
      sourceHtml: 'Sources: US Department of State travel advisories (<a href="https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html" rel="nofollow">travel.state.gov</a>) and the Australian Government’s Smartraveller (<a href="https://www.smartraveller.gov.au/destinations" rel="nofollow">smartraveller.gov.au</a>, CC BY 4.0). Dates are the ones each register’s feed gives.',
    });
  },
  explainer: `      <h2>What the levels mean</h2>
      <p>Both governments use four steps. The US State Department's are Level 1, exercise normal precautions; Level 2, exercise increased caution; Level 3, reconsider travel; and Level 4, do not travel. Australia's Smartraveller uses the same four steps in its own words: exercise normal safety precautions, exercise a high degree of caution, reconsider your need to travel, and do not travel. A country's overall level can hide stricter advice for some regions, so read the government's page, linked from each level, before you go.</p>
      <h2>Why the two governments disagree</h2>
      <p>Each government writes advice for its own citizens, weighing its consular reach, diplomatic ties and the risks its travellers face. A difference is not an error in either register. Where they differ by two or more levels, both pages are worth reading in full.</p>
      <h2>How current this is</h2>
      <p>World Monitor reads both registers every hour. The date beside each level is the date the government's feed gives for that advisory, which is usually when it was last reissued. This page restates official advice and is not travel advice of its own.</p>`,
});
