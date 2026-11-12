import { mkdir, writeFile } from 'node:fs/promises';
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
  await page.locator('#overall-uptime h3').first().waitFor({ state: 'visible', timeout });
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

async function main() {
  const { chromium } = await import('@playwright/test');
  const directory = process.env.STATUS_PAGE_EVIDENCE_DIR || 'test-results/status-page';
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const response = await page.goto('https://status.worldmonitor.app/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response?.ok()) throw new Error(`Status page HTTP ${response?.status() ?? 'no response'}`);
    const figures = await checkStatusPage(page);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), figures }, null, 2));
  } finally {
    try {
      await writeFile(`${directory}/rendered.txt`, await page.locator('body').innerText());
      await page.screenshot({ path: `${directory}/status-page.png`, fullPage: true });
    } finally { await browser.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
