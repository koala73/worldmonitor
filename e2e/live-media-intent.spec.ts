import { expect, test, type Page } from '@playwright/test';
import { IDLE_PAUSE_MS } from '../src/config/idle';

const LIVE_MEDIA_REQUEST = /(?:youtube\.com\/embed|youtube\.com\/iframe_api|googlevideo\.com|\/api\/youtube-embed|\/videoplayback(?:[?#/]|$)|\.m3u8(?:[?#]|$))/i;

async function installCleanLiveMediaPrefs(page: Page, webcamPrefs?: Record<string, unknown>): Promise<void> {
  await page.addInitScript((prefs) => {
    localStorage.removeItem('wm-live-streams-always-on');
    localStorage.removeItem('worldmonitor-active-channel');
    if (prefs) {
      localStorage.setItem('worldmonitor-webcam-prefs', JSON.stringify(prefs));
    } else {
      localStorage.removeItem('worldmonitor-webcam-prefs');
    }
  }, webcamPrefs ?? null);
}

async function installAlwaysOnLiveMediaPrefs(page: Page, webcamPrefs?: Record<string, unknown>): Promise<void> {
  await page.addInitScript((prefs) => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.removeItem('worldmonitor-active-channel');
    if (prefs) {
      localStorage.setItem('worldmonitor-webcam-prefs', JSON.stringify(prefs));
    } else {
      localStorage.removeItem('worldmonitor-webcam-prefs');
    }
  }, webcamPrefs ?? null);
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
    await webcams.scrollIntoViewIfNeeded();
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

  test('the play-all cascade does not start media in a collapsed live panel', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaCollapsedCascade=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });

    // Collapse Live News (content hidden, but the panel is NOT disabled).
    await liveNews.locator('.panel-collapse-btn').click();
    await expect(liveNews).toHaveClass(/panel-collapsed/);

    // Fire the cascade from the webcams panel.
    await webcams.scrollIntoViewIfNeeded();
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

    await webcams.scrollIntoViewIfNeeded();
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
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaScrollAway=1', { waitUntil: 'domcontentloaded' });
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await webcams.scrollIntoViewIfNeeded();
    await expect(webcams.locator('.webcam-preview-tile').first()).toBeVisible({ timeout: 60_000 });

    // One click starts the whole wall (cascade); count is the grid size, not 1.
    await webcams.locator('.webcam-preview-tile').first().getByRole('button', { name: /^play$/i }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 240 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => webcamTransportCount(page), { timeout: 10_000 }).toBe(0);
  });

  test('tears down live media when panels are disabled through stored settings', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaDisableSettings=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const webcams = page.locator('.panel[data-panel="live-webcams"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);

    // The Live News play click already cascaded to the webcam wall, so it's live once scrolled in.
    await webcams.scrollIntoViewIfNeeded();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await disablePanelViaStoredSettings(page, 'live-webcams');
    await expect.poll(() => webcamTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(webcams).toHaveClass(/hidden/);
  });

  test('always-on mode waits for visibility, then allows both live panels to start', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await installAlwaysOnLiveMediaPrefs(page);
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

    await liveNews.scrollIntoViewIfNeeded();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    // Always-on grid auto-starts the whole wall, so more than one webcam can be live.
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
    await installAlwaysOnLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaAlwaysOnToggleOff=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeAttached({ timeout: 60_000 });

    await liveNews.scrollIntoViewIfNeeded();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
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
    await webcams.scrollIntoViewIfNeeded();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect(webcams.locator('.webcam-iframe[title="Jerusalem live webcam"]')).toBeVisible();

    await webcams.getByRole('button', { name: 'Kyiv' }).click();
    await expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect(webcams.locator('.webcam-iframe[title="Kyiv live webcam"]')).toBeVisible();
  });
});
