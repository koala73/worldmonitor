import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// A panel header holds the title, status badges and controls in one row. In a
// 248px dashboard column (a 1366px laptop) the fixed-size badges spilled under
// the controls and the title shrank to nothing. On a phone the panel is 377px
// wide with a 13px title, and the same badges squeezed "Intel Feed" to 5px. The
// title must stay readable and nothing in the header may overlap at any width.
// A long title may take a second line but never a third. On a touch screen each
// header control must take a tap anywhere in a 24x24 box (WCAG 2.5.8).

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
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

function measure(page: Page): Promise<HeaderFit> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"]')!;
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
  });
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

interface TapTarget { control: string; box: string; misses: string[] }

// Probes each header control at the corners, edge midpoints and center of a
// 24x24 box centered on it. A point that lands on anything else is a miss, so a
// neighbor's tap area reaching into this box is a miss too.
function measureTapTargets(page: Page): Promise<TapTarget[]> {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header')!;
    header.scrollIntoView({ block: 'center' });
    return ['panel-close-btn', 'panel-sort-btn', 'panel-summarize-btn', 'panel-info-btn'].map((control) => {
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
  });
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
    // In a 248px laptop column the dots sit beside a two-line title rather
    // than on a row of their own.
    if (viewport.width === 1366) expect.soft(long.belowTitle, `${label}: header items under "${LONG_TITLE}"`).toEqual([]);
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
    // Below 300px the watchlist button keeps only its icon and its name.
    await page.evaluate(async () => {
      const { createWatchlistButton } = await import('/src/components/watchlist-modal.ts');
      document.querySelector('#panelsGrid .panel[data-panel="politics"] .panel-header')!.appendChild(createWatchlistButton('Edit Watchlist'));
    });
    const watchlist = await panel.getByRole('button', { name: 'Edit Watchlist' }).boundingBox();
    if (m.panel <= 300) expect.soft(watchlist?.width, `${label}: watchlist button is an icon`).toBeLessThanOrEqual(26);
    else expect.soft(watchlist?.width, `${label}: watchlist button keeps its text`).toBeGreaterThan(60);
    const close = await panel.locator('.panel-close-btn').boundingBox();
    const middle = (box: { y: number; height: number } | null) => (box ? box.y + box.height / 2 : NaN);
    expect.soft(Math.abs(middle(watchlist) - middle(close)), `${label}: watchlist button lines up with close beside a long title`).toBeLessThanOrEqual(1.5);
    expect.soft((await measure(page)).overlaps, `${label}: overlapping header items with a watchlist button`).toEqual([]);
    // Forced colors strip the dot's background, so a collapsed dot must keep a
    // border or it disappears.
    await page.emulateMedia({ forcedColors: 'active' });
    const borders = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="politics"] .panel-header')!;
      const width = (sel: string) => parseFloat(getComputedStyle(header.querySelector<HTMLElement>(sel)!).borderTopWidth);
      return { freshness: width('[data-freshness-probe]'), live: width('.panel-data-badge.live') };
    });
    for (const [name, w] of Object.entries(borders)) {
      if (m.panel <= collapseAt[name]!) expect.soft(w, `${label}: ${name} dot keeps a border in forced colors`).toBeGreaterThanOrEqual(1);
    }
    // Below 300px a cached data badge becomes a dot like LIVE does.
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
    if (m.panel <= 300) {
      expect.soft({ width: cached.width, height: cached.height, fontSize: cached.fontSize }, `${label}: cached badge is a dot`).toEqual({ width: 8, height: 8, fontSize: '0px' });
      await page.emulateMedia({ forcedColors: 'active' });
      expect.soft((await cachedBadge()).border, `${label}: cached dot keeps a border in forced colors`).toBeGreaterThanOrEqual(1);
    } else {
      expect.soft(cached.width, `${label}: cached badge keeps its text`).toBeGreaterThan(20);
    }
    await context.close();
  }
});
