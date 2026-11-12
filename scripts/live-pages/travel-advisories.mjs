import {
  escapeHtml,
  formatStaticDate,
  formatStaticDateTime,
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
  // The FCDO's warnings have no levels and are labelled by ukLabel below.
  UK: Object.freeze({ name: 'UK Foreign Office (FCDO)', short: 'UK' }),
});
// The two four-level registers, compared level for level.
const SOURCE_IDS = ['US', 'AU'];
const DAY_MS = 86_400_000;

// Intl's English region names, with the few that read oddly in a list.
const NAME_OVERRIDES = { MM: 'Myanmar', CD: 'Democratic Republic of the Congo', CG: 'Republic of the Congo', PS: 'Palestinian Territories' };
// Names people still search by, matched by the table's search box.
const SEARCH_ALIASES = Object.freeze({ TR: 'Turkey', CI: 'Ivory Coast', CZ: 'Czech Republic', SZ: 'Swaziland', MK: 'Macedonia', TL: 'East Timor', MM: 'Burma', CD: 'DRC Congo-Kinshasa', CG: 'Congo-Brazzaville', VA: 'Holy See' });
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

// Register rows name their register in `source`; each issuer's own code is its sourceCountry.
const REGISTER_BY_SOURCE = Object.freeze({ 'US State Dept': 'US', 'Australia DFAT Smartraveller': 'AU', 'UK FCDO': 'UK' });
const CDC_SOURCE = 'CDC Travel Notices';
const EMBASSY_PREFIX = 'US Embassy ';
// An embassy alert older than this is history, not current context.
const ALERT_WINDOW_MS = 30 * 86_400_000;

// The FCDO has no levels. A destination carries none, one or several of four
// warnings; the strongest one colours the map.
const UK_RANK = Object.freeze({ 'all-whole': 4, 'essential-whole': 3, 'all-parts': 2, 'essential-parts': 1 });
const UK_PHRASE = Object.freeze({
  'all-whole': 'all travel to the whole country',
  'essential-whole': 'all but essential travel to the whole country',
  'all-parts': 'all travel to parts',
  'essential-parts': 'all but essential travel to parts',
});
const UK_RANKS = [4, 3, 2, 1, 0];
const UK_RANK_LABELS = Object.freeze({
  4: 'Against all travel to the whole country',
  3: 'Against all but essential travel to the whole country',
  2: 'Against all travel to parts',
  1: 'Against all but essential travel to parts',
  0: 'No warning against travel',
});

function ukWarnings(level) {
  if (level === 'none') return [];
  const warnings = String(level).split('+');
  return warnings.every((warning) => UK_RANK[warning]) && new Set(warnings).size === warnings.length ? warnings : null;
}

function ukRank(level) {
  const warnings = ukWarnings(level);
  return warnings && (warnings.length ? Math.max(...warnings.map((warning) => UK_RANK[warning])) : 0);
}

function ukLabel(level) {
  const warnings = ukWarnings(level);
  if (!warnings?.length) return UK_RANK_LABELS[0];
  const phrases = warnings.map((warning, i) => (i > 0 && warning === 'essential-parts' ? 'all but essential travel to other parts' : UK_PHRASE[warning]));
  return `Against ${phrases.join(', and ')}`;
}

function levelValid(source, level) {
  return source === 'UK' ? ukWarnings(level) !== null : RANK[level] !== undefined;
}

function validRow(row) {
  return row && typeof row === 'object'
    && typeof row.country === 'string' && /^[A-Z]{2}$/.test(row.country)
    && typeof row.title === 'string'
    && typeof row.link === 'string' && /^https:\/\//.test(row.link);
}

function datedOrEmpty(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : '';
}

/**
 * One row per destination with each government's advice side by side, the
 * CDC's travel health notices for it, and the latest US embassy alert.
 * `fetchedAt` is when the seed last read the registers. Register rows use the
 * advisory item shape, where `pubDate` is the feed's date or '' when undated.
 * The US and Australian registers must both be read in full; the UK's is shown
 * only when it was.
 */
