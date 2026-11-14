import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// A panel header holds the title, status badges and controls in one row. In a
// 248px dashboard column (a 1366px laptop) the fixed-size badges spilled under
// the controls and the title shrank to nothing. On a phone the panel is 377px
// wide with a 13px title, and the same badges squeezed "Intel Feed" to 5px. The
// title must stay readable and nothing in the header may overlap at any width.
// A long title may take a second line but never a third. On a touch screen each
// header control must take a tap anywhere in a 24x24 box (WCAG 2.5.8). Status
// badges shrunk to dots must still tell their states apart without colour.

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 1440, height: 900, mobile: false },
  // A touch screen with columns under 300px, where controls sit 4px apart.
  { width: 1280, height: 800, mobile: true },
  { width: 393, height: 852, mobile: true },
  { width: 360, height: 780, mobile: true },
];

const ITEMS = [
  { source: 'BBC World', title: 'Army launches missile strike on naval base after drone attack', isAlert: true },
  { source: 'BBC World', title: 'Central bank raises rates as inflation climbs for a third month', isAlert: false },
  { source: 'BBC World', title: 'Government issues warning to armed groups ahead of the election', isAlert: false },
];

function digest(): string {
  return JSON.stringify({
    categories: { politics: { items: ITEMS.map((item, i) => ({ ...item, link: `https://example.com/politics/${i}`, publishedAt: Date.now() - i * 60_000 })) } },
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
  });
}

// A real news-panel title. On one line it is wider than the room a news header
// leaves its title in a 248px column, but each of its words fits there.
const LONG_TITLE = 'Energy & Resources';
// A real panel title that, beside a methodology button and two dots in a
// narrow column, fits in two lines only if the dots move under it.
const WRAP_TITLE = 'Strategic Risk Overview';

interface HeaderFit { panel: number; title: string; titleClipped: boolean; titleLines: number; belowTitle: string[]; overlaps: string[] }

interface BadgeBox { width: number; height: number; fontSize: string; title: string }

// The freshness badge needs mapped sources and a health poll, so the probe adds
// one to the politics header. Both badges then render through the real
// stylesheet: dots below a 300px column, full pills above it.
function measureBadges(page: Page): Promise<{ freshness: BadgeBox; live: BadgeBox }> {
  return page.evaluate(() => {
    const left = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header-left')!;
    let probe = left.querySelector<HTMLElement>('[data-freshness-probe]');
    if (!probe) {
      probe = document.createElement('span');
      probe.className = 'panel-freshness-badge panel-freshness-fresh';
      probe.dataset.freshnessProbe = '';
      probe.textContent = '5m ago';
      probe.title = 'Updated 5 minutes ago';
      probe.style.display = 'inline-flex';
      left.appendChild(probe);
    }
    const box = (el: HTMLElement): BadgeBox => {
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height), fontSize: getComputedStyle(el).fontSize, title: el.title };
    };
    return { freshness: box(probe), live: box(document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-data-badge.live')!) };
  });
}

interface CounterBox { name: string; display: string; width: number }

// The counters the JS shows with an inline display. Below 300px they leave the
// layout but stay in the accessibility tree, so screen readers keep the values.
function measureCounters(page: Page): Promise<CounterBox[]> {
  return page.evaluate(() => {
    const left = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header-left')!;
    const COUNTER_TEXT: Record<string, string> = { 'panel-new-badge': '14 NEW', 'deviation-indicator': '▲', 'panel-count': '14' };
    return ['panel-new-badge', 'deviation-indicator', 'panel-count'].map((name) => {
      // The header already renders a real item count on the right; probing a
      // second one inside the title group would crowd it beyond any live header.
      const real = name === 'panel-count' ? left.parentElement?.querySelector<HTMLElement>(':scope > .panel-count') : null;
      let el = real ?? left.querySelector<HTMLElement>(`[data-counter-probe="${name}"]`);
      if (!el) {
        el = document.createElement('span');
        el.className = name;
        el.dataset.counterProbe = name;
        el.textContent = COUNTER_TEXT[name] ?? '';
        el.style.display = 'inline-flex';
        left.appendChild(el);
      }
      return { name, display: getComputedStyle(el).display, width: Math.round(el.getBoundingClientRect().width) };
    });
  });
}

