import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// /pro mounts with createRoot, which replaces the prerendered #root wholesale.
// When that static markup was only the curated crawler block, the React hero's
// <h1> was larger than anything painted before it, so every desktop visit
// emitted a second LCP entry at bundle-mount time: 1.8-2.4s locally against a
// ~45ms FCP, and `#root h1.text-6xl` was the LCP element on 393 of 708 desktop
// RUM views. prerender.mjs now paints the real nav + hero first, so React's
// same-size hero must not produce a new, later LCP entry.
//
// The entry script is held back long enough to separate "painted from HTML"
// from "painted by React" by a wide margin, and the stylesheet arrives late as
// it does in the field, so the first paint comes from critical CSS alone.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-hero-lcp.test';
const PRO_INDEX = 'public/pro/index.html';
const ENTRY_DELAY_MS = 1500;
const STYLESHEET_DELAY_MS = 400;

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 800, height: 1280 },
  { width: 1280, height: 800 },
];

type LcpRecord = { time: number; size: number; tag: string | null; inHero: boolean; text: string };

declare global {
  interface Window {
    __wmLcp?: LcpRecord[];
    __wmMountedAt?: number | null;
  }
}

test.describe('/pro hero is the LCP element before React mounts', () => {
  for (const viewport of VIEWPORTS) {
    test(`no LCP entry follows the bundle mount at ${viewport.width}px`, async ({ page }) => {
      const indexPath = resolve(repoRoot, PRO_INDEX);
      expect(existsSync(indexPath), `${PRO_INDEX} is missing. Run \`npm run build:pro\` first.`).toBe(true);
      const html = readFileSync(indexPath, 'utf8');
      const entry = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)?.[1];
      const stylesheetHref = html.match(/<link\b[^>]*\bdata-wm-deferred-style\b[^>]*>/i)?.[0].match(/\bhref="([^"]+)"/)?.[1];
      expect(entry, 'built /pro must ship a module entry script').toBeTruthy();
      expect(stylesheetHref, 'built /pro must ship a deferred stylesheet').toBeTruthy();

      await page.setViewportSize(viewport);
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === entry) await new Promise((done) => setTimeout(done, ENTRY_DELAY_MS));
        if (url.pathname === stylesheetHref) await new Promise((done) => setTimeout(done, STYLESHEET_DELAY_MS));
        const pathname = url.pathname === '/pro' ? '/pro/index.html' : url.pathname;
        const path = resolve(repoRoot, 'public', pathname.replace(/^\//, ''));
        if (!existsSync(path)) return route.abort();
        return route.fulfill({ path });
      });

      await page.addInitScript(() => {
        window.__wmLcp = [];
        window.__wmMountedAt = null;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<PerformanceEntry & { size: number; element: Element | null }>) {
            window.__wmLcp?.push({
              time: Math.round(entry.startTime),
              size: entry.size,
              tag: entry.element?.tagName ?? null,
              inHero: Boolean(entry.element?.closest('main > section:first-child')),
              text: (entry.element?.textContent ?? '').trim().slice(0, 60),
            });
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new MutationObserver((mutations) => {
          if (window.__wmMountedAt !== null) return;
          if (mutations.some((m) => (m.target as Element).id === 'root' && m.removedNodes.length > 0)) {
            window.__wmMountedAt = Math.round(performance.now());
          }
        }).observe(document, { childList: true, subtree: true });
      });

      await page.goto(`${ORIGIN}/pro`, { waitUntil: 'commit' });
      const heading = page.locator('main > section:first-child h1');
      await heading.waitFor({ state: 'attached' });
      const firstPaint = await page.evaluate(() => {
        const h1 = document.querySelector('main > section:first-child h1');
        const opacities: string[] = [];
        for (let node = h1; node; node = node.parentElement) opacities.push(getComputedStyle(node).opacity);
        const rect = h1?.getBoundingClientRect();
        return {
          mounted: window.__wmMountedAt !== null,
          opacities,
          height: rect?.height ?? 0,
          top: rect?.top ?? -1,
          text: h1?.textContent ?? '',
        };
      });
      expect(firstPaint.mounted, 'the check must run on the static HTML, before React mounts').toBe(false);
      expect(firstPaint.opacities.every((value) => value === '1'), `static hero must paint visible, got opacities ${firstPaint.opacities}`).toBe(true);
      expect(firstPaint.height).toBeGreaterThan(0);
      expect(firstPaint.top).toBeLessThan(viewport.height);
      expect(firstPaint.text).toMatch(/World Monitor Pro/);

      await expect
        .poll(() => page.evaluate(() => window.__wmMountedAt), { message: 'React never mounted', timeout: 15_000 })
        .not.toBeNull();
      await expect(page.locator('main > section:first-child h1 .sr-only')).toHaveCount(0);
      await page.waitForTimeout(750);
      await page.evaluate(() => new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }));

      const { lcp, mountedAt } = await page.evaluate(() => ({ lcp: window.__wmLcp ?? [], mountedAt: window.__wmMountedAt! }));
      const detail = lcp.map((e) => `${e.time}ms size=${e.size} ${e.tag} hero=${e.inHero} "${e.text}"`).join('\n');
      expect(lcp.length, 'no LCP entry was recorded').toBeGreaterThan(0);
      expect(
        lcp.filter((e) => e.time >= mountedAt),
        `LCP entries after the React mount at ${mountedAt}ms:\n${detail}`,
      ).toEqual([]);
      const last = lcp.at(-1)!;
      expect({ tag: last.tag, inHero: last.inHero }, `final LCP candidate must be the hero heading:\n${detail}`)
        .toEqual({ tag: 'H1', inHero: true });
    });
  }
});
