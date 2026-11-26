/**
 * The travel advisory map's page script: the hover card reads each country's
 * advice from the destination table, the view toggle switches the map, and the
 * search box narrows the table.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { liveTopicPageForPath, liveTopicReading } from '../../scripts/live-pages/index.mjs';

// The real renderer reads its topology from disk, which happy-dom's URL global
// prevents; this map keeps its markup contract (.land, data-iso2, <title>).
const MAP_NAMES: Record<string, string> = { AU: 'Australia', CN: 'China', FR: 'France', GB: 'United Kingdom', RU: 'Russia', VE: 'Venezuela' };
const stubMap = ({ className }: { label: string; className?: string }) =>
  `<svg class="${className}">${Object.entries(MAP_NAMES).map(([code, name]) => `<path class="land" data-iso2="${code}" d="M0 0h1v1z"><title>${name}</title></path>`).join('')}</svg>`;
import unToIso2 from '../../shared/un-to-iso2.json';

const travelAdvisoriesPage = liveTopicPageForPath('/tools/travel-advisory-map/')!;
const NOW = Date.parse('2026-11-07T10:00:00Z');
const LEVELS = ['normal', 'caution', 'reconsider', 'do-not-travel'];
// Real ISO codes, so the page's Intl names are real names; China stays unlisted.
const CODES = [...new Set(Object.values(unToIso2 as Record<string, string>))]
  .filter((code) => /^[A-Z]{2}$/.test(code) && code !== 'CN' && code !== 'US')
  .sort();

function register(source: 'US' | 'AU', levelFor: (code: string, i: number) => string) {
  return CODES
    .map((code, i) => ({
      title: `${code} advisory`,
      link: `https://${source === 'US' ? 'travel.state.gov' : 'www.smartraveller.gov.au'}/${code.toLowerCase()}`,
      pubDate: '2026-11-01T00:00:00Z',
      source: source === 'US' ? 'US State Dept' : 'Australia DFAT Smartraveller',
      sourceCountry: source,
      level: levelFor(code, i),
      country: code,
    }));
}

// The UK FCDO register: no warning except Venezuela (parts) and Russia (whole country).
const ukRegister = () => CODES.filter((code) => code !== 'GB').map((code) => ({
  title: code,
  link: `https://www.gov.uk/foreign-travel-advice/${code.toLowerCase()}`,
  pubDate: '2026-10-27T16:06:13Z',
  source: 'UK FCDO',
  sourceCountry: 'UK',
  level: code === 'VE' ? 'all-parts+essential-parts' : code === 'RU' ? 'all-whole' : 'none',
  country: code,
}));
const cdcNotice = (level: number, title: string, pubDate: string) =>
  ({ title, link: 'https://wwwnc.cdc.gov/travel/notices/x', pubDate, source: 'CDC Travel Notices', sourceCountry: 'US', level: `cdc-${level}`, country: 'VE' });
const embassyAlert = { title: 'Security Alert: Caracas demonstrations', link: 'https://ve.usembassy.gov/alert/', pubDate: '2026-11-05T12:00:00Z', source: 'US Embassy Venezuela', sourceCountry: 'US', level: 'info', country: 'VE' };

function mount(withReading = true, { rows = [] as object[], advisories = [] as object[] } = {}) {
  const record = withReading
    ? liveTopicReading(travelAdvisoriesPage, {
      advisories,
      byCountry: {},
      registerLevels: [
        ...register('US', (code, i) => (code === 'VE' ? 'reconsider' : code === 'RU' ? 'do-not-travel' : LEVELS[i % 2]!)),
        ...register('AU', (code, i) => (code === 'VE' ? 'do-not-travel' : code === 'RU' ? 'do-not-travel' : LEVELS[i % 2]!)),
        ...rows,
      ],
      fetchedAt: NOW - 60_000,
    }, NOW)
    : null;
  if (withReading && !record) throw new Error('fixture did not produce a reading');
  document.body.innerHTML = `${travelAdvisoriesPage.renderFigure!({ worldMapSvg: stubMap })}${travelAdvisoriesPage.renderSection(record, { live: true })}`;
  new Function(travelAdvisoriesPage.script!)();
}

const tip = () => document.querySelector<HTMLElement>('.advisory-tip')!;
const land = (code: string) => document.querySelector<SVGPathElement>(`.advisory-map [data-iso2="${code}"]`)!;
const hover = (code: string, pointerType = 'mouse') => land(code).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType, clientX: 10, clientY: 10 }));

afterEach(() => {
  document.body.innerHTML = '';
  location.hash = '';
});

describe('travel advisory map page script', () => {
  it('shows both governments’ advice and the gap for the hovered country', () => {
    mount();
    expect(tip().hidden).toBe(true);
    hover('VE');
    expect(tip().hidden).toBe(false);
    const text = tip().textContent!;
    expect(text).toContain('Venezuela');
    expect(text).toContain('Level 3: Reconsider Travel');
    expect(text).toContain('Do not travel');
    expect(text).toContain('Australia is stricter than the US by 1 level.');
    expect(text).not.toContain('UK');
    expect(text).toContain('Click for the full row and links');
    expect(land('VE').classList.contains('is-hover')).toBe(true);
    expect(document.querySelectorAll('.advisory-map title')).toHaveLength(0);
  });

  it('adds the UK’s warning in its own words and offers the UK view when the UK register was read', () => {
    mount(true, { rows: ukRegister() });
    hover('VE');
    const rows = [...tip().querySelectorAll('.tip-row')].map((row) => row.textContent);
    expect(rows[2]).toBe('UKAgainst all travel to parts, and all but essential travel to other partsIssued Oct 27, 2026');
    hover('FR');
    expect(tip().textContent).toContain('No warning against travel');
    const ukButton = document.querySelector<HTMLButtonElement>('[data-view-btn="UK"]')!;
    expect(ukButton.hidden).toBe(false);
    ukButton.click();
    expect(document.querySelector<HTMLElement>('.advisory-figure')!.dataset.view).toBe('UK');
    expect(document.querySelector('.advisory-figure-title')!.textContent).toBe('UK Foreign Office warnings');
  });

  it('shows the UK as the issuer of its own advice, not as unlisted', () => {
    mount(true, { rows: ukRegister() });
    hover('GB');
    expect(tip().textContent).toContain('Issues the UK Foreign Office travel advice.');
    expect([...tip().querySelectorAll('.tip-who')].map((el) => el.textContent)).toEqual(['US', 'Australia']);
    hover('CN');
    expect(tip().textContent).toContain('None of the three governments lists it separately.');
  });

  it('adds the latest embassy alert and the strongest CDC notices, and counts the rest', () => {
    mount(true, {
      rows: [
        cdcNotice(1, 'Level 1 - Measles in Venezuela', '2026-10-01T00:00:00Z'),
        cdcNotice(3, 'Level 3 - Cholera in Zulia State of Venezuela', '2026-09-01T00:00:00Z'),
        cdcNotice(2, 'Level 2 - Dengue in Venezuela', '2026-10-15T00:00:00Z'),
      ],
      advisories: [embassyAlert],
    });
    hover('VE');
    const rows = [...tip().querySelectorAll('.tip-row')].map((row) => row.textContent);
    expect(rows.slice(2)).toEqual([
      'EmbassySecurity Alert: Caracas demonstrationsPosted Nov 5, 2026',
      'CDCLevel 3 - Cholera in Zulia State of VenezuelaIssued Sep 1, 2026',
      'CDCLevel 2 - Dengue in VenezuelaIssued Oct 15, 2026',
    ]);
    expect(tip().textContent).toContain('1 more CDC health notice in the row.');
    hover('FR');
    expect(tip().textContent).not.toContain('CDC');
  });

  it('does not show the issuing government rating itself', () => {
    mount();
    hover('AU');
    const text = tip().textContent!;
    expect(text).toContain('Issues Australia’s Smartraveller advisories.');
    expect(text).not.toContain('Australia' + 'No advisory listed');
    expect([...tip().querySelectorAll('.tip-who')].map((el) => el.textContent)).toEqual(['US']);
  });

  it('says so for a country neither register lists', () => {
    mount();
    hover('CN');
    expect(tip().textContent).toContain('China');
    expect(tip().textContent).toContain('Neither government lists it separately.');
  });

  it('switches the map view and its heading from the toggle', () => {
    mount();
    const figure = document.querySelector<HTMLElement>('.advisory-figure')!;
    expect(document.querySelector<HTMLElement>('.view-toggle')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-view-btn="gap"]')!.click();
    expect(figure.dataset.view).toBe('gap');
    expect(document.querySelector('.advisory-figure-title')!.textContent).toBe('Where the US and Australia differ');
    expect(document.querySelector<HTMLElement>('[data-view-btn="UK"]')!.hidden, 'no UK register, no UK view').toBe(true);
    expect(document.querySelector('[data-view-btn="gap"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-view-btn="US"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('jumps to the country’s row on click, and needs a second tap on touch', () => {
    mount();
    const tap = (code: string) => land(code).dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }));
    tap('VE');
    expect(location.hash).toBe('');
    expect(tip().textContent).toContain('Venezuela');
    expect(tip().textContent).toContain('Tap again for the full row and links');
    tap('VE');
    expect(location.hash).toBe('#advisory-ve');
    land('RU').dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'mouse' }));
    expect(location.hash).toBe('#advisory-ru');
  });

  it('narrows the destination table from the search box', () => {
    mount();
    const search = document.querySelector<HTMLInputElement>('#advisory-search')!;
    expect(search.closest<HTMLElement>('.advisory-filter')!.hidden).toBe(false);
    search.value = 'venez';
    search.dispatchEvent(new Event('input'));
    const shown = [...document.querySelectorAll<HTMLElement>('.advisory-table tbody tr')].filter((row) => !row.hidden);
    expect(shown.map((row) => row.id)).toEqual(['advisory-ve']);
    expect(document.querySelector('#advisory-search-count')!.textContent).toBe('1 destination');
  });

  it('scrolls to the row again on a repeat click, and reveals a row the search hid', () => {
    mount();
    const row = document.getElementById('advisory-ve')!;
    let scrolled = 0;
    row.scrollIntoView = () => { scrolled += 1; };
    const click = () => land('VE').dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'mouse' }));
    click();
    expect(location.hash).toBe('#advisory-ve');
    expect(scrolled).toBe(0);
    click();
    expect(scrolled, 'the hash is already set, so the second click scrolls itself').toBe(1);

    const search = document.querySelector<HTMLInputElement>('#advisory-search')!;
    search.value = 'fra';
    search.dispatchEvent(new Event('input'));
    const russia = document.getElementById('advisory-ru')!;
    expect(russia.hidden).toBe(true);
    russia.scrollIntoView = () => {};
    land('RU').dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'mouse' }));
    expect(russia.hidden).toBe(false);
    expect(search.value).toBe('');
  });

  it('opens the card on the first tap even after a finger drifted over the map', () => {
    mount();
    hover('VE', 'touch');
    land('VE').dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'touch' }));
    expect(location.hash).toBe('');
    expect(tip().textContent).toContain('Venezuela');
  });

  it('does not claim a shape with no register row has no advice', () => {
    mount();
    document.querySelector('.advisory-map')!.insertAdjacentHTML('beforeend', '<path class="land" d="M0 0h1v1z"><title>Unnamed</title></path>');
    new Function(travelAdvisoriesPage.script!)();
    document.querySelector('.advisory-map .land:not([data-iso2])')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    expect(tip().textContent).toContain('Unnamed');
    expect(tip().textContent).toContain('Neither government lists it separately.');
  });

  it('finds a destination without its accents', () => {
    mount();
    const search = document.querySelector<HTMLInputElement>('#advisory-search')!;
    const accented = [...document.querySelectorAll('.advisory-table tbody th')].find((th) => /[^\u0000-\u007f]/.test(th.textContent!.replace(/[’&]/g, '')));
    expect(accented, 'the fixture has an accented name').toBeTruthy();
    search.value = accented!.textContent!.normalize('NFD').replace(/\p{M}/gu, '').slice(0, 8);
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('#advisory-search-count')!.textContent).not.toBe('0 destinations');
    search.value = 'turkey';
    search.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll<HTMLElement>('.advisory-table tbody tr')].filter((row) => !row.hidden).map((row) => row.id)).toEqual(['advisory-tr']);
  });

  it('treats a tap as touch when the click carries no pointerType (Safari before 18.2)', () => {
    mount();
    land('VE').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    land('VE').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(location.hash).toBe('');
    expect(tip().textContent).toContain('Venezuela');
    land('VE').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    land('VE').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(location.hash).toBe('#advisory-ve');
  });

  it('opens the card on the first tap even when the tap focuses the country first', () => {
    mount();
    const target = land('VE');
    // Chrome's touch order: pointerdown, pointerup, then the compatibility
    // mousedown that focuses the country, then click.
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    target.focus();
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(location.hash).toBe('');
    expect(tip().textContent).toContain('Venezuela');
    expect(tip().textContent).toContain('Tap again for the full row and links');
  });

  it('still opens the card on keyboard focus after a mouse press released off the map', () => {
    mount();
    land('FR').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    land('VE').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toContain('Venezuela');
    expect(tip().textContent).toContain('Press Enter for the full row and links');
  });

  it('matches a typed straight apostrophe against a typographic one', () => {
    mount();
    const search = document.querySelector<HTMLInputElement>('#advisory-search')!;
    search.value = "cote d'ivoire";
    search.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll<HTMLElement>('.advisory-table tbody tr')].filter((row) => !row.hidden).map((row) => row.id)).toEqual(['advisory-ci']);
  });

  it('lets a keyboard reach every country from one tab stop and open its row', () => {
    mount();
    const lands = [...document.querySelectorAll<SVGPathElement>('.advisory-map .land')];
    expect(lands.filter((path) => path.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(document.querySelector('.advisory-map')!.getAttribute('tabindex')).toBe('-1');
    const first = lands.find((path) => path.getAttribute('tabindex') === '0')!;
    expect(first.getAttribute('aria-label')).toBe('Australia');
    first.focus();
    first.dispatchEvent(new FocusEvent('focus'));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toContain('Australia');
    const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    key(first, 'ArrowRight');
    const second = document.activeElement as SVGPathElement;
    expect(second.getAttribute('aria-label')).toBe('China');
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');
    key(second, 'End');
    expect((document.activeElement as Element).getAttribute('aria-label')).toBe('Venezuela');
    document.getElementById('advisory-ve')!.scrollIntoView = () => {};
    key(document.activeElement!, 'Enter');
    expect(location.hash).toBe('#advisory-ve');
  });

  it('keeps the toggle hidden and makes no advice claim without a reading', () => {
    mount(false);
    expect(document.querySelector<HTMLElement>('.view-toggle')!.hidden).toBe(true);
    hover('FR');
    expect(tip().textContent).toContain('No current reading of the registers.');
  });
});
