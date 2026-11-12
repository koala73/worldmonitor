import { test, expect } from '@playwright/test';
import { checkStatusPage } from '../scripts/status-page-smoke.mjs';

const markup = `<section id="overall-uptime">${['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days'].map((label) => `<div><h3>99.123%</h3><div>${label}</div></div>`).join('')}</section>`;

test('status probe waits for asynchronously rendered uptime', async ({ page }) => {
  await page.setContent(`<main></main><script>setTimeout(() => document.querySelector('main').innerHTML = ${JSON.stringify(markup)}, 100)</script>`);
  expect((await checkStatusPage(page))['Last 90 days']).toBe('99.123%');
});

test('status probe rejects the provider error even with cached figures', async ({ page }) => {
  await page.setContent(`${markup}<p>There was an error while fetching the data.</p>`);
  await expect(checkStatusPage(page)).rejects.toThrow('fetching the data');
});

test('status probe rejects a successful HTTP response with an empty shell', async ({ page }) => {
  await page.route('https://status.example/', (route) => route.fulfill({ status: 200, body: '<main>Loading</main>', contentType: 'text/html' }));
  await page.goto('https://status.example/');
  await expect(checkStatusPage(page, { timeout: 200 })).rejects.toThrow();
});

for (const width of [1280, 390]) {
  test(`security page links status and disclosure at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // Vite serves public directory indexes by filename; Vercel resolves /security/.
    await page.goto('/security/index.html');
    await expect(page.getByRole('heading', { name: 'Security and service status', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'World Monitor status page', exact: true })).toHaveAttribute('href', 'https://status.worldmonitor.app/');
    await expect(page.getByRole('link', { name: 'GitHub private vulnerability reporting', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`security-${width}.png`), fullPage: true });
  });
}

test('status probe rejects hidden uptime windows', async ({ page }) => {
  await page.setContent(markup.replace('<h3>99.123%</h3><div>Last 90 days', '<h3 hidden>99.123%</h3><div>Last 90 days'));
  await expect(checkStatusPage(page)).rejects.toThrow('Last 90 days');
});
