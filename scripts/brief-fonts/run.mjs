#!/usr/bin/env node
// Regenerate the brief magazine's self-hosted fonts. Run by hand: `npm run brief-fonts:subset`.
//
// 1. renders the sample briefs in fixtures.mjs and lays them out in Chromium at several widths,
//    recording which face (family, weight, style) draws each text run and on which page,
// 2. runs subset_brief_fonts.py (via `uv run`, which installs its pinned Python deps) to rewrite
//    public/assets/brief-fonts/, server/_shared/brief-fonts.generated.js and manifest.json.
//
// Needs Playwright's Chromium (`npx playwright install chromium`) and uv (https://docs.astral.sh/uv/).
// Flags: --skip-google-parity (offline; don't commit its output).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefFontFixtures } from './fixtures.mjs';
import { briefFontInputs } from './inputs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const usageFile = path.join(root, 'node_modules/.cache/brief-fonts/usage.json');
const args = new Set(process.argv.slice(2));
const FAMILIES = ['Playfair Display', 'Source Serif 4', 'IBM Plex Mono'];
const VIEWPORTS = [[1440, 900], [1920, 1080], [2560, 1440], [1024, 768], [393, 852]];

const { chromium } = createRequire(path.join(root, 'package.json'))('playwright');

// Runs in the page: every text run with the face that draws it.
function collectRuns(families) {
  const firstPage = document.querySelector('#deck .page');
  const runs = [];
  const add = (el, text, cs) => {
    const family = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (!families.includes(family)) return;
    const t = cs.textTransform === 'uppercase' ? text.toUpperCase() : cs.textTransform === 'lowercase' ? text.toLowerCase() : text;
    runs.push({
      family, weight: Number(cs.fontWeight), style: cs.fontStyle, text: t,
      onFirstPage: !!firstPage && firstPage.contains(el),
      variants: [cs.fontFeatureSettings, cs.fontVariationSettings, cs.fontVariantNumeric, cs.fontVariantCaps, cs.fontVariantLigatures, cs.fontVariantPosition, cs.fontVariantAlternates, cs.fontVariantEastAsian].join(' '),
      lang: el.closest('[lang]')?.getAttribute('lang') || '',
    });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName) || !n.data.trim()) continue;
    add(el, n.data, getComputedStyle(el));
  }
  for (const el of document.body.querySelectorAll('*')) {
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const m = /^"(.*)"$/s.exec(cs.content);
      if (m && m[1]) add(el, m[1], cs);
    }
    if (getComputedStyle(el).display === 'list-item') add(el, '•0123456789. ', getComputedStyle(el, '::marker'));
  }
  return runs;
}

const browser = await chromium.launch();
const faces = new Map();
const unexpected = new Set();
try {
  for (const { name, html } of briefFontFixtures()) {
    for (const [width, height] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.route('**/*', (route) => route.fulfill({ status: 404, body: '' }));
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      for (const run of await page.evaluate(collectRuns, FAMILIES)) {
        const key = `${run.family}|${run.style}|${run.weight}`;
        const face = faces.get(key) ?? { family: run.family, style: run.style, weight: run.weight, runs: new Set(), on_first_page: false };
        face.runs.add(run.text);
        face.on_first_page ||= run.onFirstPage;
        faces.set(key, face);
        if (run.variants.split(' ').some((v) => v !== 'normal' && v !== '') ) unexpected.add(`${key}: ${run.variants}`);
        if (run.lang && run.lang !== 'en') unexpected.add(`${key}: lang=${run.lang}`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
// The subsets keep only Chromium's default features and assume lang="en". Anything else needs the script taught first.
if (unexpected.size) throw new Error(`font settings the subsets do not cover:\n${[...unexpected].join('\n')}`);

const usage = {
  inputs: briefFontInputs(root),
  faces: [...faces.values()].map((f) => ({ ...f, runs: [...f.runs].sort() })).sort((a, b) => `${a.family}${a.style}${a.weight}`.localeCompare(`${b.family}${b.style}${b.weight}`)),
};
console.log(`[brief-fonts] faces in use: ${usage.faces.map((f) => `${f.family} ${f.style} ${f.weight}${f.on_first_page ? ' (cover)' : ''}`).join(', ')}`);
fs.mkdirSync(path.dirname(usageFile), { recursive: true });
fs.writeFileSync(usageFile, JSON.stringify(usage));

const py = ['run', '--quiet', path.join(here, 'subset_brief_fonts.py'), '--usage', usageFile];
if (args.has('--skip-google-parity')) py.push('--skip-google-parity');
const r = spawnSync('uv', py, { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
