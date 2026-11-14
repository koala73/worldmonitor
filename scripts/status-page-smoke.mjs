import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const WINDOWS = ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days'];
const DATA_ERROR = 'There was an error while fetching the data';

export function validateUptime(entries) {
  const result = {};
  for (const label of WINDOWS) {
    const matches = entries.filter((entry) => entry.label === label);
    const value = matches[0]?.value;
    if (matches.length !== 1 || !/^\d+(?:\.\d+)?%$/.test(value ?? '') || Number.parseFloat(value) > 100) {
      throw new Error(`Missing or invalid uptime for ${label}: ${value ?? 'absent'}`);
    }
    result[label] = value;
  }
  return result;
}

export async function checkStatusPage(page, { timeout = 30_000 } = {}) {
  await page.waitForFunction(({ labels, dataError }) => {
    if (document.body.innerText.includes(dataError)) return true;
    const nodes = [...document.querySelectorAll('#overall-uptime > div')];
    return labels.every((label) => nodes.some((node) =>
      node.querySelector('div')?.textContent?.trim() === label && node.querySelector('h3')?.textContent?.trim()));
  }, { labels: WINDOWS, dataError: DATA_ERROR }, { timeout });
  const entries = await page.locator('#overall-uptime > div').evaluateAll((nodes) => nodes.map((node) => ({
    label: node.querySelector('div')?.textContent?.trim(),
    value: node.querySelector('h3')?.textContent?.trim(),
  })));
  if ((await page.locator('body').innerText()).includes(DATA_ERROR)) throw new Error(DATA_ERROR);
  const figures = validateUptime(entries);
  for (const label of WINDOWS) {
    const window = page.locator('#overall-uptime > div').filter({ hasText: label });
    if (!(await window.locator('h3').isVisible()) || !(await window.getByText(label, { exact: true }).isVisible())) {
      throw new Error(`Uptime window is not visible: ${label}`);
    }
  }
  return figures;
}

function diagnosticText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch { return '[invalid URL]'; }
  }).slice(0, 2000);
}

export async function monitorStatusPage(browser, {
  url = 'https://status.worldmonitor.app/',
  directory = 'test-results/status-page',
  timeout = 30_000,
  retryDelayMs = 5_000,
} = {}) {
  await mkdir(directory, { recursive: true });
  const report = { outcome: 'failed', attempts: [] };
  for (let number = 1; number <= 2; number++) {
    const started = Date.now();
    const attempt = { number, checkedAt: new Date().toISOString(), outcome: 'failed', events: [], pendingRequests: [], evidenceErrors: [] };
    report.attempts.push(attempt);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pending = new Map();
    let recording = true;
    const record = (event) => {
      if (recording && attempt.events.length < 100) attempt.events.push({ elapsedMs: Date.now() - started, ...event });
    };
    page.on('request', (request) => {
      if (['document', 'script', 'xhr', 'fetch'].includes(request.resourceType())) {
        pending.set(request, diagnosticText(request.url()));
      }
    });
    page.on('response', (response) => {
      if (pending.has(response.request())) record({ type: 'response', url: diagnosticText(response.url()), status: response.status() });
    });
    page.on('requestfinished', (request) => pending.delete(request));
    page.on('requestfailed', (request) => {
      record({ type: 'requestfailed', url: diagnosticText(request.url()), error: diagnosticText(request.failure()?.errorText) });
      pending.delete(request);
    });
    page.on('pageerror', (error) => record({ type: 'pageerror', error: diagnosticText(error.message) }));
    page.on('console', (message) => {
      if (message.type() === 'error') record({ type: 'console', error: diagnosticText(message.text()) });
    });
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response?.ok()) throw new Error(`Status page HTTP ${response?.status() ?? 'no response'}`);
      attempt.figures = await checkStatusPage(page, { timeout });
      attempt.outcome = 'passed';
      report.outcome = number === 1 ? 'healthy' : 'recovered';
    } catch (error) {
      attempt.error = diagnosticText(error.message);
    } finally {
      attempt.pendingRequests = [...pending.values()].slice(0, 100);
      const captures = await Promise.allSettled([
        page.locator('body').innerText({ timeout: 5_000 }).then((text) => writeFile(`${directory}/attempt-${number}.txt`, text)),
        page.screenshot({ path: `${directory}/attempt-${number}.png`, fullPage: true, timeout: 5_000 }),
      ]);
      attempt.evidenceErrors = captures.filter((result) => result.status === 'rejected').map((result) => diagnosticText(result.reason.message));
      attempt.durationMs = Date.now() - started;
      recording = false;
      await context.close();
      await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
    }
    if (attempt.outcome === 'passed') break;
    if (number === 1) await delay(retryDelayMs);
  }
  return report;
}

async function main() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const report = await monitorStatusPage(browser, { directory: process.env.STATUS_PAGE_EVIDENCE_DIR });
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome === 'recovered') console.warn('::warning::Status page recovered on the second attempt. Inspect first-attempt evidence.');
    if (report.outcome === 'failed') process.exitCode = 1;
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `Status page result: **${report.outcome}** after ${report.attempts.length} attempt(s). See status-page-evidence/report.json and the per-attempt screenshots and text.\n`);
    }
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
