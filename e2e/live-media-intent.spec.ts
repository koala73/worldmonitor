import { expect, test, type Page } from '@playwright/test';
import { IDLE_PAUSE_MS } from '../src/config/idle';
import { ALL_PANELS } from '../src/config/panels';

const LIVE_MEDIA_REQUEST = /(?:youtube\.com\/embed|youtube\.com\/iframe_api|googlevideo\.com|\/api\/youtube-embed|\/videoplayback(?:[?#/]|$)|\.m3u8(?:[?#]|$))/i;
const LIVE_MEDIA_PANEL_IDS = new Set(['live-news', 'live-webcams']);
// `test:e2e:finance` runs this shared lifecycle suite with a finance build.
// Persist the same variant the bundle is serving; hard-coding "full" makes
// App's legitimate variant-transition migration replace the test's layout
// before its visibility assertions run.
const E2E_VARIANT = process.env.VITE_VARIANT === 'finance' ? 'finance' : 'full';

// This is an actual persisted dashboard layout, not a DOM stub: the suite
// deliberately exercises the two media panels without unrelated deferred
// dashboard panels overlaying an otherwise user-clickable control. A user can
// create this same layout through the panel settings screen.
const LIVE_MEDIA_ONLY_LAYOUT = Object.fromEntries(
  Object.entries(ALL_PANELS).map(([panelId, config]) => [
    panelId,
    { ...config, enabled: LIVE_MEDIA_PANEL_IDS.has(panelId) },
  ]),
);
const LIVE_MEDIA_VISIBILITY_LAYOUT = {
  ...LIVE_MEDIA_ONLY_LAYOUT,
  // This ordinary dashboard panel occupies the initial scroll frame in the
  // visibility tests. It lets those tests prove that neither media transport
  // begins while both media panels are truly below the fold.
  intel: { ...ALL_PANELS.intel, enabled: true },
};
const LIVE_MEDIA_ONLY_ORDER = ['live-news', 'live-webcams'];
const LIVE_MEDIA_VISIBILITY_ORDER = ['intel', ...LIVE_MEDIA_ONLY_ORDER];
const VISIBILITY_SPACER_ROW_SPANS = { intel: 4 };
const VISIBILITY_SPACER_COL_SPANS = { intel: 3 };
const SCROLL_AWAY_ROW_SPANS = { 'live-news': 4 };
const SCROLL_AWAY_COL_SPANS = { 'live-news': 3 };

async function installCleanLiveMediaPrefs(page: Page, webcamPrefs?: Record<string, unknown>): Promise<void> {
  await page.addInitScript(({ prefs, panelLayout, panelOrder, variant }) => {
    // addInitScript runs again for reloads inside a test. Keep the active
    // preference mutations (for example the always-on toggle) across reload.
    if (sessionStorage.getItem('__live_media_intent_layout_seeded__')) return;
    localStorage.clear();
    localStorage.setItem('worldmonitor-variant', variant);
    localStorage.setItem('worldmonitor-panel-layout-variant', variant);
    localStorage.setItem('worldmonitor-panels', JSON.stringify(panelLayout));
    localStorage.setItem('panel-order', JSON.stringify(panelOrder));
    // Keep the saved layout user-owned: otherwise the historical v2.5
    // migration intentionally clears a pre-existing order on first boot.
    localStorage.setItem('worldmonitor-layout-reset-v2.5', 'done');
    localStorage.setItem('worldmonitor-panel-order-v1.9', 'done');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem('wm-live-streams-always-on');
    localStorage.removeItem('worldmonitor-active-channel');
    if (prefs) {
      localStorage.setItem('worldmonitor-webcam-prefs', JSON.stringify(prefs));
    } else {
      localStorage.removeItem('worldmonitor-webcam-prefs');
    }
    sessionStorage.setItem('__live_media_intent_layout_seeded__', '1');
  }, {
    prefs: webcamPrefs ?? null,
    panelLayout: LIVE_MEDIA_ONLY_LAYOUT,
    panelOrder: LIVE_MEDIA_ONLY_ORDER,
    variant: E2E_VARIANT,
  });
}

async function installAlwaysOnLiveMediaPrefs(
  page: Page,
  webcamPrefs?: Record<string, unknown>,
  options: { includeVisibilitySpacer?: boolean } = {},
): Promise<void> {
  const includeVisibilitySpacer = options.includeVisibilitySpacer === true;
  await page.addInitScript(({ prefs, panelLayout, panelOrder, panelSpans, panelColSpans, variant }) => {
    if (sessionStorage.getItem('__live_media_intent_layout_seeded__')) return;
    localStorage.clear();
    localStorage.setItem('worldmonitor-variant', variant);
    localStorage.setItem('worldmonitor-panel-layout-variant', variant);
    localStorage.setItem('worldmonitor-panels', JSON.stringify(panelLayout));
    localStorage.setItem('panel-order', JSON.stringify(panelOrder));
    localStorage.setItem('worldmonitor-layout-reset-v2.5', 'done');
    localStorage.setItem('worldmonitor-panel-order-v1.9', 'done');
    if (panelSpans) localStorage.setItem('worldmonitor-panel-spans', JSON.stringify(panelSpans));
    if (panelColSpans) localStorage.setItem('worldmonitor-panel-col-spans', JSON.stringify(panelColSpans));
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.removeItem('worldmonitor-active-channel');
    if (prefs) {
      localStorage.setItem('worldmonitor-webcam-prefs', JSON.stringify(prefs));
    } else {
      localStorage.removeItem('worldmonitor-webcam-prefs');
    }
    sessionStorage.setItem('__live_media_intent_layout_seeded__', '1');
  }, {
    prefs: webcamPrefs ?? null,
    panelLayout: includeVisibilitySpacer ? LIVE_MEDIA_VISIBILITY_LAYOUT : LIVE_MEDIA_ONLY_LAYOUT,
    panelOrder: includeVisibilitySpacer ? LIVE_MEDIA_VISIBILITY_ORDER : LIVE_MEDIA_ONLY_ORDER,
    panelSpans: includeVisibilitySpacer ? VISIBILITY_SPACER_ROW_SPANS : null,
    panelColSpans: includeVisibilitySpacer ? VISIBILITY_SPACER_COL_SPANS : null,
    variant: E2E_VARIANT,
  });
}

async function installScrollAwayLiveMediaPrefs(page: Page): Promise<void> {
  await installCleanLiveMediaPrefs(page);
  await page.addInitScript(({ panelSpans, panelColSpans }) => {
    localStorage.setItem('worldmonitor-panel-spans', JSON.stringify(panelSpans));
    localStorage.setItem('worldmonitor-panel-col-spans', JSON.stringify(panelColSpans));
  }, { panelSpans: SCROLL_AWAY_ROW_SPANS, panelColSpans: SCROLL_AWAY_COL_SPANS });
}

async function liveNewsTransportCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    document.querySelectorAll(
      '.panel[data-panel="live-news"] iframe[src*="youtube"], .panel[data-panel="live-news"] iframe[src*="/api/youtube-embed"], .panel[data-panel="live-news"] video.live-news-native-video',
    ).length
  ));
}

