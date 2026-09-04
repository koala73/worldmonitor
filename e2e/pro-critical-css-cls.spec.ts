import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// prerender.mjs inlines a hand-maintained critical CSS block and demotes the
// real stylesheet to `rel=preload` + a JS swap, so /pro and / paint from that
// block alone for as long as the sheet takes to arrive — 1.3s on DebugBear's
// mobile run. Anything the block resolves differently from the sheet reflows
// at the swap, and every pixel of that reflow is CLS.
//
// The block's region mirrors are all scoped to `main` / `nav[data-wm-nav]`,
// but index.html's crawlable #root markup puts its <h1> OUTSIDE <main>, so
// only the @layer base reset reaches it. When that reset omitted Tailwind
// preflight's heading, margin/padding, and list-style rules, the swap moved
// all 80 elements of the block and DebugBear scored /pro 0.28 CLS on mobile.
//
// This drives the built bytes rather than asserting on the CSS text, so a
// Tailwind upgrade that adds a geometry reset, or new crawlable markup that
// reaches an unmirrored element, fails here instead of shipping a shift.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-critical-css.test';
const STYLESHEET_DELAY_MS = 400;

// DebugBear's mobile profile. The narrower the viewport, the more lines an
// unreset <h1> wraps to and the further everything under it travels.
const MOBILE_VIEWPORT = { width: 360, height: 640 };

const PRO_PAGES = [
  { relPath: 'public/pro/index.html', label: '/pro' },
  { relPath: 'public/pro/welcome.html', label: '/' },
];

type ShiftSource = { node: string; dy: number; dh: number };
type Shift = { value: number; time: number; sources: ShiftSource[] };

declare global {
  interface Window {
    __wmProShifts?: Shift[];
  }
}

const deferredStylesheetHref = (html: string): string => {
  const tag = html.match(/<link\b[^>]*\bdata-wm-deferred-style\b[^>]*>/i)?.[0];
  expect(tag, 'built page must ship a deferred stylesheet preload').toBeTruthy();
  const href = tag!.match(/\bhref="([^"]+)"/)?.[1];
  expect(href, 'deferred stylesheet preload must carry an href').toBeTruthy();
  return href!;
};

const observeLayoutShifts = (page: Page) => page.addInitScript(() => {
  window.__wmProShifts = [];
  const describe = (node: Node | null | undefined): string => {
    if (!(node instanceof Element)) return '(detached)';
    return node.id ? `${node.tagName}#${node.id}` : node.tagName;
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & {
        value?: number;
        hadRecentInput?: boolean;
        sources?: Array<{ node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
      };
      if (shift.hadRecentInput) continue;
      window.__wmProShifts?.push({
        value: shift.value ?? 0,
        time: Math.round(entry.startTime),
        sources: (shift.sources ?? []).map((source) => ({
          node: describe(source.node),
          dy: Math.round(source.currentRect.y - source.previousRect.y),
          dh: Math.round(source.currentRect.height - source.previousRect.height),
        })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});

test.use({ viewport: MOBILE_VIEWPORT });

test.describe('pro critical CSS causes no layout shift when the deferred stylesheet lands', () => {
  for (const { relPath, label } of PRO_PAGES) {
    test(`${label} paints its final geometry before the stylesheet arrives`, async ({ page }) => {
      const htmlPath = resolve(repoRoot, relPath);
      expect(
        existsSync(htmlPath),
        `${relPath} is missing. Run \`npm run build:pro\` first.`,
      ).toBe(true);

      const html = readFileSync(htmlPath, 'utf8');
      const href = deferredStylesheetHref(html);
      const css = readFileSync(resolve(repoRoot, 'public', href.replace(/^\//, '')), 'utf8');

      // Serve only the document and the stylesheet, the latter late enough to
      // leave a real critical-CSS-only paint. Everything else is dropped: the
      // React bundle's mount replaces #root wholesale and is a different
      // shift with its own owner, and third-party beacons are noise.
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === href) {
          await new Promise((done) => setTimeout(done, STYLESHEET_DELAY_MS));
          return route.fulfill({ contentType: 'text/css', body: css });
        }
        if (url.pathname === '/pro') return route.fulfill({ contentType: 'text/html', body: html });
        return route.abort();
      });

      await observeLayoutShifts(page);
      await page.goto(`${ORIGIN}/pro`, { waitUntil: 'load' });
      await expect
        .poll(() => page.evaluate(() => document.styleSheets.length > 1), {
          message: 'the deferred stylesheet never swapped in',
        })
        .toBe(true);
      await page.evaluate(() => new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }));

      const shifts = await page.evaluate(() => window.__wmProShifts ?? []);
      const cls = shifts.reduce((total, shift) => total + shift.value, 0);
      const detail = shifts
        .map((shift) => {
          const sources = shift.sources
            .map((source) => `${source.node} dy=${source.dy} dh=${source.dh}`)
            .join('; ');
          return `${shift.time}ms value=${shift.value.toFixed(4)} [${sources}]`;
        })
        .join('\n');

      expect(
        cls,
        `${label} shifted when the deferred stylesheet applied. Mirror the missing `
        + `Tailwind preflight declarations into CRITICAL_CSS's @layer base in `
        + `pro-test/prerender.mjs.\n${detail}`,
      ).toBe(0);
    });
  }
});
