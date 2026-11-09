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
});
const SOURCE_IDS = Object.keys(REGISTERS);

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

// The map's three views. Each colours a country by one value derived from its
// destination row; the figure's data-view attribute picks the view.
const MAP_VIEWS = Object.freeze({
  US: (country) => country.US && `--lvl-${RANK[country.US.level]}`,
  AU: (country) => country.AU && `--lvl-${RANK[country.AU.level]}`,
  gap: (country) => country.US && country.AU && `--gap-${levelGap(country)}`,
});

function levelGap(country) {
  return Math.abs(RANK[country.US.level] - RANK[country.AU.level]);
}

function pill(level) {
  return `<span class="lvl-pill l${RANK[level]}" aria-hidden="true">${RANK[level]}</span>`;
}

function levelCell(advice, source) {
  if (!advice) return '<td class="lvl lvl-none">No advisory listed</td>';
  const label = REGISTERS[source].labels[advice.level];
  const updated = advice.updatedAt ? `<small>${escapeHtml(formatStaticDate(advice.updatedAt))}</small>` : '';
  return `<td class="lvl lvl-${RANK[advice.level]}">${pill(advice.level)}<a href="${escapeHtml(advice.link)}" rel="nofollow">${escapeHtml(label)}</a>${updated}</td>`;
}