async function webcamTransportCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    Array.from(document.querySelectorAll<HTMLIFrameElement>('.panel[data-panel="live-webcams"] .webcam-iframe'))
      .filter((iframe) => iframe.src && iframe.src !== 'about:blank')
      .length
  ));
}

async function waitForMountedPanel(page: Page, panelId: 'live-news' | 'live-webcams'): Promise<void> {
  // Panels outside the initial boot budget are represented by a shell until
  // their actual scroll-frame enters the observer margin. The locator helper
  // scrolls that frame (unlike window/document scrolling) and the following
  // assertion proves that product code replaced the shell with a real panel.
  // The one shell→panel replacement can occur while Playwright is stabilising
  // its first scroll target. Re-resolve exactly that expected replacement; do
  // not force a click or bypass visibility checks.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.locator(`.panel[data-panel="${panelId}"]`).scrollIntoViewIfNeeded();
      break;
    } catch (error) {
      const isExpectedReplacement = error instanceof Error && error.message.includes('not attached to the DOM');
      if (!isExpectedReplacement || attempt === 2) throw error;
    }
  }
  await page.waitForFunction((id) => {
    const current = document.querySelector<HTMLElement>(`.panel[data-panel="${id}"]`);
    return current !== null && current.dataset.deferredPanel !== 'true';
  }, panelId, { timeout: 60_000 });
  await bringPanelIntoDashboardViewport(page, panelId);
}