function measure(page: Page, key = 'politics'): Promise<HeaderFit> {
  return page.evaluate((key) => {
    const panel = document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel="${key}"]`)!;
    const header = panel.querySelector<HTMLElement>('.panel-header')!;
    const title = header.querySelector<HTMLElement>('.panel-title')!;
    const items = [...header.querySelectorAll<HTMLElement>('.panel-title, .panel-header-left > *, .panel-header > *:not(.panel-header-left)')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ name: el.className.toString().split(' ')[0] ?? '', rect: el.getBoundingClientRect() }));
    const overlaps: string[] = [];
    items.forEach((a, i) => {
      for (const b of items.slice(i + 1)) {
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (x > 2 && y > 2) overlaps.push(`${a.name} x ${b.name}`);
      }
    });
    // Line boxes the text needs, including any the title cuts off. Boxes that
    // share any height sit on one line.
    const range = document.createRange();
    range.selectNodeContents(title);
    let titleLines = 0;
    let lineBottom = -Infinity;
    for (const r of [...range.getClientRects()].sort((a, b) => a.top - b.top)) {
      if (r.top >= lineBottom - 1) {
        titleLines++;
        lineBottom = r.bottom;
      } else {
        lineBottom = Math.max(lineBottom, r.bottom);
      }
    }
    const titleBottom = title.getBoundingClientRect().bottom;
    return {
      panel: Math.round(panel.getBoundingClientRect().width),
      title: title.textContent ?? '',
      titleClipped: title.scrollWidth > title.clientWidth + 1 || title.scrollHeight > title.clientHeight + 1,
      titleLines,
      belowTitle: items.filter((item) => item.rect.width > 1 && item.rect.top >= titleBottom - 1).map((item) => item.name),
      overlaps,
    };
  }, key);
}

function setTitle(page: Page, text: string): Promise<void> {
  return page.evaluate((value) => {
    document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-title')!.textContent = value;
  }, text);
}

// The politics header has no methodology button, so the probe adds one built
// like Panel.ts builds it.
function addInfoButton(page: Page): Promise<void> {
  return page.evaluate(() => {
    const left = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header-left')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'panel-info-wrapper';
    const button = document.createElement('button');
    button.className = 'panel-info-btn';
    button.setAttribute('aria-label', 'Show methodology info');
    button.textContent = '?';
    wrapper.appendChild(button);
    left.querySelector('.panel-title')!.after(wrapper);
  });
}

// Reads a collapsed dot's shape from its pixels, ignoring its colour: a ring or
// an outline leaves the middle empty, and only a square inks its corners. Ink
// is measured against the header behind the dot and scaled to the dot's
// strongest pixel, so the colour of the state does not count. The page fades
// colour changes over 200ms, so the capture skips to the end of the fade.
async function dotShape(page: Page, selector: string): Promise<string> {
  const dot = page.locator(selector);
  await dot.scrollIntoViewIfNeeded();
  const box = (await dot.boundingBox())!;
  const pad = 3;
  const clip = { x: Math.floor(box.x) - pad, y: Math.floor(box.y) - pad, width: Math.ceil(box.width) + 2 * pad + 1, height: Math.ceil(box.height) + 2 * pad + 1 };
  const png = (await page.screenshot({ clip, animations: 'disabled' })).toString('base64');
  return page.evaluate(async ({ png, clip, box }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const scale = img.width / clip.width;
    const pixel = (x: number, y: number) => ctx.getImageData(Math.floor((x - clip.x) * scale), Math.floor((y - clip.y) * scale), 1, 1).data;
    const background = pixel(clip.x + 0.5, clip.y + 0.5);
    const distance = (p: Uint8ClampedArray) => Math.max(...[0, 1, 2].map((i) => Math.abs(p[i]! - background[i]!)));
    let strongest = 0;
    for (let y = box.y; y < box.y + box.height; y += 0.5 / scale) {
      for (let x = box.x; x < box.x + box.width; x += 0.5 / scale) strongest = Math.max(strongest, distance(pixel(x, y)));
    }
    if (strongest < 48) return 'invisible';
    const ink = (dx: number, dy: number) => distance(pixel(box.x + dx, box.y + dy)) / strongest;
    const mid = box.width / 2;
    const middle = (ink(mid - 0.5, mid - 0.5) + ink(mid + 0.5, mid - 0.5) + ink(mid - 0.5, mid + 0.5) + ink(mid + 0.5, mid + 0.5)) / 4;
    const corner = (ink(0.75, 0.75) + ink(box.width - 0.75, 0.75) + ink(0.75, box.height - 0.75) + ink(box.width - 0.75, box.height - 0.75)) / 4;
    return `${middle > 0.5 ? 'filled' : 'hollow'} ${corner > 0.5 ? 'square' : 'circle'}`;
  }, { png, clip, box });
}

// Sets a header badge to a state the way Panel.ts does and reads its dot.
async function badgeShapes(page: Page, selector: string, states: Record<string, string>): Promise<Record<string, string>> {
  const shapes: Record<string, string> = {};
  for (const [state, className] of Object.entries(states)) {
    await page.evaluate(({ selector, className, state }) => {
      const badge = document.querySelector<HTMLElement>(selector)!;
      badge.className = className;
      badge.textContent = state.toUpperCase();
      badge.title = state;
    }, { selector, className, state });
    shapes[state] = await dotShape(page, selector);
  }
  return shapes;
}

const DATA_BADGE = '#panelsGrid .panel[data-panel="politics"] .panel-header > .panel-data-badge';
const DATA_STATES = { live: 'panel-data-badge live', cached: 'panel-data-badge cached', unavailable: 'panel-data-badge unavailable' };
const FRESHNESS_BADGE = '#panelsGrid .panel[data-panel="politics"] [data-freshness-probe]';
const FRESHNESS_STATES = {
  fresh: 'panel-freshness-badge panel-freshness-fresh',
  stale: 'panel-freshness-badge panel-freshness-stale',
  very_stale: 'panel-freshness-badge panel-freshness-very_stale',
  no_data: 'panel-freshness-badge panel-freshness-no_data',
  disabled: 'panel-freshness-badge panel-freshness-disabled',
  error: 'panel-freshness-badge panel-freshness-error',
};

interface TapTarget { control: string; box: string; misses: string[] }

// Probes each header control at the corners, edge midpoints and center of a
// 24x24 box centered on it. A point that lands on anything else is a miss, so a
// neighbor's tap area reaching into this box is a miss too.
function measureTapTargets(page: Page, key = 'politics', controls = ['panel-close-btn', 'panel-sort-btn', 'panel-summarize-btn', 'panel-info-btn']): Promise<TapTarget[]> {
  return page.evaluate(({ key, controls }) => {
    const header = document.querySelector<HTMLElement>(`#panelsGrid .panel[data-panel="${key}"] .panel-header`)!;
    header.scrollIntoView({ block: 'center' });
    return controls.map((control) => {
      const el = header.querySelector<HTMLElement>(`.${control}`)!;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const misses: string[] = [];
      for (const dx of [-11.5, 0, 11.5]) {
        for (const dy of [-11.5, 0, 11.5]) {
          const hit = document.elementFromPoint(cx + dx, cy + dy);
          if (!hit || !el.contains(hit)) misses.push(`(${dx}, ${dy}) hits ${hit ? hit.className.toString().split(' ')[0] || hit.tagName : 'nothing'}`);
        }
      }
      return { control, box: `${Math.round(r.width)}x${Math.round(r.height)}`, misses };
    });
  }, { key, controls });
}

