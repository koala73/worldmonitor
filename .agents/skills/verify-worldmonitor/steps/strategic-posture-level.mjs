// Strategic Posture shows the level /api published, not a browser recalculation.
// Captures the panel, then reads each theater's badge and compares it with the
// get-theater-posture response the page itself received.
import { seedProfile, waitForBoot } from './_profile.mjs';

export default async function ({ page, base, shot, log, expectVisible }) {
  const published = new Map();
  page.on('response', async (response) => {
    const url = response.url();
    if (!/get-theater-posture|bootstrap/.test(url) || response.status() !== 200) return;
    try {
      const body = await response.json();
      const theaters = body?.theaters ?? body?.data?.theaterPosture?.theaters ?? [];
      for (const theater of theaters) published.set(theater.theater, theater.postureLevel);
    } catch { /* not JSON */ }
  });

  // This worktree has no Redis, so the local API is empty. Serve the dashboard's
  // public bootstrap from the live API so the panel renders today's real posture
  // and CII scores through the branch's own client code.
  await page.route('**/api/bootstrap**', async (route) => {
    const url = new URL(route.request().url());
    url.protocol = 'https:'; url.host = 'api.worldmonitor.app'; url.port = '';
    url.searchParams.set('public', '1');
    const response = await fetch(url, { headers: { Origin: 'https://www.worldmonitor.app', 'User-Agent': 'worldmonitor-verify/1.0' }, signal: AbortSignal.timeout(30_000) });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });

  await seedProfile(page);
  const width = Number(process.env.WM_VERIFY_WIDTH || 1440);
  await page.setViewportSize({ width, height: width < 600 ? 900 : 1000 });
  // WM_VERIFY_TARGET=https://www.worldmonitor.app captures production (the "before").
  await page.goto(`${process.env.WM_VERIFY_TARGET || base}/dashboard`, { waitUntil: 'domcontentloaded' });
  // Production builds carry no VITE_E2E readiness markers; there the panel wait below is the gate.
  if (!process.env.WM_VERIFY_TARGET) await waitForBoot(page, { data: true });

  const panel = '#panelsGrid .panel[data-panel="strategic-posture"]';
  await expectVisible(panel);
  await page.locator(panel).scrollIntoViewIfNeeded();
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .posture-theater`).length >= 9, panel, { timeout: 60_000 });
  // Give CII scores time to hydrate so instability chips can appear.
  await page.waitForTimeout(4000);
  await shot('strategic-posture-panel', { locator: page.locator(panel) });

  const rows = await page.$$eval(`${panel} .posture-theater`, (els) => els.map((el) => ({
    name: el.querySelector('.posture-name')?.textContent?.trim(),
    badge: el.querySelector('.posture-badge')?.className.replace('posture-badge', '').trim(),
    chips: [...el.querySelectorAll('.posture-chip, .posture-stat')].map((c) => `${c.className.replace(/posture-(chip|stat)/, '').trim()}:${c.textContent.trim()}`),
    instabilityTitle: el.querySelector('.posture-chip.instability')?.getAttribute('title') ?? null,
  })));
  log('rows', JSON.stringify(rows));
  log('published', JSON.stringify([...published]));
  log('panel critical badges', rows.filter((r) => r.badge === 'posture-critical').length);
}
