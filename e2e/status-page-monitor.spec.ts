import { test, expect } from '@playwright/test';
import { createServer, type RequestListener } from 'node:http';
import { readFile } from 'node:fs/promises';
import { checkStatusPage, monitorStatusPage } from '../scripts/status-page-smoke.mjs';

const markup = `<section id="overall-uptime">${['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days'].map((label) => `<div><h3>99.123%</h3><div>${label}</div></div>`).join('')}</section>`;

test('status probe waits for asynchronously rendered uptime', async ({ page }) => {
  await page.setContent('<main></main>');
  await page.locator('main').evaluate((node, html) => {
    setTimeout(() => { node.innerHTML = html; }, 100);
  }, markup);
  expect((await checkStatusPage(page))['Last 90 days']).toBe('99.123%');
});

test('status probe waits for all four uptime windows', async ({ page }) => {
  await page.setContent(markup.replaceAll('99.123%', ''));
  await page.locator('h3').first().evaluate((node) => { node.textContent = '99.123%'; });
  await page.evaluate(() => {
    setTimeout(() => document.querySelectorAll('h3').forEach((node) => { node.textContent = '99.123%'; }), 200);
  });
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

async function withStatusServer(handler: RequestListener, check: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  try {
    await check(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('healthy status needs one attempt and saves evidence', async ({ browser }, testInfo) => {
  const directory = testInfo.outputPath('probe');
  await withStatusServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(markup);
  }, async (url) => {
    const report = await monitorStatusPage(browser, { url, directory, timeout: 500, retryDelayMs: 0 });
    expect(report.outcome).toBe('healthy');
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.figures?.['Last 90 days']).toBe('99.123%');
    expect(JSON.parse(await readFile(`${directory}/report.json`, 'utf8'))).toEqual(report);
    expect(await readFile(`${directory}/attempt-1.png`)).not.toHaveLength(0);
  });
});

test('provider failure recovers once with fresh storage and preserves first failure', async ({ browser }, testInfo) => {
  let visits = 0;
  const directory = testInfo.outputPath('probe');
  const cookies: Array<string | undefined> = [];
  await withStatusServer((request, response) => {
    if (request.url?.startsWith('/api/stats')) {
      response.writeHead(visits === 1 ? 503 : 200, { 'Content-Type': 'text/html' });
      response.end(markup);
      return;
    }
    visits++;
    cookies.push(request.headers.cookie);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'visited=true' });
    response.end(`<main>Loading...</main><script>
      if (localStorage.getItem('visited')) throw new Error('stale context');
      localStorage.setItem('visited', 'true');
      fetch('/api/stats?token=private').then(async response => {
        if (!response.ok) throw new Error('provider unavailable');
        document.querySelector('main').innerHTML = await response.text();
      });
    </script>`);
  }, async (url) => {
    const report = await monitorStatusPage(browser, { url, directory, timeout: 500, retryDelayMs: 0 });
    expect(report.outcome).toBe('recovered');
    expect(report.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'passed']);
    expect(cookies).toEqual([undefined, undefined]);
    expect(report.attempts[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response', status: 503, url: `${url}api/stats` }),
      expect.objectContaining({ type: 'pageerror', error: 'provider unavailable' }),
    ]));
    expect(await readFile(`${directory}/attempt-1.txt`, 'utf8')).toBe('Loading...');
    expect(await readFile(`${directory}/attempt-2.txt`, 'utf8')).toContain('99.123%');
    expect(await readFile(`${directory}/report.json`, 'utf8')).not.toContain('token=private');
  });
});

test('persistent provider errors fail after two attempts even with cached figures', async ({ browser }, testInfo) => {
  let visits = 0;
  await withStatusServer((_request, response) => {
    visits++;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`${markup}<p>There was an error while fetching the data.</p>`);
  }, async (url) => {
    const report = await monitorStatusPage(browser, { url, directory: testInfo.outputPath('probe'), timeout: 500, retryDelayMs: 0 });
    expect(report.outcome).toBe('failed');
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts.every((attempt) => attempt.error?.includes('fetching the data'))).toBe(true);
    expect(visits).toBe(2);
  });
});

test('empty shell records stalled and failed requests on both attempts', async ({ browser }, testInfo) => {
  await withStatusServer((request, response) => {
    if (request.url?.startsWith('/api/stalled')) return;
    if (request.url?.startsWith('/broken.js')) { response.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<main>Loading...</main><script>fetch("/api/stalled?token=private");</script><script src="/broken.js?token=private"></script>');
  }, async (url) => {
    const report = await monitorStatusPage(browser, { url, directory: testInfo.outputPath('probe'), timeout: 500, retryDelayMs: 0 });
    expect(report.outcome).toBe('failed');
    expect(report.attempts).toHaveLength(2);
    for (const attempt of report.attempts) {
      expect(attempt.pendingRequests).toContain(`${url}api/stalled`);
      expect(attempt.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'requestfailed', url: `${url}broken.js` })]));
      expect(attempt.evidenceErrors).toEqual([]);
    }
  });
});