test('panel headers keep the title readable with nothing overlapping', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  for (const { mobile, ...viewport } of VIEWPORTS) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' });
    const page = await context.newPage();
    const settings = { politics: { name: 'World News', enabled: true, priority: 0 } };
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route('**/api/news/v1/list-feed-digest*', (route) => route.fulfill({ contentType: 'application/json', body: digest() }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="politics"]');
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.item.clustered').count();
      }, { message: `politics rows at ${viewport.width}px`, timeout: 90_000 })
      .toBe(ITEMS.length);
    // Add the freshness badge and counters a live header carries before
    // measuring, so the title competes with everything that crowds it in prod.
    const badges = await measureBadges(page);
    const counters = await measureCounters(page);
    await panel.locator('.panel-header').screenshot({ path: testInfo.outputPath(`header-${viewport.width}.png`) });
    const m = await measure(page);
    const label = `politics header at ${viewport.width}px (panel ${m.panel}px)`;
    expect.soft(m.titleClipped, `${label}: title "${m.title}" is clipped`).toBe(false);
    expect.soft(m.titleLines, `${label}: short title "${m.title}" keeps one line`).toBe(1);
    expect.soft(m.overlaps, `${label}: overlapping header items`).toEqual([]);
    // Below 300px every badge is a dot and every counter leaves the layout. A
    // news header up to 420px wide also turns LIVE into a dot and drops the
    // item count, so the title keeps the room the controls would take.
    const collapseAt: Record<string, number> = { 'panel-new-badge': 300, 'deviation-indicator': 300, 'panel-count': 420, freshness: 300, live: 420 };
    for (const c of counters) {
      expect.soft(c.display, `${label}: ${c.name} stays in the accessibility tree`).not.toBe('none');
      if (m.panel <= collapseAt[c.name]!) expect.soft(c.width, `${label}: ${c.name} is visually hidden`).toBeLessThanOrEqual(1);
      else expect.soft(c.width, `${label}: ${c.name} is shown`).toBeGreaterThan(4);
    }
    for (const [name, b] of Object.entries(badges)) {
      if (m.panel <= collapseAt[name]!) {
        expect.soft({ width: b.width, height: b.height, fontSize: b.fontSize }, `${label}: ${name} badge is a dot`).toEqual({ width: 8, height: 8, fontSize: '0px' });
        expect.soft(b.title, `${label}: ${name} dot has a hover label`).not.toBe('');
      } else {
        expect.soft(b.width, `${label}: ${name} badge keeps its text`).toBeGreaterThan(20);
      }
    }
    // A long title takes a second line instead of losing its end.
    await setTitle(page, LONG_TITLE);
    await panel.locator('.panel-header').screenshot({ path: testInfo.outputPath(`header-${viewport.width}-long-title.png`) });
    const long = await measure(page);
    expect.soft(long.titleClipped, `${label}: title "${LONG_TITLE}" is clipped`).toBe(false);
    expect.soft(long.titleLines, `${label}: title "${LONG_TITLE}" takes at most two lines`).toBeLessThanOrEqual(2);
    expect.soft(long.overlaps, `${label}: overlapping header items with a long title`).toEqual([]);
    // In a column below 300px the dots sit beside a two-line title rather
    // than on a row of their own.
    if (long.panel < 300) expect.soft(long.belowTitle, `${label}: header items under "${LONG_TITLE}"`).toEqual([]);
    // The dots move under a title they would otherwise push onto a third line.
    await addInfoButton(page);
    await setTitle(page, WRAP_TITLE);
    await panel.locator('.panel-header').screenshot({ path: testInfo.outputPath(`header-${viewport.width}-wrap-title.png`) });
    const wrap = await measure(page);
    expect.soft(wrap.titleClipped, `${label}: title "${WRAP_TITLE}" is clipped`).toBe(false);
    expect.soft(wrap.titleLines, `${label}: title "${WRAP_TITLE}" takes at most two lines`).toBeLessThanOrEqual(2);
    expect.soft(wrap.overlaps, `${label}: overlapping header items with "${WRAP_TITLE}"`).toEqual([]);
    if (mobile) {
      for (const target of await measureTapTargets(page)) {
        expect.soft(target.misses, `${label}: ${target.control} (${target.box}) takes taps across a 24x24 box`).toEqual([]);
      }
    }
    // A watchlist button crowds a header as much as a 250px column does, so up
    // to 420px it keeps only its icon and its name.
    await page.evaluate(async () => {
      const { createWatchlistButton } = await import('/src/components/watchlist-modal.ts');
      document.querySelector('#panelsGrid .panel[data-panel="politics"] .panel-header')!.appendChild(createWatchlistButton('Edit Watchlist'));
    });
    const watchlist = await panel.getByRole('button', { name: 'Edit Watchlist' }).boundingBox();
    if (m.panel <= 420) expect.soft(watchlist?.width, `${label}: watchlist button is an icon`).toBeLessThanOrEqual(26);
    else expect.soft(watchlist?.width, `${label}: watchlist button keeps its text`).toBeGreaterThan(60);
    const close = await panel.locator('.panel-close-btn').boundingBox();
    const middle = (box: { y: number; height: number } | null) => (box ? box.y + box.height / 2 : NaN);
    expect.soft(Math.abs(middle(watchlist) - middle(close)), `${label}: watchlist button lines up with close beside a long title`).toBeLessThanOrEqual(1.5);
    expect.soft((await measure(page)).overlaps, `${label}: overlapping header items with a watchlist button`).toEqual([]);
    // Forced colors strip the dot's background, so a collapsed dot must still
    // draw something.
    await page.emulateMedia({ forcedColors: 'active' });
    const dots = { freshness: FRESHNESS_BADGE, live: `${DATA_BADGE}.live` };
    for (const [name, selector] of Object.entries(dots)) {
      if (m.panel <= collapseAt[name]!) expect.soft(await dotShape(page, selector), `${label}: ${name} dot is visible in forced colors`).not.toBe('invisible');
    }
    // In the same header a cached data badge becomes a dot like LIVE does.
    await page.emulateMedia({ forcedColors: 'none' });
    const cachedBadge = () => page.evaluate(() => {
      const badge = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header > .panel-data-badge')!;
      badge.className = 'panel-data-badge cached';
      badge.textContent = 'CACHED';
      badge.title = 'Showing cached data';
      const r = badge.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height), fontSize: getComputedStyle(badge).fontSize, border: parseFloat(getComputedStyle(badge).borderTopWidth) };
    });
    const cached = await cachedBadge();
    if (m.panel <= 420) {
      expect.soft({ width: cached.width, height: cached.height, fontSize: cached.fontSize }, `${label}: cached badge is a dot`).toEqual({ width: 8, height: 8, fontSize: '0px' });
      await page.emulateMedia({ forcedColors: 'active' });
      expect.soft((await cachedBadge()).border, `${label}: cached dot keeps a border in forced colors`).toBeGreaterThanOrEqual(1);
    } else {
      expect.soft(cached.width, `${label}: cached badge keeps its text`).toBeGreaterThan(20);
    }
    // Below 300px the dots tell their states apart by shape, not by colour
    // alone (WCAG 1.4.1), with and without forced colors. A freshness dot uses
    // the same shapes: fresh reads like live, stale like cached, and missing
    // or failed data like unavailable.
    if (m.panel <= 300) {
      for (const forcedColors of ['none', 'active'] as const) {
        await page.emulateMedia({ forcedColors });
        const where = `${label}${forcedColors === 'active' ? ' in forced colors' : ''}`;
        const data = await badgeShapes(page, DATA_BADGE, DATA_STATES);
        expect.soft(Object.values(data), `${where}: data badge dots are visible`).not.toContain('invisible');
        expect.soft(new Set(Object.values(data)).size, `${where}: live, cached and unavailable dots differ in shape ${JSON.stringify(data)}`).toBe(3);
        const freshness = await badgeShapes(page, FRESHNESS_BADGE, FRESHNESS_STATES);
        expect.soft(freshness, `${where}: freshness dots use the data badge shapes`).toEqual({
          fresh: data.live,
          stale: data.cached,
          very_stale: data.cached,
          no_data: data.unavailable,
          disabled: data.unavailable,
          error: data.unavailable,
        });
      }
    }
    await context.close();
  }
});