export function travelAdvisoriesRecord(payload, now = Date.now()) {
  if (!Array.isArray(payload?.registerLevels)) throw new UnpublishableReading('travel advisories: no register levels');
  const asOf = requireFreshTimestamp(payload.fetchedAt, { now, maxAgeMs: MAX_AGE_MS, label: 'travel advisories' });
  const asOfMs = Date.parse(asOf);
  const byCode = new Map();
  const entryFor = (code) => {
    if (!byCode.has(code)) byCode.set(code, { code, name: countryName(code), US: null, AU: null, UK: null, health: [], alert: null });
    return byCode.get(code);
  };
  for (const row of payload.registerLevels) {
    if (!validRow(row)) continue;
    if (row.source === CDC_SOURCE) {
      const level = Number(String(row.level).match(/^cdc-([1-4])$/)?.[1]);
      if (level) entryFor(row.country).health.push({ title: row.title, link: row.link, level, updatedAt: datedOrEmpty(row.pubDate) });
      continue;
    }
    const source = REGISTER_BY_SOURCE[row.source];
    if (!source || row.sourceCountry !== source || !levelValid(source, row.level)) continue;
    entryFor(row.country)[source] = { level: row.level, updatedAt: datedOrEmpty(row.pubDate), link: row.link };
  }
  for (const advisory of Array.isArray(payload.advisories) ? payload.advisories : []) {
    if (!validRow(advisory) || typeof advisory.source !== 'string' || !advisory.source.startsWith(EMBASSY_PREFIX)) continue;
    const posted = datedOrEmpty(advisory.pubDate);
    const age = asOfMs - Date.parse(posted);
    if (!posted || !byCode.has(advisory.country) || !(age >= -DAY_MS && age <= ALERT_WINDOW_MS)) continue;
    const entry = byCode.get(advisory.country);
    if (!entry.alert || posted > entry.alert.postedAt) entry.alert = { title: advisory.title, link: advisory.link, postedAt: posted };
  }
  const countries = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const country of countries) country.health.sort((a, b) => b.level - a.level || (b.updatedAt > a.updatedAt) - (b.updatedAt < a.updatedAt));

  const counts = {};
  for (const source of SOURCE_IDS) {
    counts[source] = Object.fromEntries(LEVELS.map((level) => [level, 0]));
    for (const country of countries) if (country[source]) counts[source][country[source].level] += 1;
    const listed = LEVELS.reduce((sum, level) => sum + counts[source][level], 0);
    if (listed < MIN_REGISTER_COUNTRIES) {
      throw new UnpublishableReading(`travel advisories: the ${source} register lists ${listed} countries`);
    }
  }
  const hasUK = countries.filter((country) => country.UK).length >= MIN_REGISTER_COUNTRIES;
  if (hasUK) {
    counts.UK = Object.fromEntries(UK_RANKS.map((rank) => [rank, 0]));
    for (const country of countries) if (country.UK) counts.UK[ukRank(country.UK.level)] += 1;
  } else {
    for (const country of countries) country.UK = null;
  }

  const recent = [];
  for (const country of countries) {
    for (const source of [...SOURCE_IDS, ...(hasUK ? ['UK'] : [])]) {
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
  const ukWhole = countries
    .filter((country) => country.UK && ukRank(country.UK.level) >= 3)
    .sort((a, b) => ukRank(b.UK.level) - ukRank(a.UK.level) || a.name.localeCompare(b.name, 'en'));
  return { asOf, hasUK, countries, counts, recentCount: recent.length, recent: recent.slice(0, RECENT_LISTED), disagree, ukWhole };
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function travelAdvisoriesAnswer(record) {
  if (!record) return 'World Monitor has no current reading of the US, UK and Australian travel advisory registers.';
  const usTop = record.counts.US['do-not-travel'];
  const auTop = record.counts.AU['do-not-travel'];
  const uk = record.hasUK === true ? ` The UK Foreign Office advises against all travel to the whole of ${countPhrase(record.counts.UK[4], 'country', 'countries')}.` : '';
  return `As of ${formatStaticDateTime(record.asOf)}, the US State Department rates ${countPhrase(usTop, 'country', 'countries')} Level 4: Do Not Travel, and Australia’s Smartraveller tells travellers not to go to ${countPhrase(auTop, 'country', 'countries')}. The two governments give different advice for ${countPhrase(record.disagree.length, 'country', 'countries')}.${uk}`;
}

// The map's four views. Each colours a country by one value derived from its
// destination row; the figure's data-view attribute picks the view.
const MAP_VIEWS = Object.freeze({
  US: (country) => country.US && `--lvl-${RANK[country.US.level]}`,
  AU: (country) => country.AU && `--lvl-${RANK[country.AU.level]}`,
  UK: (country) => country.UK?.level && `--uk-${ukRank(country.UK.level)}`,
  gap: (country) => country.US && country.AU && `--gap-${levelGap(country)}`,
});

function levelGap(country) {
  return Math.abs(RANK[country.US.level] - RANK[country.AU.level]);
}

function pill(level) {
  return `<span class="lvl-pill l${RANK[level]}" aria-hidden="true">${RANK[level]}</span>`;
}

function ukPill(level) {
  return `<span class="lvl-pill uk u${ukRank(level)}" aria-hidden="true"></span>`;
}

function adviceLabel(level, source) {
  return source === 'UK' ? ukLabel(level) : REGISTERS[source].labels[level];
}

function adviceClass(level, source) {
  return source === 'UK' ? `uk-${ukRank(level)}` : `lvl-${RANK[level]}`;
}

function advicePill(level, source) {
  return source === 'UK' ? ukPill(level) : pill(level);
}

function levelCell(advice, source) {
  if (!advice) return `<td class="lvl lvl-none">${source === 'UK' ? 'Not listed' : 'No advisory listed'}</td>`;
  const updated = advice.updatedAt ? `<small>${escapeHtml(formatStaticDate(advice.updatedAt))}</small>` : '';
  return `<td class="lvl ${adviceClass(advice.level, source)}">${advicePill(advice.level, source)}<a href="${escapeHtml(advice.link)}" rel="nofollow">${escapeHtml(adviceLabel(advice.level, source))}</a>${updated}</td>`;
}

function labelCell(level, source) {
  return `<td class="lvl ${adviceClass(level, source)}">${advicePill(level, source)}${escapeHtml(adviceLabel(level, source))}</td>`;
}

function gapText(entry) {
  const gap = RANK[entry.US] - RANK[entry.AU];
  const stricter = gap > 0 ? REGISTERS.US.short : REGISTERS.AU.short;
  return `${stricter} stricter by ${countPhrase(Math.abs(gap), 'level')}`;
}

/**
 * Map colours for the figure the page builds around its world map (outside
 * this section), so the middleware's swap recolours the map together with the
 * tables. One rule per view and colour, listing its countries.
 *
 * The built figure draws land without a level. "No advisory listed" is a
 * claim, so that fill comes from here and only with a reading; it repeats the
 * figure's selector and wins by source order.
 */
function mapStyle(record) {
  const groups = new Map();
  for (const country of record.countries) {
    for (const [view, colour] of Object.entries(MAP_VIEWS)) {
      const token = colour(country);
      if (!token) continue;
      const key = `${view}|${token}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`[data-iso2="${country.code}"]`);
    }
  }
  const rules = [...groups]
    .map(([key, selectors]) => {
      const [view, token] = key.split('|');
      return `.advisory-figure[data-view="${view}"] :is(${selectors.join(',')}){fill:var(${token})}`;
    })
    .join('');
  return `        <style>.advisory-map .land{fill:var(--lvl-none)}${rules}</style>`;
}

function summaryCard(name, listed, rows, verb = 'rated') {
  const segments = rows
    .filter((row) => row.count > 0)
    .map((row) => `<span class="${row.className}" style="flex-grow:${row.count}"></span>`)
    .join('');
  const items = rows
    .map((row) => `<li>${row.pill}<span>${escapeHtml(row.label)}</span><strong>${row.count}</strong></li>`)
    .join('');
  const spoken = rows.map((row) => `${row.label}: ${row.count}`).join(', ');
  return `          <div class="register-card">
            <h3>${escapeHtml(name)}</h3>
            <p class="register-total">${countPhrase(listed, 'destination')} ${verb}</p>
            <div class="level-bar" role="img" aria-label="${escapeHtml(spoken)}">${segments}</div>
            <ul class="level-counts">${items}</ul>
          </div>`;
}

function registerCard(record, source) {
  const counts = record.counts[source];
  const listed = LEVELS.reduce((sum, level) => sum + counts[level], 0);
  return summaryCard(REGISTERS[source].name, listed, LEVELS.map((level) => ({
    className: `l${RANK[level]}`, pill: pill(level), label: REGISTERS[source].labels[level], count: counts[level],
  })));
}

function ukCard(record) {
  const counts = record.counts.UK;
  const listed = UK_RANKS.reduce((sum, rank) => sum + counts[rank], 0);
  return summaryCard(REGISTERS.UK.name, listed, UK_RANKS.map((rank) => ({
    className: `u${rank}`, pill: `<span class="lvl-pill uk u${rank}" aria-hidden="true"></span>`, label: UK_RANK_LABELS[rank], count: counts[rank],
  })), 'listed');
}

function differCard(record) {
  const wide = record.disagree.filter((entry) => Math.abs(RANK[entry.US] - RANK[entry.AU]) >= 2).length;
  return `          <div class="register-card differ">
            <h3>Where the US and Australia differ</h3>
            <p class="differ-count"><strong>${record.disagree.length}</strong> ${record.disagree.length === 1 ? 'destination gets' : 'destinations get'} different advice</p>
            <p class="register-total">${countPhrase(wide, 'destination')} two or more levels apart</p>
            <a href="#advisory-disagree">See the list</a>
          </div>`;
}

// What else a destination's row says: the latest US embassy alert and the
// CDC's travel health notices. The hover card reads them from here.
function destinationNotes(country) {
  const notes = [];
  if (country.alert) {
    const posted = formatStaticDate(country.alert.postedAt);
    notes.push(`<small class="dest-note dest-alert" data-date="${escapeHtml(posted)}">US Embassy alert, ${escapeHtml(posted)}: <a href="${escapeHtml(country.alert.link)}" rel="nofollow">${escapeHtml(country.alert.title)}</a></small>`);
  }
  for (const notice of country.health ?? []) {
    const issued = notice.updatedAt ? formatStaticDate(notice.updatedAt) : '';
    notes.push(`<small class="dest-note dest-health"${issued ? ` data-date="${escapeHtml(issued)}"` : ''}>CDC health notice${issued ? `, ${escapeHtml(issued)}` : ''}: <a href="${escapeHtml(notice.link)}" rel="nofollow">${escapeHtml(notice.title)}</a></small>`);
  }
  return notes.join('');
}

export function travelAdvisoriesBody(record) {
  if (!record) return '        <p class="tool-note">Open the Security Advisories panel on the live dashboard for the current advice.</p>';
  // A frozen snapshot's record can predate the UK register and the notices.
  const uk = record.hasUK === true;
  const recentRows = record.recent
    .map((entry) => `            <tr><td>${escapeHtml(formatStaticDate(entry.updatedAt))}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(REGISTERS[entry.source].short)}</td>${labelCell(entry.level, entry.source)}</tr>`)
    .join('\n');
  const disagreeRows = record.disagree
    .map((entry) => `            <tr><td>${escapeHtml(entry.name)}</td>${labelCell(entry.US, 'US')}${labelCell(entry.AU, 'AU')}<td class="gap">${escapeHtml(gapText(entry))}</td></tr>`)
    .join('\n');
  const wholeRows = (record.ukWhole ?? [])
    .map((country) => `            <tr><td>${escapeHtml(country.name)}</td>${labelCell(country.UK.level, 'UK')}${country.US ? labelCell(country.US.level, 'US') : '<td class="lvl lvl-none">No advisory listed</td>'}${country.AU ? labelCell(country.AU.level, 'AU') : '<td class="lvl lvl-none">No advisory listed</td>'}</tr>`)
    .join('\n');
  const allRows = record.countries
    .map((country) => `            <tr id="advisory-${country.code.toLowerCase()}"${SEARCH_ALIASES[country.code] ? ` data-aka="${escapeHtml(SEARCH_ALIASES[country.code])}"` : ''}${country.US ? ` data-us="${RANK[country.US.level]}"` : ''}${country.AU ? ` data-au="${RANK[country.AU.level]}"` : ''}><th scope="row"><span class="dest-name">${escapeHtml(country.name)}</span>${destinationNotes(country)}</th>${levelCell(country.US, 'US')}${levelCell(country.AU, 'AU')}${uk ? levelCell(country.UK, 'UK') : ''}</tr>`)
    .join('\n');
  return `${mapStyle(record)}
        <div class="advisory-summary">
${registerCard(record, 'US')}
${registerCard(record, 'AU')}
${uk ? `${ukCard(record)}\n` : ''}${differCard(record)}
        </div>
        <h3 id="advisory-disagree">Where the US and Australia disagree</h3>
${record.disagree.length === 0 ? '        <p class="tool-note">Both governments give the same level for every destination they both list.</p>' : `        <div class="table-scroll">
          <table>
            <caption>Destinations both governments list at different levels, widest gap first</caption>
            <thead><tr><th scope="col">Destination</th><th scope="col">US State Department</th><th scope="col">Australia’s Smartraveller</th><th scope="col">Gap</th></tr></thead>
            <tbody>
${disagreeRows}
            </tbody>
          </table>
        </div>`}
${uk ? `        <h3 id="advisory-uk-whole">Where the UK warns against the whole country</h3>
        <p class="tool-note">The UK uses no levels, so it has no gap to measure. These are the destinations where its warning covers the whole country, beside the US and Australian levels.</p>
${wholeRows === '' ? '        <p class="tool-note">The UK warns against no whole country.</p>' : `        <div class="table-scroll">
          <table>
            <caption>Destinations the UK Foreign Office advises against travelling to as a whole, strongest warning first</caption>
            <thead><tr><th scope="col">Destination</th><th scope="col">UK Foreign Office</th><th scope="col">US State Department</th><th scope="col">Australia’s Smartraveller</th></tr></thead>
            <tbody>
${wholeRows}
            </tbody>
          </table>
        </div>`}
` : ''}        <h3>Updated in the last 14 days</h3>
${record.recent.length === 0 ? `        <p class="tool-note">No register dates an update in the last 14 days.</p>` : `        <div class="table-scroll">
          <table>
            <caption>Advisories with a register date in the last 14 days${record.recentCount > record.recent.length ? `, most recent ${record.recent.length} of ${record.recentCount}` : ''}</caption>
            <thead><tr><th scope="col">Register date</th><th scope="col">Destination</th><th scope="col">Government</th><th scope="col">Current advice</th></tr></thead>
            <tbody>
${recentRows}
            </tbody>
          </table>
        </div>`}
        <h3>Every destination</h3>
        <div class="advisory-filter" hidden>
          <label for="advisory-search">Find a destination</label>
          <input id="advisory-search" type="search" placeholder="Country name" autocomplete="off">
          <span id="advisory-search-count" aria-live="polite"></span>
        </div>
        <div class="table-scroll">
          <table class="advisory-table"${uk ? ' data-uk-register' : ''}>
            <caption>Current advice by destination, with each register’s date, the latest US embassy alert and any CDC travel health notice; each level links to the government’s advisory page</caption>
            <thead><tr><th scope="col">Destination</th><th scope="col">US State Department</th><th scope="col">Australia’s Smartraveller</th>${uk ? '<th scope="col">UK Foreign Office</th>' : ''}</tr></thead>
            <tbody>
${allRows}
            </tbody>
          </table>
        </div>`;
}

/**
 * The page's one script, inlined as source. It reads everything from the
 * destination table when the page loads, so it works the same on the built
 * page and after the middleware swaps the live section in on the server. Without it the map keeps
 * its native titles and the US view, and the search box stays hidden.
 */
function advisoryPageScript() {
  const figure = document.querySelector('.advisory-figure');
  const map = figure && figure.querySelector('.advisory-map');
  const tip = figure && figure.querySelector('.advisory-tip');
  if (!map || !tip) return;
  const rowFor = (code) => document.getElementById('advisory-' + code.toLowerCase());
  const titles = { US: 'US State Department levels', AU: 'Australia’s Smartraveller levels', UK: 'UK Foreign Office warnings', gap: 'Where the US and Australia differ' };
  const nameOf = (row) => (row.querySelector('.dest-name') || row.querySelector('th')).textContent;

  for (const land of map.querySelectorAll('.land')) {
    const title = land.querySelector('title');
    if (title) {
      land.dataset.name = title.textContent;
      title.remove();
    }
  }

  const table = document.querySelector('.advisory-table');
  const hasReading = !!table;
  const hasUK = !!table && table.hasAttribute('data-uk-register');
  const toggle = figure.querySelector('.view-toggle');
  if (toggle && hasReading) {
    toggle.hidden = false;
    const ukButton = toggle.querySelector('[data-view-btn="UK"]');
    if (ukButton) ukButton.hidden = !hasUK;
    toggle.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view-btn]');
      if (!button) return;
      figure.dataset.view = button.dataset.viewBtn;
      for (const other of toggle.querySelectorAll('[data-view-btn]')) other.setAttribute('aria-pressed', String(other === button));
      const heading = figure.querySelector('.advisory-figure-title');
      if (heading) heading.textContent = titles[button.dataset.viewBtn];
    });
  }

  const line = (label, cell, dated, verb) => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const who = document.createElement('span');
    who.className = 'tip-who';
    who.textContent = label;
    row.append(who);
    const pill = cell && cell.querySelector('.lvl-pill');
    const advice = document.createElement('span');
    advice.className = 'tip-advice';
    if (pill) advice.append(pill.cloneNode(true));
    const link = cell && cell.querySelector('a');
    advice.append(link ? link.textContent : cell ? cell.textContent : 'No advisory listed');
    const date = dated || (cell && cell.querySelector('small') && cell.querySelector('small').textContent);
    if (date) {
      const when = document.createElement('small');
      when.textContent = (verb || 'Issued') + ' ' + date;
      advice.append(when);
    }
    row.append(advice);
    return row;
  };
  const ISSUERS = { US: 'Issues the US State Department advisories.', AU: 'Issues Australia’s Smartraveller advisories.', GB: 'Issues the UK Foreign Office travel advice.' };

  let current = null;
  const fill = (land, pointerType) => {
    const code = land.dataset.iso2 || '';
    const row = code ? rowFor(code) : null;
    tip.replaceChildren();
    const name = document.createElement('strong');
    name.className = 'tip-name';
    name.textContent = row ? nameOf(row) : land.dataset.name || '';
    tip.append(name);
    if (!hasReading) {
      tip.append(Object.assign(document.createElement('p'), { textContent: 'No current reading of the registers.' }));
      return;
    }
    if (ISSUERS[code] && (code !== 'GB' || hasUK)) {
      tip.append(Object.assign(document.createElement('p'), { className: 'tip-note', textContent: ISSUERS[code] }));
    }
    if (!row) {
      if (!ISSUERS[code]) tip.append(Object.assign(document.createElement('p'), { className: 'tip-note', textContent: hasUK ? 'None of the three governments lists it separately.' : 'Neither government lists it separately.' }));
      return;
    }
    const cells = row.querySelectorAll('td');
    if (code !== 'US') tip.append(line('US', cells[0]));
    if (code !== 'AU') tip.append(line('Australia', cells[1]));
    if (hasUK && code !== 'GB') tip.append(line('UK', cells[2]));
    const us = Number(row.dataset.us);
    const au = Number(row.dataset.au);
    if (us && au) {
      tip.append(Object.assign(document.createElement('p'), {
        className: 'tip-note',
        textContent: us === au ? 'The US and Australia give the same level.' : (us > au ? 'The US' : 'Australia') + ' is stricter than ' + (us > au ? 'Australia' : 'the US') + ' by ' + Math.abs(us - au) + (Math.abs(us - au) === 1 ? ' level.' : ' levels.'),
      }));
    }
    const alert = row.querySelector('.dest-alert');
    if (alert) tip.append(line('Embassy', alert, alert.dataset.date, 'Posted'));
    const notices = [...row.querySelectorAll('.dest-health')];
    notices.slice(0, 2).forEach((notice) => tip.append(line('CDC', notice, notice.dataset.date)));
    if (notices.length > 2) tip.append(Object.assign(document.createElement('p'), { className: 'tip-note', textContent: (notices.length - 2) + ' more CDC health ' + (notices.length === 3 ? 'notice' : 'notices') + ' in the row.' }));
    tip.append(Object.assign(document.createElement('p'), { className: 'tip-hint', textContent: { touch: 'Tap again for the full row and links', keyboard: 'Press Enter for the full row and links' }[pointerType] || 'Click for the full row and links' }));
  };

  const place = (event) => {
    if (getComputedStyle(tip).position === 'static') return;
    const box = figure.querySelector('.advisory-map-wrap').getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const flipX = x + tip.offsetWidth + 18 > box.width;
    const flipY = y + tip.offsetHeight + 18 > box.height;
    tip.style.left = Math.max(0, flipX ? x - tip.offsetWidth - 14 : x + 14) + 'px';
    tip.style.top = Math.max(0, flipY ? y - tip.offsetHeight - 14 : y + 14) + 'px';
  };

  // Raising the shape draws its outline above its neighbours; a focused shape
  // stays put, since moving it in the DOM would drop its focus.
  const show = (land, event) => {
    if (current !== land) {
      if (current) current.classList.remove('is-hover');
      current = land;
      land.classList.add('is-hover');
      if (document.activeElement !== land) land.parentNode.append(land);
      fill(land, event.pointerType);
      tip.hidden = false;
    }
    place(event);
  };

  const hide = () => {
    if (current) current.classList.remove('is-hover');
    current = null;
    tip.hidden = true;
  };

  // Touch opens the card from the click below, so a finger that drifts
  // before the tap cannot make that tap jump straight to the row.
  map.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const land = event.target.closest('.land');
    if (land) show(land, event);
    else hide();
  });
  map.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hide();
  });
  const jumpTo = (land) => {
    const row = land.dataset.iso2 ? rowFor(land.dataset.iso2) : null;
    if (!row) return;
    hide();
    if (row.hidden) clearSearch();
    if (location.hash === '#' + row.id) row.scrollIntoView({ block: 'center' });
    else location.hash = row.id;
  };

  // Safari before 18.2 and Firefox before 129 fire click as a MouseEvent with
  // no pointerType, so the tap's type comes from its pointerdown.
  // A press also focuses the country before its click (on touch, after
  // pointerup). That focus is the pointer's, so it opens no card: only
  // keyboard focus does. The click ends the press. A press released off
  // the map gets no click, so any release starts a fallback timer, and a key
  // press ends it at once, since keyboard focus always follows one.
  let lastPointer = '';
  let pressing = false;
  let pressTimer = 0;
  const release = () => {
    pressing = false;
    clearTimeout(pressTimer);
  };
  map.addEventListener('pointerdown', (event) => {
    lastPointer = event.pointerType;
    pressing = true;
    clearTimeout(pressTimer);
  });
  document.addEventListener('pointerup', () => {
    if (pressing) pressTimer = setTimeout(release, 1000);
  });
  document.addEventListener('keydown', release, true);
  map.addEventListener('pointercancel', release);
  map.addEventListener('click', (event) => {
    release();
    const land = event.target.closest('.land');
    if (!land) return;
    const pointerType = event.pointerType || lastPointer;
    if (pointerType === 'touch' && current !== land) {
      show(land, { clientX: event.clientX, clientY: event.clientY, pointerType });
      return;
    }
    jumpTo(land);
  });

  // One tab stop for the whole map; arrow keys move through the countries
  // alphabetically, and Enter or Space opens the country's row.
  const labelFor = (land) => {
    const row = land.dataset.iso2 ? rowFor(land.dataset.iso2) : null;
    return row ? nameOf(row) : land.dataset.name || '';
  };
  const seen = new Set();
  const keyOrder = [...map.querySelectorAll('.land[data-iso2]')]
    .filter((land) => !seen.has(land.dataset.iso2) && seen.add(land.dataset.iso2))
    .sort((a, b) => labelFor(a).localeCompare(labelFor(b), 'en'));
  tip.id = 'advisory-tip';
  map.setAttribute('role', 'group');
  // Chrome makes the <svg> itself a tab stop, a dead stop before the countries.
  map.setAttribute('tabindex', '-1');
  keyOrder.forEach((land, i) => {
    land.setAttribute('tabindex', i === 0 ? '0' : '-1');
    land.setAttribute('role', 'button');
    land.setAttribute('aria-label', labelFor(land));
    land.setAttribute('aria-describedby', tip.id);
  });
  const focusLand = (land) => {
    for (const other of keyOrder) other.setAttribute('tabindex', other === land ? '0' : '-1');
    land.focus();
  };
  map.addEventListener('focusin', (event) => {
    const land = event.target.closest('.land');
    if (!land || pressing) return;
    const box = land.getBoundingClientRect();
    show(land, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, pointerType: 'keyboard' });
  });
  map.addEventListener('focusout', (event) => {
    if (!map.contains(event.relatedTarget)) hide();
  });
  map.addEventListener('keydown', (event) => {
    const land = event.target.closest('.land');
    const at = keyOrder.indexOf(land);
    if (at === -1) return;
    const last = keyOrder.length - 1;
    const next = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowDown: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      ArrowUp: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      jumpTo(land);
    } else if (next !== undefined) {
      event.preventDefault();
      focusLand(keyOrder[next]);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!map.contains(event.target)) hide();
  });

  // Lower case without accents, so "turkey" finds Türkiye and "cote" Côte d’Ivoire.
  const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[\u2018\u2019`\u00b4]/g, "'").toLowerCase();
  const search = document.getElementById('advisory-search');
  const rows = [...document.querySelectorAll('.advisory-table tbody tr')];
  function clearSearch() {
    if (!search) return;
    search.value = '';
    search.dispatchEvent(new Event('input'));
  }
  if (search && rows.length) {
    search.closest('.advisory-filter').hidden = false;
    const count = document.getElementById('advisory-search-count');
    const names = rows.map((row) => fold(nameOf(row) + ' ' + (row.dataset.aka || '')));
    search.addEventListener('input', () => {
      const query = fold(search.value.trim());
      let shown = 0;
      rows.forEach((row, i) => {
        row.hidden = !!query && !names[i].includes(query);
        if (!row.hidden) shown += 1;
      });
      count.textContent = query ? shown + (shown === 1 ? ' destination' : ' destinations') : '';
    });
  }
}

// Static styles for the figure and the section. The per-country fills live in
// the live section (mapStyle) so they change with the reading.
const FIGURE_STYLE = `      <style>
        .advisory-figure, .live-tool[data-live-topic="travel-advisory-map"] { --lvl-1: #3fae74; --lvl-2: #e3c04f; --lvl-3: #f08c3a; --lvl-4: #ea4f55; --lvl-none: #3b4842; --gap-0: #26332d; --gap-1: #6c5fc7; --gap-2: #9b7ff0; --gap-3: #d9b8ff; --uk-0: #3fae74; --uk-1: #e3c04f; --uk-2: #f08c3a; --uk-3: #ea4f55; --uk-4: #b8336a; --issuer: #8fa6c9; --land: #16211c; --ocean: #08100c; }
        .advisory-figure { position: relative; margin: 24px 0 0; padding: 18px 18px 14px; border: 1px solid var(--line); border-radius: 14px; background: radial-gradient(120% 90% at 50% 0%, #0f1a15 0%, var(--panel) 70%); }
        .advisory-figure-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-bottom: 10px; }
        .advisory-figure-title { margin: 0; font-weight: 600; font-size: 15px; letter-spacing: .01em; }
        .view-toggle { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
        .view-toggle[hidden] { display: none; }
        .view-toggle button { appearance: none; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; padding: 6px 14px; min-height: 32px; border-radius: 999px; cursor: pointer; }
        .view-toggle button:hover { color: var(--text); }
        .view-toggle button[aria-pressed="true"] { background: #1c2a23; color: var(--text); box-shadow: inset 0 0 0 1px #2c4136; }
        .view-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .advisory-map-wrap { position: relative; padding: 6px 0; border-radius: 10px; background: var(--ocean); box-shadow: inset 0 0 0 1px #15241c; }
        .advisory-map { display: block; width: 100%; height: auto; touch-action: manipulation; }
        .advisory-map .graticule { fill: none; stroke: #13211a; stroke-width: .5; }
        .advisory-map .land { fill: var(--land); stroke: #050807; stroke-width: .5; stroke-linejoin: round; pointer-events: visibleFill; transition: fill .2s ease, opacity .15s ease; }
        .advisory-figure[data-view="US"] .advisory-map [data-iso2="US"], .advisory-figure[data-view="AU"] .advisory-map [data-iso2="AU"], .advisory-figure[data-view="UK"] .advisory-map [data-iso2="GB"] { fill: var(--issuer); }
        .advisory-map .land:focus { outline: none; }
        .advisory-map .land:focus-visible { stroke: var(--accent); stroke-width: 1.6; }
        .advisory-map .land.is-hover { stroke: #f4fbf6; stroke-width: 1.3; filter: brightness(1.15); }
        .advisory-map:hover .land:not(.is-hover) { opacity: .82; }
        .advisory-tip { position: absolute; z-index: 2; width: max-content; max-width: min(300px, 80%); padding: 12px 14px; border: 1px solid #2b3f35; border-radius: 10px; background: rgba(9, 15, 12, .96); box-shadow: 0 12px 32px rgba(0, 0, 0, .45); pointer-events: none; font-size: 13px; line-height: 1.4; }
        .advisory-tip[hidden] { display: none; }
        .advisory-tip .tip-name { display: block; font-size: 15px; margin-bottom: 8px; }
        .advisory-tip .tip-row { display: grid; grid-template-columns: 84px 1fr; gap: 8px; margin: 6px 0; }
        .advisory-tip .tip-who { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; padding-top: 2px; }
        .advisory-tip .tip-advice small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
        .advisory-tip p { margin: 8px 0 0; color: var(--muted); }
        .advisory-tip .tip-hint { font-size: 12px; color: #6f8478; }
        .advisory-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 12px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted); }
        .advisory-legend li { display: inline-flex; align-items: center; gap: 7px; }
        .advisory-legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
        .advisory-figure .legend-gap, .advisory-figure .legend-uk, .advisory-figure[data-view="gap"] .legend-levels, .advisory-figure[data-view="UK"] .legend-levels { display: none; }
        .advisory-figure[data-view="gap"] .legend-gap, .advisory-figure[data-view="UK"] .legend-uk { display: flex; }
        .view-toggle button[hidden] { display: none; }
        .advisory-figure figcaption { margin-top: 10px; color: var(--muted); font-size: 13px; }
        .lvl-pill { display: inline-grid; place-items: center; width: 20px; height: 20px; margin-right: 8px; border-radius: 6px; font-size: 12px; font-weight: 700; color: #07100b; vertical-align: -4px; flex: none; }
        .lvl-pill.l1 { background: var(--lvl-1); } .lvl-pill.l2 { background: var(--lvl-2); } .lvl-pill.l3 { background: var(--lvl-3); } .lvl-pill.l4 { background: var(--lvl-4); color: #fff; }
        .lvl-pill.uk { width: 12px; height: 12px; border-radius: 50%; margin: 0 10px 0 4px; vertical-align: -1px; }
        .lvl-pill.u0, .level-bar span.u0 { background: var(--uk-0); } .lvl-pill.u1, .level-bar span.u1 { background: var(--uk-1); } .lvl-pill.u2, .level-bar span.u2 { background: var(--uk-2); } .lvl-pill.u3, .level-bar span.u3 { background: var(--uk-3); } .lvl-pill.u4, .level-bar span.u4 { background: var(--uk-4); }
        .live-tool[data-live-topic="travel-advisory-map"] h3 { margin: 30px 0 8px; }
        .advisory-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 18px; }
        .register-card { padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
        .live-tool .register-card h3 { margin: 0; font-size: 15px; }
        .register-total { margin: 4px 0 12px; color: var(--muted); font-size: 13px; }
        .level-bar { display: flex; gap: 2px; height: 10px; border-radius: 999px; overflow: hidden; background: var(--line); }
        .level-bar span.l1 { background: var(--lvl-1); } .level-bar span.l2 { background: var(--lvl-2); } .level-bar span.l3 { background: var(--lvl-3); } .level-bar span.l4 { background: var(--lvl-4); }
        .level-counts { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
        .level-counts li { display: flex; align-items: center; color: var(--muted); }
        .level-counts li .lvl-pill { width: 18px; height: 18px; font-size: 11px; vertical-align: 0; }
        .level-counts li .lvl-pill.uk { width: 12px; height: 12px; margin: 0 11px 0 3px; }
        .level-counts li span:not(.lvl-pill) { padding-right: 10px; }
        .level-counts li strong { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; }
        .register-card.differ { display: flex; flex-direction: column; background: linear-gradient(160deg, #18142b 0%, var(--panel) 65%); border-color: #2c2650; }
        .differ-count { margin: 10px 0 0; color: var(--muted); }
        .differ-count strong { display: block; font-size: 40px; line-height: 1.05; color: var(--text); font-variant-numeric: tabular-nums; }
        .register-card.differ a { margin-top: auto; font-size: 14px; }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl { min-width: 170px; }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl a { display: inline; }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl a, .live-tool[data-live-topic="travel-advisory-map"] td.lvl { color: var(--text); }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl-none { color: var(--muted); }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl small { display: block; margin: 2px 0 0 28px; color: var(--muted); font-size: 12px; }
        .live-tool[data-live-topic="travel-advisory-map"] td.gap { color: var(--muted); white-space: nowrap; }
        .advisory-table th[scope="row"] { text-align: left; font-weight: 600; color: var(--text); background: transparent; min-width: 200px; }
        .advisory-table .dest-note { display: block; max-width: 340px; margin-top: 4px; color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.35; }
        .advisory-table .dest-note a { color: var(--muted); }
        .live-tool[data-live-topic="travel-advisory-map"] td.uk-0 small, .live-tool[data-live-topic="travel-advisory-map"] td[class*=" uk-"] small { margin-left: 26px; }
        .advisory-table tbody tr:hover { background: #0f1814; }
        .advisory-table tr:target { background: #14261d; box-shadow: inset 3px 0 0 var(--accent); }
        .advisory-table tr { scroll-margin-top: 80px; }
        .advisory-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 8px 0 0; }
        .advisory-filter[hidden] { display: none; }
        .advisory-filter label { color: var(--muted); font-size: 13px; }
        .advisory-filter input { flex: 1 1 220px; max-width: 320px; min-height: 40px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
        .advisory-filter input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
        #advisory-search-count { color: var(--muted); font-size: 13px; }
        @media (max-width: 640px) { .view-toggle button { padding: 6px 10px; white-space: nowrap; } .advisory-tip { position: static; width: auto; max-width: none; margin-top: 10px; box-shadow: none; } .advisory-tip .tip-row { grid-template-columns: 1fr; gap: 2px; } }
        @media (prefers-reduced-motion: reduce) { .advisory-map .land { transition: none; } }
      </style>`;

const GENERIC_LEVELS = { normal: 'Normal precautions', caution: 'Increased caution', reconsider: 'Reconsider travel', 'do-not-travel': 'Do not travel' };

export const travelAdvisoriesPage = Object.freeze({
  slug: 'travel-advisory-map',
  path: '/tools/travel-advisory-map/',
  statusPath: '/api/intelligence/v1/list-security-advisories?public=1',
  title: 'Travel Advisory Map: US, UK and Australia | World Monitor',
  h1: 'Travel advisory map',
  question: 'Which countries do the US, UK and Australia warn against travelling to?',
  description: 'US State Department, UK Foreign Office and Australian Smartraveller travel advice on one world map, with US embassy alerts and CDC health notices.',
  dashboardPanel: 'Security Advisories panel',
  record: travelAdvisoriesRecord,
  /** The map, built once; `worldMapSvg` is the page builder's Node-only renderer. */
  renderFigure({ worldMapSvg }) {
    const levels = LEVELS.map((level) => `<li><i style="background:var(--lvl-${RANK[level]})"></i>${RANK[level]} · ${escapeHtml(GENERIC_LEVELS[level])}</li>`).join('');
    const ukWarnings = UK_RANKS.map((rank) => `<li><i style="background:var(--uk-${rank})"></i>${escapeHtml(UK_RANK_LABELS[rank])}</li>`).join('');
    const gaps = [0, 1, 2, 3].map((gap) => `<li><i style="background:var(--gap-${gap})"></i>${gap === 0 ? 'Same level' : `${gap} ${gap === 1 ? 'level' : 'levels'} apart`}</li>`).join('');
    return `${FIGURE_STYLE}
      <figure class="advisory-figure" data-view="US">
        <div class="advisory-figure-head">
          <p class="advisory-figure-title">US State Department levels</p>
          <div class="view-toggle" role="group" aria-label="Whose advice the map shows" hidden><button type="button" data-view-btn="US" aria-pressed="true">US</button><button type="button" data-view-btn="AU" aria-pressed="false">Australia</button><button type="button" data-view-btn="UK" aria-pressed="false">UK</button><button type="button" data-view-btn="gap" aria-pressed="false">Where they differ</button></div>
        </div>
        <div class="advisory-map-wrap">
          ${worldMapSvg({ label: 'World map coloured by each country’s travel advisory level', className: 'advisory-map' })}
          <div class="advisory-tip" role="tooltip" hidden></div>
        </div>
        <ul class="advisory-legend legend-levels">${levels}<li><i style="background:var(--issuer)"></i>Issuing government</li><li><i style="background:var(--lvl-none)"></i>No advisory listed</li></ul>
        <ul class="advisory-legend legend-uk">${ukWarnings}<li><i style="background:var(--issuer)"></i>Issuing government</li><li><i style="background:var(--lvl-none)"></i>Not listed by the UK</li></ul>
        <ul class="advisory-legend legend-gap">${gaps}<li><i style="background:var(--lvl-none)"></i>Not listed by both</li></ul>
        <figcaption>Hover or tap a country for each government’s advice, any recent US embassy alert and CDC health notice, and click it to jump to its row. The UK colours show its strongest warning; “parts” means some regions only. The table below covers every destination, including small countries the map cannot draw.</figcaption>
      </figure>`;
  },
  /** Inline script for the page: map hover card, view toggle and table search. */
  script: `(${advisoryPageScript.toString()})();`,
  renderSection(record, { live }) {
    return renderLiveSection({
      slug: this.slug,
      question: this.question,
      record,
      live,
      answer: travelAdvisoriesAnswer(record),
      bodyHtml: travelAdvisoriesBody(record),
      asOf: record?.asOf,
      sourceHtml: 'Sources: US Department of State travel advisories (<a href="https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html" rel="nofollow">travel.state.gov</a>), US embassy alerts and CDC travel health notices (<a href="https://wwwnc.cdc.gov/travel/notices" rel="nofollow">wwwnc.cdc.gov</a>); the Australian Government’s Smartraveller (<a href="https://www.smartraveller.gov.au/destinations" rel="nofollow">smartraveller.gov.au</a>, CC BY 4.0); and the UK Foreign, Commonwealth &amp; Development Office (<a href="https://www.gov.uk/foreign-travel-advice" rel="nofollow">gov.uk/foreign-travel-advice</a>). Contains public sector information licensed under the <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" rel="nofollow">Open Government Licence v3.0</a>. Dates are the ones each register gives.',
    });
  },
  explainer: `      <h2>What the levels mean</h2>
      <p>Both governments use four steps. The US State Department's are Level 1, exercise normal precautions; Level 2, exercise increased caution; Level 3, reconsider travel; and Level 4, do not travel. Australia's Smartraveller uses the same four steps in its own words: exercise normal safety precautions, exercise a high degree of caution, reconsider your need to travel, and do not travel. A country's overall level can hide stricter advice for some regions, so read the government's page, linked from each level, before you go.</p>
      <h2>How the UK's advice works</h2>
      <p>The UK Foreign, Commonwealth &amp; Development Office does not use levels. For most destinations it gives no warning against travel. Otherwise it advises against all travel, or against all but essential travel, either to the whole country or to parts of it, and a country can carry both kinds of warning for different regions. The map colours each country by its strongest UK warning, so a country with a warning for one region shows that warning across the whole shape. Because the scales differ, the page does not score the UK against the US or Australia; it lists the destinations where the UK warns against the whole country beside the other two governments' levels.</p>
      <h2>Embassy alerts and health notices</h2>
      <p>A US embassy alert covers a specific event, such as a demonstration or a security incident, and the page shows the latest one posted in the last 30 days for the countries whose embassy publishes a feed World Monitor reads. A CDC travel health notice covers an outbreak or health risk, on its own four levels, and some apply to only part of a country. Neither changes a country's travel advisory level.</p>
      <h2>Why the governments disagree</h2>
      <p>Each government writes advice for its own citizens, weighing its consular reach, diplomatic ties and the risks its travellers face. A difference is not an error in any register. Where the US and Australia differ by two or more levels, both pages are worth reading in full.</p>
      <h2>How current this is</h2>
      <p>World Monitor reads every register every hour. The date beside each level is the date the government's feed gives for that advisory, which is usually when it was last reissued. This page restates official advice and is not travel advice of its own.</p>`,
});
