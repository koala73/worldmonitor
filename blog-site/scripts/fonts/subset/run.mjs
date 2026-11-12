#!/usr/bin/env node
// Regenerate the blog's subset web fonts. Run by hand: `npm run fonts:subset` in blog-site/.
//
// 1. builds the blog (astro build),
// 2. serves dist/ at /blog/ and renders every page in Chromium, recording each text run's
//    characters and computed font properties (family stack, weight, style, variants, lang,
//    text-transform, hyphens, generated content and list markers),
// 3. runs subset_fonts.py (via `uv run`, which installs its pinned Python deps) to rewrite
//    src/fonts/*.woff2, src/fonts/manifest.json and src/styles/fonts.generated.css.
//
// Needs: the repo root's `npm ci` (Playwright + Chromium) and `uv` (https://docs.astral.sh/uv/).
// Flags: --skip-build (crawl the existing dist/), --skip-google-parity (offline).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blogFontInputs } from './inputs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const blogRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(blogRoot, '..');
const distDir = path.join(blogRoot, 'dist');
const cacheDir = path.join(blogRoot, 'node_modules/.cache/blog-fonts');
const usageFile = path.join(cacheDir, 'usage.json');
const args = new Set(process.argv.slice(2));

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: blogRoot, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${r.status}`);
}

if (!args.has('--skip-build')) run('npm', ['run', 'build']);

const { chromium } = createRequire(path.join(repoRoot, 'package.json'))('playwright');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
function serve() {
  const roots = [['/blog/', distDir], ['/favico/', path.join(repoRoot, 'public/favico')]];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://local');
    const hit = roots.find(([prefix]) => pathname.startsWith(prefix));
    if (!hit) { res.writeHead(404).end(); return; }
    let file = path.join(hit[1], decodeURIComponent(pathname.slice(hit[0].length)));
    if (!file.startsWith(hit[1])) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function listPages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listPages(p, out);
    else if (entry.name.endsWith('.html')) out.push(path.relative(distDir, p).replace(/index\.html$/, ''));
  }
  return out.sort();
}

// Runs in the page. Hidden elements are included: script-revealed text must be covered too.
function collectRuns() {
  const props = ['fontFamily', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'fontVariantLigatures', 'fontVariantNumeric', 'fontVariantCaps', 'fontVariantEastAsian', 'fontVariantPosition', 'fontVariantAlternates', 'fontVariationSettings', 'textTransform', 'hyphens', 'textOverflow'];
  const style = (cs, el) => {
    const s = {};
    for (const p of props) s[p] = cs[p];
    s.lang = el.closest('[lang]')?.getAttribute('lang') || '';
    return s;
  };
  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !n.data.trim()) continue;
    runs.push({ kind: 'text', t: n.data, s: style(getComputedStyle(el), el) });
  }
  for (const el of document.body.querySelectorAll('*')) {
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content && !['none', 'normal', '""'].includes(cs.content)) runs.push({ kind: pseudo, t: cs.content, s: style(cs, el) });
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'list-item') runs.push({ kind: 'marker', t: '', marker: cs.listStyleType, s: style(getComputedStyle(el, '::marker'), el) });
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) runs.push({ kind: 'text', t: placeholder, s: style(getComputedStyle(el, '::placeholder'), el) });
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) && el.value) runs.push({ kind: 'text', t: el.value, s: style(cs, el) });
  }
  return runs;
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/blog/`;
const browser = await chromium.launch();
const usage = { pages: {} };
try {
  const pages = listPages(distDir);
  for (const rel of pages) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // Only the local build: third-party scripts and images are irrelevant to font usage.
    await page.route('**/*', (route) => (route.request().url().startsWith(base.replace('/blog/', '/')) ? route.continue() : route.fulfill({ status: 404, body: '' })));
    await page.goto(base + rel, { waitUntil: 'load' });
    usage.pages['/' + rel] = { runs: await page.evaluate(collectRuns) };
    await context.close();
  }
  console.log(`[fonts] crawled ${pages.length} pages`);
} finally {
  await browser.close();
  server.close();
}
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(usageFile, JSON.stringify(usage));

const py = ['run', '--quiet', path.join(here, 'subset_fonts.py'), '--usage', usageFile];
if (args.has('--skip-google-parity')) py.push('--skip-google-parity');
run('uv', py);

// Record what the subsets were cut for, so the freshness test can tell when to rerun.
const manifestPath = path.join(blogRoot, 'src/fonts/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.inputs = blogFontInputs(blogRoot);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