function labelCell(level, source) {
  return `<td class="lvl lvl-${RANK[level]}">${pill(level)}${escapeHtml(REGISTERS[source].labels[level])}</td>`;
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

function registerCard(record, source) {
  const counts = record.counts[source];
  const listed = LEVELS.reduce((sum, level) => sum + counts[level], 0);
  const segments = LEVELS
    .filter((level) => counts[level] > 0)
    .map((level) => `<span class="l${RANK[level]}" style="flex-grow:${counts[level]}"></span>`)
    .join('');
  const rows = LEVELS
    .map((level) => `<li>${pill(level)}<span>${escapeHtml(REGISTERS[source].labels[level])}</span><strong>${counts[level]}</strong></li>`)
    .join('');
  const spoken = LEVELS.map((level) => `${REGISTERS[source].labels[level]}: ${counts[level]}`).join(', ');
  return `          <div class="register-card">
            <h3>${escapeHtml(REGISTERS[source].name)}</h3>
            <p class="register-total">${countPhrase(listed, 'destination')} rated</p>
            <div class="level-bar" role="img" aria-label="${escapeHtml(spoken)}">${segments}</div>
            <ul class="level-counts">${rows}</ul>
          </div>`;
}

function differCard(record) {
  const wide = record.disagree.filter((entry) => Math.abs(RANK[entry.US] - RANK[entry.AU]) >= 2).length;
  return `          <div class="register-card differ">
            <h3>Where they differ</h3>
            <p class="differ-count"><strong>${record.disagree.length}</strong> ${record.disagree.length === 1 ? 'destination gets' : 'destinations get'} different advice</p>
            <p class="register-total">${countPhrase(wide, 'destination')} two or more levels apart</p>
            <a href="#advisory-disagree">See the list</a>
          </div>`;
}

export function travelAdvisoriesBody(record) {
  if (!record) return '        <p class="tool-note">Open the Security Advisories panel on the live dashboard for the current advice.</p>';
  const recentRows = record.recent
    .map((entry) => `            <tr><td>${escapeHtml(formatStaticDate(entry.updatedAt))}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(REGISTERS[entry.source].short)}</td>${labelCell(entry.level, entry.source)}</tr>`)
    .join('\n');
  const disagreeRows = record.disagree
    .map((entry) => `            <tr><td>${escapeHtml(entry.name)}</td>${labelCell(entry.US, 'US')}${labelCell(entry.AU, 'AU')}<td class="gap">${escapeHtml(gapText(entry))}</td></tr>`)
    .join('\n');
  const allRows = record.countries
    .map((country) => `            <tr id="advisory-${country.code.toLowerCase()}"${SEARCH_ALIASES[country.code] ? ` data-aka="${escapeHtml(SEARCH_ALIASES[country.code])}"` : ''}${country.US ? ` data-us="${RANK[country.US.level]}"` : ''}${country.AU ? ` data-au="${RANK[country.AU.level]}"` : ''}><th scope="row">${escapeHtml(country.name)}</th>${levelCell(country.US, 'US')}${levelCell(country.AU, 'AU')}</tr>`)
    .join('\n');
  return `${mapStyle(record)}
        <div class="advisory-summary">
${registerCard(record, 'US')}
${registerCard(record, 'AU')}
${differCard(record)}
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
        <h3>Every destination</h3>
        <div class="advisory-filter" hidden>
          <label for="advisory-search">Find a destination</label>
          <input id="advisory-search" type="search" placeholder="Country name" autocomplete="off">
          <span id="advisory-search-count" aria-live="polite"></span>
        </div>
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
  const titles = { US: 'US State Department levels', AU: 'Australia’s Smartraveller levels', gap: 'Where the two governments differ' };

  for (const land of map.querySelectorAll('.land')) {
    const title = land.querySelector('title');
    if (title) {
      land.dataset.name = title.textContent;
      title.remove();
    }
  }

  const hasReading = !!document.querySelector('.advisory-table');
  const toggle = figure.querySelector('.view-toggle');
  if (toggle && hasReading) {
    toggle.hidden = false;
    toggle.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view-btn]');
      if (!button) return;
      figure.dataset.view = button.dataset.viewBtn;
      for (const other of toggle.querySelectorAll('[data-view-btn]')) other.setAttribute('aria-pressed', String(other === button));
      const heading = figure.querySelector('.advisory-figure-title');
      if (heading) heading.textContent = titles[button.dataset.viewBtn];
    });
  }

  const line = (label, cell) => {
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
    advice.append((link ? link.textContent : 'No advisory listed'));
    const date = cell && cell.querySelector('small');
    if (date) {
      const when = document.createElement('small');
      when.textContent = 'Issued ' + date.textContent;
      advice.append(when);
    }
    row.append(advice);
    return row;
  };

  let current = null;
  const fill = (land, pointerType) => {
    const code = land.dataset.iso2 || '';
    const row = code ? rowFor(code) : null;
    tip.replaceChildren();
    const name = document.createElement('strong');
    name.className = 'tip-name';
    name.textContent = row ? row.querySelector('th').textContent : land.dataset.name || '';
    tip.append(name);
    if (!hasReading) {
      tip.append(Object.assign(document.createElement('p'), { textContent: 'No current reading of the registers.' }));
      return;
    }
    if (code === 'US' || code === 'AU') {
      tip.append(Object.assign(document.createElement('p'), { className: 'tip-note', textContent: code === 'US' ? 'Issues the US State Department advisories.' : 'Issues Australia’s Smartraveller advisories.' }));
    }
    if (!row) {
      if (code !== 'US' && code !== 'AU') tip.append(Object.assign(document.createElement('p'), { className: 'tip-note', textContent: 'Neither government lists it separately.' }));
      return;
    }
    const cells = row.querySelectorAll('td');
    if (code !== 'US') tip.append(line('US', cells[0]));
    if (code !== 'AU') tip.append(line('Australia', cells[1]));
    const us = Number(row.dataset.us);
    const au = Number(row.dataset.au);
    if (us && au) {
      tip.append(Object.assign(document.createElement('p'), {
        className: 'tip-note',
        textContent: us === au ? 'Both governments give the same level.' : (us > au ? 'US' : 'Australia') + ' is stricter by ' + Math.abs(us - au) + (Math.abs(us - au) === 1 ? ' level.' : ' levels.'),
      }));
    }
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
      if (event.pointerType !== 'keyboard') land.parentNode.append(land);
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
  let lastPointer = '';
  map.addEventListener('pointerdown', (event) => {
    lastPointer = event.pointerType;
  });
  map.addEventListener('click', (event) => {
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
    return row ? row.querySelector('th').textContent : land.dataset.name || '';
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
    if (!land) return;
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
    const names = rows.map((row) => fold(row.querySelector('th').textContent + ' ' + (row.dataset.aka || '')));
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
        .advisory-figure, .live-tool[data-live-topic="travel-advisory-map"] { --lvl-1: #3fae74; --lvl-2: #e3c04f; --lvl-3: #f08c3a; --lvl-4: #ea4f55; --lvl-none: #3b4842; --gap-0: #26332d; --gap-1: #6c5fc7; --gap-2: #9b7ff0; --gap-3: #d9b8ff; --issuer: #8fa6c9; --land: #16211c; --ocean: #08100c; }
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
        .advisory-figure[data-view="US"] .advisory-map [data-iso2="US"], .advisory-figure[data-view="AU"] .advisory-map [data-iso2="AU"] { fill: var(--issuer); }
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
        .advisory-figure .legend-gap, .advisory-figure[data-view="gap"] .legend-levels { display: none; }
        .advisory-figure[data-view="gap"] .legend-gap { display: flex; }
        .advisory-figure figcaption { margin-top: 10px; color: var(--muted); font-size: 13px; }
        .lvl-pill { display: inline-grid; place-items: center; width: 20px; height: 20px; margin-right: 8px; border-radius: 6px; font-size: 12px; font-weight: 700; color: #07100b; vertical-align: -4px; flex: none; }
        .lvl-pill.l1 { background: var(--lvl-1); } .lvl-pill.l2 { background: var(--lvl-2); } .lvl-pill.l3 { background: var(--lvl-3); } .lvl-pill.l4 { background: var(--lvl-4); color: #fff; }
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
        .level-counts li strong { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; }
        .register-card.differ { display: flex; flex-direction: column; background: linear-gradient(160deg, #18142b 0%, var(--panel) 65%); border-color: #2c2650; }
        .differ-count { margin: 10px 0 0; color: var(--muted); }
        .differ-count strong { display: block; font-size: 40px; line-height: 1.05; color: var(--text); font-variant-numeric: tabular-nums; }
        .register-card.differ a { margin-top: auto; font-size: 14px; }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl { white-space: nowrap; }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl a, .live-tool[data-live-topic="travel-advisory-map"] td.lvl { color: var(--text); }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl-none { color: var(--muted); }
        .live-tool[data-live-topic="travel-advisory-map"] td.lvl small { display: block; margin: 2px 0 0 28px; color: var(--muted); font-size: 12px; }
        .live-tool[data-live-topic="travel-advisory-map"] td.gap { color: var(--muted); white-space: nowrap; }
        .advisory-table th[scope="row"] { text-align: left; font-weight: 600; color: var(--text); background: transparent; }
        .advisory-table tbody tr:hover { background: #0f1814; }
        .advisory-table tr:target { background: #14261d; box-shadow: inset 3px 0 0 var(--accent); }
        .advisory-table tr { scroll-margin-top: 80px; }
        .advisory-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 8px 0 0; }
        .advisory-filter[hidden] { display: none; }
        .advisory-filter label { color: var(--muted); font-size: 13px; }
        .advisory-filter input { flex: 1 1 220px; max-width: 320px; min-height: 40px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
        .advisory-filter input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
        #advisory-search-count { color: var(--muted); font-size: 13px; }
        @media (max-width: 640px) { .advisory-tip { position: static; width: auto; max-width: none; margin-top: 10px; box-shadow: none; } .advisory-tip .tip-row { grid-template-columns: 1fr; gap: 2px; } }
        @media (prefers-reduced-motion: reduce) { .advisory-map .land { transition: none; } }
      </style>`;

const GENERIC_LEVELS = { normal: 'Normal precautions', caution: 'Increased caution', reconsider: 'Reconsider travel', 'do-not-travel': 'Do not travel' };

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
    const levels = LEVELS.map((level) => `<li><i style="background:var(--lvl-${RANK[level]})"></i>${RANK[level]} · ${escapeHtml(GENERIC_LEVELS[level])}</li>`).join('');
    const gaps = [0, 1, 2, 3].map((gap) => `<li><i style="background:var(--gap-${gap})"></i>${gap === 0 ? 'Same level' : `${gap} ${gap === 1 ? 'level' : 'levels'} apart`}</li>`).join('');
    return `${FIGURE_STYLE}
      <figure class="advisory-figure" data-view="US">
        <div class="advisory-figure-head">
          <p class="advisory-figure-title">US State Department levels</p>
          <div class="view-toggle" role="group" aria-label="Whose advice the map shows" hidden><button type="button" data-view-btn="US" aria-pressed="true">US</button><button type="button" data-view-btn="AU" aria-pressed="false">Australia</button><button type="button" data-view-btn="gap" aria-pressed="false">Where they differ</button></div>
        </div>
        <div class="advisory-map-wrap">
          ${worldMapSvg({ label: 'World map coloured by each country’s travel advisory level', className: 'advisory-map' })}
          <div class="advisory-tip" role="tooltip" hidden></div>
        </div>
        <ul class="advisory-legend legend-levels">${levels}<li><i style="background:var(--issuer)"></i>Issuing government</li><li><i style="background:var(--lvl-none)"></i>No advisory listed</li></ul>
        <ul class="advisory-legend legend-gap">${gaps}<li><i style="background:var(--lvl-none)"></i>Not listed by both</li></ul>
        <figcaption>Hover or tap a country for both governments’ advice, and click it to jump to its row. The table below covers every destination, including small countries the map cannot draw.</figcaption>
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
