import type { Page } from '@playwright/test';

/**
 * Act as a server that accepts the seeded wm-pro-key / wm-widget-key.
 *
 * A tester key grants Pro or widget access only after POST /api/wm-session
 * accepts it, and a reload restores that from GET /api/wm-session. Specs that
 * seed a key in localStorage to reach a Pro state call this so the key is
 * honoured. Register it after any catch-all `**\/api/**` route: Playwright
 * runs the most recently registered matching route first.
 */
export async function acceptTesterKeySession(
  page: Page,
  sessions: { widget: boolean; pro: boolean } = { widget: true, pro: true },
): Promise<void> {
  await page.route('**/api/wm-session', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: sessions, headers: { 'Cache-Control': 'no-store' } })
    : route.fulfill({ json: { exp: Date.now() + 3_600_000 } }));
}
