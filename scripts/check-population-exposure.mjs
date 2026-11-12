#!/usr/bin/env node
// Read-only production smoke check. Does not bypass authentication or entitlement.
import { chromium } from '@playwright/test';
import { seedProfile } from '../.agents/skills/verify-worldmonitor/steps/_profile.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const base = process.env.WM_CHECK_BASE || 'https://www.worldmonitor.app';
const outputRoot = process.env.WM_CHECK_OUTPUT || '/tmp/worldmonitor-exposure-check';
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'run-'));
const startedAt = new Date().toISOString();
const started = Date.now();
const result = { startedAt, base, output, viewport: '1440x900' };
let browser;
let page;
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await seedProfile(page, { localStorage: {
    'worldmonitor-panels': JSON.stringify({ 'population-exposure': { name: 'Population Exposure', enabled: true, priority: 1 } }),
    'worldmonitor-panel-layout-variant': 'full',
  } });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  const panel = page.locator('[data-panel="population-exposure"]');
  await panel.waitFor({ state: 'attached', timeout: 60_000 });
  await panel.scrollIntoViewIfNeeded();
  result.scrolledAfterMs = Date.now() - started;
  result.panelTextAtScroll = await panel.innerText();
  await panel.locator('.popexp-card').first().waitFor({ state: 'attached', timeout: 120_000 });
  // Hydration can move the panel after the initial scroll. Re-align it so
  // content-visibility and viewport lazy rendering activate the final content.
  await panel.scrollIntoViewIfNeeded();
  await panel.locator('.popexp-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  await panel.locator('.popexp-coverage').waitFor({ state: 'visible', timeout: 30_000 });
  result.rows = await panel.locator('.popexp-card').allTextContents();
  result.footer = await panel.locator('.popexp-coverage').innerText();
  result.readyAfterMs = Date.now() - started;
  await page.screenshot({ path: `${output}/rows.png` });
  await panel.locator('.popexp-coverage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/footer.png` });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = String(error);
  result.elapsedMs = Date.now() - started;
  result.visibility = page ? await page.locator('[data-panel="population-exposure"]').evaluate(el => {
    const chain = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      chain.push({
        tag: node.tagName, id: node.id, className: node.className,
        display: style.display, visibility: style.visibility,
        contentVisibility: style.contentVisibility,
      });
    }
    return chain;
  }).catch(() => []) : [];
  result.panelText = page ? await page.locator('[data-panel="population-exposure"]').innerText().catch(() => 'not mounted') : 'not mounted';
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  try {
    if (page) await page.screenshot({ path: `${output}/exposure.png` }).catch(error => {
      result.screenshotError = String(error);
    });
    console.log(JSON.stringify(result, null, 2));
    await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
  }
}