// The real Markets header carries a methodology button, a data badge and the
// watchlist button, as Premium Stock Analysis and Daily Market Brief do. On a
// phone their CACHED pill and "Edit Watchlist" left the title 113px, and
// "Premium Stock Analysis" lost its last word.
const WATCHLIST_VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 393, height: 852, mobile: true },
  { width: 360, height: 780, mobile: true },
];
const WATCHLIST_TITLE = 'Premium Stock Analysis';
const MARKETS_BADGE = '#panelsGrid .panel[data-panel="markets"] .panel-header > .panel-data-badge';

test('a header with a watchlist button keeps a long title readable beside a cached badge', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const { mobile, ...viewport } of WATCHLIST_VIEWPORTS) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' });
    const page = await context.newPage();
    const settings = { politics: { name: 'World News', enabled: true, priority: 0 }, markets: { name: 'Markets', enabled: true, priority: 0 } };
    await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-panels': JSON.stringify(settings) } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));

    await page.goto('/dashboard');
    const panel = page.locator('#panelsGrid .panel[data-panel="markets"]');
    const watchlist = panel.getByRole('button', { name: 'Edit Watchlist' });
    await expect
      .poll(async () => {
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        return panel.locator('.panel-watchlist-btn').count();
      }, { message: `markets watchlist button at ${viewport.width}px`, timeout: 90_000 })
      .toBe(1);
    await page.evaluate((title) => {
      const header = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="markets"] .panel-header')!;
      header.querySelector('.panel-title')!.textContent = title;
      const pro = document.createElement('span');
      pro.className = 'panel-pro-badge';
      pro.textContent = 'PRO';
      header.querySelector('.panel-header-left')!.appendChild(pro);
      header.querySelector('.panel-watchlist-label')!.textContent = 'Edit Watchlist';
      const badge = header.querySelector<HTMLElement>(':scope > .panel-data-badge')!;
      badge.className = 'panel-data-badge cached';
      badge.textContent = 'CACHED · 12 symbols';
      badge.title = 'Showing cached data for 12 symbols';
      badge.style.display = 'inline-flex';
    }, WATCHLIST_TITLE);
    await panel.locator('.panel-header').screenshot({ path: testInfo.outputPath(`watchlist-header-${viewport.width}.png`) });
    const m = await measure(page, 'markets');
    const label = `markets header at ${viewport.width}px (panel ${m.panel}px)`;
    expect(m.panel, `${label}: a phone panel or a 375px column`).toBeLessThanOrEqual(420);
    expect.soft(m.titleClipped, `${label}: title "${WATCHLIST_TITLE}" is clipped`).toBe(false);
    expect.soft(m.titleLines, `${label}: title "${WATCHLIST_TITLE}" takes at most two lines`).toBeLessThanOrEqual(2);
    expect.soft(m.overlaps, `${label}: overlapping header items`).toEqual([]);
    expect.soft((await watchlist.boundingBox())?.width, `${label}: watchlist button is an icon`).toBeLessThanOrEqual(26);
    const badge = await page.locator(MARKETS_BADGE).boundingBox();
    expect.soft({ width: badge?.width, height: badge?.height }, `${label}: cached badge is a dot`).toEqual({ width: 8, height: 8 });
    if (mobile) {
      for (const target of await measureTapTargets(page, 'markets', ['panel-close-btn', 'panel-info-btn', 'panel-watchlist-btn'])) {
        expect.soft(target.misses, `${label}: ${target.control} (${target.box}) takes taps across a 24x24 box`).toEqual([]);
      }
    }
    for (const forcedColors of ['none', 'active'] as const) {
      await page.emulateMedia({ forcedColors });
      const where = `${label}${forcedColors === 'active' ? ' in forced colors' : ''}`;
      expect.soft(await badgeShapes(page, MARKETS_BADGE, DATA_STATES), `${where}: data badge dots differ in shape`).toEqual({
        live: 'filled circle',
        cached: 'hollow circle',
        unavailable: 'hollow square',
      });
    }
    await context.close();
  }
});