async function bringPanelIntoDashboardViewport(page: Page, panelId: 'live-news' | 'live-webcams'): Promise<void> {
  await page.evaluate((id) => {
    const panel = document.querySelector<HTMLElement>(`.panel[data-panel="${id}"]`);
    if (!panel) throw new Error(`Missing panel ${id}`);

    let scrollport: HTMLElement | null = panel.parentElement;
    while (scrollport) {
      const style = getComputedStyle(scrollport);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && scrollport.scrollHeight > scrollport.clientHeight) {
        break;
      }
      scrollport = scrollport.parentElement;
    }
    scrollport ??= document.querySelector<HTMLElement>('.main-content');
    if (!scrollport) throw new Error(`Missing dashboard scrollport for ${id}`);

    const panelRect = panel.getBoundingClientRect();
    const scrollportRect = scrollport.getBoundingClientRect();
    const targetTop = scrollport.scrollTop + panelRect.top - scrollportRect.top - 8;
    scrollport.scrollTo({ top: Math.max(0, targetTop) });
  }, panelId);

  await page.waitForFunction((id) => {
    const panel = document.querySelector<HTMLElement>(`.panel[data-panel="${id}"]`);
    if (!panel) return false;
    let scrollport: HTMLElement | null = panel.parentElement;
    while (scrollport) {
      const style = getComputedStyle(scrollport);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && scrollport.scrollHeight > scrollport.clientHeight) break;
      scrollport = scrollport.parentElement;
    }
    scrollport ??= document.querySelector<HTMLElement>('.main-content');
    if (!scrollport) return false;
    const panelRect = panel.getBoundingClientRect();
    const scrollportRect = scrollport.getBoundingClientRect();
    return panelRect.bottom > scrollportRect.top && panelRect.top < scrollportRect.bottom;
  }, panelId, { timeout: 10_000 });
}

async function disablePanelViaStoredSettings(page: Page, panelId: string): Promise<void> {
  await setPanelEnabledViaStoredSettings(page, panelId, false);
}

async function setPanelEnabledViaStoredSettings(page: Page, panelId: string, enabled: boolean): Promise<void> {
  await page.evaluate(({ targetPanelId, enabled }) => {
    const key = 'worldmonitor-panels';
    const oldValue = localStorage.getItem(key);
    const panels = oldValue
      ? JSON.parse(oldValue) as Record<string, { enabled?: boolean; name?: string; priority?: number }>
      : {};
    if (!oldValue) {
      document.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((panel, index) => {
        const id = panel.dataset.panel;
        if (!id || panels[id]) return;
        const title = panel.querySelector('.panel-title')?.textContent?.trim() || id;
        panels[id] = { name: title, enabled: !panel.classList.contains('hidden'), priority: index + 1 };
      });
    }
    if (!panels[targetPanelId]) throw new Error(`Panel ${targetPanelId} is not in stored settings`);
    panels[targetPanelId] = { ...panels[targetPanelId], enabled };
    const newValue = JSON.stringify(panels);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      storageArea: localStorage,
      url: window.location.href,
    }));
  }, { targetPanelId: panelId, enabled });
}

