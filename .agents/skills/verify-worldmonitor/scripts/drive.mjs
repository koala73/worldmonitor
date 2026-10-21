#!/usr/bin/env node
/**
 * WorldMonitor verification driver.
 *
 *   node .agents/skills/verify-worldmonitor/scripts/drive.mjs <step.mjs> [--name <label>]
 *
 * Opens a Chromium page against the dev instance recorded in
 * .claude/verify-evidence/instance.json, hands it to <step.mjs>, and writes
 * every artifact of the run into .claude/verify-evidence/<timestamp>-<label>/.
 *
 * A step module default-exports an async function:
 *
 *   export default async function ({ page, base, shot, log, expectVisible }) { ... }
 *
 * Exit 0 = the step returned. Exit 1 = it threw (a failure screenshot and the
 * console/network transcript are still written).
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// .agents/skills/verify-worldmonitor -> repo root is three levels up. Fall back
// to the cwd when the skill is reached through a symlink or copied elsewhere.
const SKILL_REPO_ROOT = resolve(SKILL_DIR, '..', '..', '..');
const REPO_ROOT = existsSync(resolve(SKILL_REPO_ROOT, 'package.json')) ? SKILL_REPO_ROOT : process.cwd();
const EVIDENCE_ROOT = process.env.WM_VERIFY_EVIDENCE_ROOT
  ? resolve(process.env.WM_VERIFY_EVIDENCE_ROOT)
  : resolve(REPO_ROOT, '.claude', 'verify-evidence');
const INSTANCE_FILE = resolve(EVIDENCE_ROOT, 'instance.json');

const argv = process.argv.slice(2);
const stepArg = argv.find((a) => !a.startsWith('--'));
if (!stepArg) {
  console.error('usage: drive.mjs <step.mjs> [--name <label>]');
  process.exit(2);
}
const nameFlagIndex = argv.indexOf('--name');
const label = (nameFlagIndex >= 0 ? argv[nameFlagIndex + 1] : stepArg.replace(/^.*\//, '').replace(/\.mjs$/, ''))
  .replace(/[^a-zA-Z0-9._-]/g, '-');

let instance;
try {
  instance = JSON.parse(readFileSync(INSTANCE_FILE, 'utf8'));
} catch {
  console.error(`[drive] no running instance recorded at ${INSTANCE_FILE}.`);
  console.error('[drive] run `wm-verify.sh launch` first.');
  process.exit(2);
}
const base = instance.baseUrl;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const runDir = resolve(EVIDENCE_ROOT, `${stamp}-${label}`);
mkdirSync(runDir, { recursive: true });

const transcript = [];
const consoleErrors = [];
const consoleWarnings = [];
const failedRequests = [];
const log = (...parts) => {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  transcript.push(`[${new Date().toISOString()}] ${line}`);
  console.log(line);
};

const headed = process.env.WM_VERIFY_HEADED === '1';
// Renderer choice is a product decision, not a flag detail: MapContainer's
// hasWebGLSupport() deliberately REJECTS swiftshader/llvmpipe, so the
// software-GL args playwright.config.ts uses pin the dashboard to the SVG map.
// Default here is real GPU GL so drives see the deck.gl map users get; set
// WM_VERIFY_SOFTWARE_GL=1 to reproduce the repo's e2e conditions instead.
const softwareGl = process.env.WM_VERIFY_SOFTWARE_GL === '1';
const browser = await chromium.launch({
  headless: !headed,
  args: softwareGl
    ? ['--use-angle=swiftshader', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    : [],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  colorScheme: 'dark',
  locale: 'en-US',
  timezoneId: 'UTC',
});
const page = await context.newPage();

page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error') consoleErrors.push(msg.text().slice(0, 400));
  // Warnings are where this app announces a degraded path (renderer fallback,
  // blocked API base, quota). Capped so a chatty page cannot bloat the run.
  else if (type === 'warning' && consoleWarnings.length < 200) consoleWarnings.push(msg.text().slice(0, 400));
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 400)}`));
page.on('response', (res) => {
  const status = res.status();
  if (status >= 400) failedRequests.push({ status, url: res.url().slice(0, 240) });
});

let shotIndex = 0;
const shot = async (name, options = {}) => {
  shotIndex += 1;
  const file = resolve(runDir, `${String(shotIndex).padStart(2, '0')}-${name.replace(/[^a-zA-Z0-9._-]/g, '-')}.png`);
  const target = options.locator ?? page;
  await target.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: file,
    ...(options.locator ? {} : { fullPage: options.fullPage ?? false }),
  });
  log(`shot -> ${file}`);
  return file;
};

const expectVisible = async (selector, timeout = 60_000) => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout });
  log(`visible: ${selector}`);
  return locator;
};

const stepPath = isAbsolute(stepArg) ? stepArg : resolve(process.cwd(), stepArg);
const stepModule = await import(pathToFileURL(stepPath).href);
const step = stepModule.default;
if (typeof step !== 'function') {
  console.error(`[drive] ${stepPath} must default-export an async function.`);
  await browser.close();
  process.exit(2);
}

let outcome = 'passed';
let failure = null;
try {
  log(`base=${base} step=${stepPath}`);
  await step({ page, context, base, shot, log, expectVisible });
} catch (err) {
  outcome = 'failed';
  failure = String(err?.stack ?? err).slice(0, 4000);
  log(`FAILED: ${failure.split('\n')[0]}`);
  try {
    await shot('failure', { fullPage: true });
  } catch {
    /* the page may be gone; the transcript still records the failure */
  }
}

writeFileSync(resolve(runDir, 'transcript.txt'), `${transcript.join('\n')}\n`);
writeFileSync(resolve(runDir, 'console-errors.json'), `${JSON.stringify(consoleErrors, null, 2)}\n`);
writeFileSync(resolve(runDir, 'console-warnings.json'), `${JSON.stringify(consoleWarnings, null, 2)}\n`);
writeFileSync(resolve(runDir, 'failed-requests.json'), `${JSON.stringify(failedRequests, null, 2)}\n`);
writeFileSync(
  resolve(runDir, 'result.json'),
  `${JSON.stringify({ outcome, label, step: stepPath, base, instance, failure, consoleErrorCount: consoleErrors.length, consoleWarningCount: consoleWarnings.length, failedRequestCount: failedRequests.length }, null, 2)}\n`,
);

await context.close();
await browser.close();

console.log(`\n[drive] ${outcome} — evidence: ${runDir}`);
console.log(`[drive] console errors: ${consoleErrors.length}, warnings: ${consoleWarnings.length}, responses >=400: ${failedRequests.length}`);
process.exit(outcome === 'passed' ? 0 : 1);