test.describe('live media intent gating', () => {
  test('keeps live media idle until click, then one click lights up the whole wall + Live News', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (LIVE_MEDIA_REQUEST.test(request.url())) mediaRequests.push(request.url());
    });

    await page.goto('/dashboard?liveMediaIntent=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');

    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForMountedPanel(page, 'live-news');
    await waitForMountedPanel(page, 'live-webcams');
    await expect(webcams.locator('.webcam-preview-tile').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    expect(await liveNewsTransportCount(page)).toBe(0);
    expect(await webcamTransportCount(page)).toBe(0);
    expect(mediaRequests, `live media request(s) before intent: ${mediaRequests.join('\n')}`).toEqual([]);

    // A single Play click (here, one webcam tile) cascades to the entire webcam wall AND Live News.
    await webcams.locator('.webcam-preview-tile').first().getByRole('button', { name: /^play$/i }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(4);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('fits the natural webcam wall in a short desktop viewport and resizes from its two-row baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1296, height: 607 });
    await installCleanLiveMediaPrefs(page, {
      regionFilter: 'europe',
      viewMode: 'grid',
      activeFeedId: 'kyiv',
    });

    await page.goto('/dashboard?liveWebcamLayout=1', { waitUntil: 'domcontentloaded' });
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    // The dashboard uses an internal scroll frame. Wait for the real panel
    // instead of holding a locator across the intentional shell→panel swap.
    await waitForMountedPanel(page, 'live-webcams');
    await expect(webcams.locator('.webcam-cell')).toHaveCount(4, { timeout: 60_000 });

    const layout = await webcams.evaluate((panel) => {
      const panelRect = panel.getBoundingClientRect();
      const grid = panel.querySelector('.webcam-grid');
      const cells = Array.from(panel.querySelectorAll<HTMLElement>('.webcam-cell')).map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      return {
        viewportHeight: window.innerHeight,
        panelBottom: panelRect.bottom,
        panelHeight: panelRect.height,
        scrollportBottom: panel.closest('.main-content')?.getBoundingClientRect().bottom ?? window.innerHeight,
        gridHeight: grid?.getBoundingClientRect().height ?? 0,
        cells,
      };
    });

    expect(layout.panelHeight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.gridHeight, JSON.stringify(layout)).toBeGreaterThan(0);
    expect(layout.cells.every((cell) => cell.height > 0), JSON.stringify(layout)).toBe(true);
    expect(layout.cells[3]?.bottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.panelBottom + 2);
    // The dashboard footer is intentionally a fixed overlay. The usable panel
    // scrollport is therefore the exact visual bound, not window.innerHeight.
    expect(layout.cells[3]?.bottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.scrollportBottom + 1);

    const handle = webcams.locator('.panel-resize-handle');
    await handle.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const box = await handle.boundingBox();
    expect(box, 'webcam resize handle should be reachable after fitting the panel').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 100);
    await page.mouse.up();

    await expect(webcams).toHaveClass(/span-3/);
    await expect(webcams).toHaveClass(/resized/);
    const resizedHeight = await webcams.evaluate((panel) => panel.getBoundingClientRect().height);
    expect(resizedHeight, `natural=${layout.panelHeight}, resized=${resizedHeight}`).toBeGreaterThan(layout.panelHeight + 50);
  });

  test('the play-all cascade does not start media in a collapsed live panel', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaCollapsedCascade=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForMountedPanel(page, 'live-news');

    // Collapse Live News (content hidden, but the panel is NOT disabled).
    await liveNews.locator('.panel-collapse-btn').click();
    await expect(liveNews).toHaveClass(/panel-collapsed/);

    // Fire the cascade from the webcams panel.
    await waitForMountedPanel(page, 'live-webcams');
    await expect(webcams.locator('.webcam-preview-tile').first()).toBeVisible({ timeout: 60_000 });
    await webcams.locator('.webcam-preview-tile').first().getByRole('button', { name: /^play$/i }).click();

    // Webcams play, but the collapsed Live News must NOT create a hidden transport.
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(2500);
    expect(await liveNewsTransportCount(page)).toBe(0);

    // Expanding then explicitly playing still works.
    await liveNews.locator('.panel-collapse-btn').click();
    await expect(liveNews).not.toHaveClass(/panel-collapsed/);
    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('renders stored single webcam mode as a preview before play intent', async ({ page }) => {
    await installCleanLiveMediaPrefs(page, {
      regionFilter: 'all',
      viewMode: 'single',
      activeFeedId: 'jerusalem',
    });
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (LIVE_MEDIA_REQUEST.test(request.url())) mediaRequests.push(request.url());
    });

    await page.goto('/dashboard?liveMediaSinglePreview=1', { waitUntil: 'domcontentloaded' });
    const webcams = page.locator('.panel[data-panel="live-webcams"]');

    await waitForMountedPanel(page, 'live-webcams');
    await expect(webcams.locator('.webcam-single .webcam-preview-tile')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    expect(await webcamTransportCount(page)).toBe(0);
    expect(mediaRequests, `live media request(s) before single-mode intent: ${mediaRequests.join('\n')}`).toEqual([]);

    await webcams.locator('.webcam-single .webcam-preview-tile').getByRole('button', { name: /^play$/i }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('tears down live news media on hidden tab, idle cleanup, and panel close', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaTeardown=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForMountedPanel(page, 'live-news');

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.evaluate((idlePauseMs) => {
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
        originalSetTimeout(handler, timeout === idlePauseMs ? 120 : timeout, ...args)
      )) as typeof window.setTimeout;
    }, IDLE_PAUSE_MS);
    await page.mouse.move(20, 20);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await liveNews.locator('.panel-close-btn').dispatchEvent('click');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
  });

  test('tears down webcam media on scroll-away', async ({ page }) => {
    await installScrollAwayLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaScrollAway=1', { waitUntil: 'domcontentloaded' });
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await waitForMountedPanel(page, 'live-webcams');
    await expect(webcams.locator('.webcam-preview-tile').first()).toBeVisible({ timeout: 60_000 });

    // One click starts the whole wall (cascade); count is the grid size, not 1.
    await webcams.locator('.webcam-preview-tile').first().getByRole('button', { name: /^play$/i }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 240 });
    // The dashboard scrolls within .main-content, not the document. Exercise
    // the same scrollport a user moves so the webcam visibility observer gets
    // a genuine scroll-away transition.
    await page.locator('.main-content').evaluate((scrollport) => scrollport.scrollTo({ top: 0 }));
    await expect.poll(() => webcamTransportCount(page), { timeout: 10_000 }).toBe(0);
  });

  test('tears down live media when panels are disabled through stored settings', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaDisableSettings=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForMountedPanel(page, 'live-news');

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);

    // The Live News play click already cascaded to the webcam wall, so it's live once scrolled in.
    await waitForMountedPanel(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await disablePanelViaStoredSettings(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(webcams).toHaveClass(/hidden/);
  });

  test('always-on mode waits for visibility, then allows both live panels to start', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await installAlwaysOnLiveMediaPrefs(page, undefined, { includeVisibilitySpacer: true });
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (LIVE_MEDIA_REQUEST.test(request.url())) mediaRequests.push(request.url());
    });

    await page.goto('/dashboard?liveMediaAlwaysOnVisibility=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await expect(liveNews).toBeAttached({ timeout: 60_000 });
    await expect(webcams).toBeAttached({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    expect(await liveNewsTransportCount(page)).toBe(0);
    expect(await webcamTransportCount(page)).toBe(0);
    expect(mediaRequests, `live media request(s) before visibility: ${mediaRequests.join('\n')}`).toEqual([]);

    await waitForMountedPanel(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    // The webcam wall must not start merely because a different media panel is
    // visible. Bringing its own panel into the dashboard scrollport is the
    // user-equivalent permission boundary for its always-on playback.
    await waitForMountedPanel(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => webcamTransportCount(page), { timeout: 10_000 }).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  });

  test('turning always-on off keeps already-playing feeds running', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await installAlwaysOnLiveMediaPrefs(page, undefined, { includeVisibilitySpacer: true });

    await page.goto('/dashboard?liveMediaAlwaysOnToggleOff=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeAttached({ timeout: 60_000 });

    await waitForMountedPanel(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await waitForMountedPanel(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    await page.evaluate(() => {
      localStorage.setItem('wm-live-streams-always-on', 'false');
      window.dispatchEvent(new CustomEvent('wm-live-streams-settings-changed', {
        detail: { alwaysOn: false },
      }));
    });
    // Leaving always-on must NOT collapse the wall — feeds already playing stay (eco-idle pauses later).
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(1);
    expect(await webcamTransportCount(page)).toBeGreaterThanOrEqual(1);
  });

  test('always-on live news restarts after disable and re-enable through stored settings', async ({ page }) => {
    await installAlwaysOnLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaAlwaysOnPanelReenable=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForMountedPanel(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);

    await setPanelEnabledViaStoredSettings(page, 'live-news', true);
    await expect(liveNews).not.toHaveClass(/hidden/);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('always-on single webcam feed switch replaces the active stream', async ({ page }) => {
    await installAlwaysOnLiveMediaPrefs(page, {
      regionFilter: 'all',
      viewMode: 'single',
      activeFeedId: 'jerusalem',
    });

    await page.goto('/dashboard?liveMediaAlwaysOnSingleSwitch=1', { waitUntil: 'domcontentloaded' });
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await waitForMountedPanel(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect(webcams.locator('.webcam-iframe[title="Jerusalem live webcam"]')).toBeVisible();

    await webcams.getByRole('button', { name: 'Kyiv' }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect(webcams.locator('.webcam-iframe[title="Kyiv live webcam"]')).toBeVisible();
  });
});
