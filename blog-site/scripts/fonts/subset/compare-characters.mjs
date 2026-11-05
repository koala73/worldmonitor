// Browser proof for characters in Google's CSS ranges that no served file maps.
// Run `npm run fonts:compare` in blog-site/. Downloads are pinned by the snapshot;
// this is a manual rendering check, not a network-dependent unit/CI test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const blog = path.resolve(here, '../../..');
const { chromium } = createRequire(path.join(blog, '../package.json'))('playwright');
const sharp = createRequire(path.join(blog, 'package.json'))('sharp');
const snapshot = JSON.parse(fs.readFileSync(path.join(here, 'google-fonts-snapshot.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(blog, 'src/fonts/manifest.json')));
const output = path.resolve(process.argv[2] || path.join(blog, 'node_modules/.cache/blog-fonts/comparison'));
fs.mkdirSync(output, { recursive: true });

// Keep this fixture independent of the generator: all 17 must be exercised even
// if its exception list, CSS ranges or file partition accidentally lose a letter.
const regressions = { 'JetBrains Mono': 'ǖǟǢǣǬǭȫȬȭṎṏ', 'Space Grotesk': 'ǞǟǢǣǬǭ' };
function ranges(value) {
  const cps = new Set();
  for (const part of value.split(',')) {
    const [start, end = start] = part.trim().replace(/^U\+/, '').split('-').map((s) => parseInt(s, 16));
    for (let cp = start; cp <= end; cp++) cps.add(cp);
  }
  return cps;
}

const cells = [];
const referenceRules = [];
const downloads = new Map();
for (const [family, google] of Object.entries(snapshot.families)) {
  const draws = new Set(Object.values(google.subsets).flatMap((s) => [...ranges(s.renders)]));
  const all = new Set(Object.values(google.subsets).flatMap((s) => [...ranges(s.unicode_range)]));
  for (const cp of [...all].sort((a, b) => a - b)) {
    // Control and unassigned characters have no printable-character contract.
    if (!draws.has(cp) && cp >= 0xA0 && !/\p{Cn}/u.test(String.fromCodePoint(cp))) {
      cells.push({ family, cp, weight: family === 'Space Grotesk' ? 700 : 400, size: 28 });
    }
  }
  for (const sub of Object.values(google.subsets)) {
    // Fetch once and serve locally. A failed download/hash must never silently
    // turn both sides into the same system fallback and produce a false pass.
    const response = await fetch(sub.url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `${sub.url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sub.sha256, sub.url);
    const url = `/reference/${downloads.size}.woff2`;
    downloads.set(url, bytes);
    for (const weight of google.faces) referenceRules.push(`@font-face {font-family:'${family}';font-style:normal;font-weight:${weight};src:url('${url}');unicode-range:${sub.unicode_range};}`);
  }
}
const broadCount = cells.length;
for (const [family, letters] of Object.entries(regressions)) {
  for (const weight of manifest.families[family].faces) {
    for (const cp of [...letters].map((c) => c.codePointAt(0))) {
      assert.ok(cells.some((c) => c.family === family && c.cp === cp), `${family} U+${cp.toString(16)} missing from broad probe`);
      cells.push({ family, cp, weight, size: 40 });
    }
  }
}
const ours = fs.readFileSync(path.join(blog, 'src/styles/fonts.generated.css'), 'utf8').replaceAll('../fonts/', '/fonts/');
const reference = referenceRules.join('\n');
const span = ({ family, cp, weight, size }) => `<span style="display:inline-block;width:96px;height:96px;font-family:'${family}';font-weight:${weight};font-size:${size}px;line-height:96px;text-align:center;overflow:hidden;vertical-align:top">x&#${cp};</span>`;
const body = cells.map(span).join('');
const html = (css, content, width) => `<!doctype html><html lang="en"><meta charset="utf-8"><style>${css}</style><body style="margin:0;width:${width}px;line-height:0;background:white;color:black">${content}</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local').pathname;
  if (downloads.has(url)) return res.writeHead(200, { 'content-type': 'font/woff2' }).end(downloads.get(url));
  if (url.startsWith('/fonts/')) {
    const file = path.join(blog, 'src/fonts', path.basename(url));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'font/woff2' }).end(fs.readFileSync(file));
  }
  if (url === '/focus') {
    const rows = Object.entries(regressions).map(([family, letters]) => `<h2>${family}</h2><p>Google reference</p><div>${[...letters].map((c) => span({ family: `Reference ${family}`, cp: c.codePointAt(0), weight: family === 'Space Grotesk' ? 700 : 400, size: 40 })).join('')}</div><p>Blog subset</p><div>${[...letters].map((c) => span({ family, cp: c.codePointAt(0), weight: family === 'Space Grotesk' ? 700 : 400, size: 40 })).join('')}</div>`).join('');
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(reference.replaceAll("font-family:'", "font-family:'Reference ") + ours + 'h2,p{font:16px system-ui;line-height:1.5;margin:16px}', rows, 1056));
  }
  if (!['/reference', '/ours'].includes(url)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(url === '/reference' ? reference : ours, body, 2592));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const shots = {};
  for (const name of ['reference', 'ours', 'focus']) {
    const context = await browser.newContext({ viewport: { width: 2592, height: 800 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const failed = [];
      const loaded = new Set();
      page.on('requestfailed', (r) => failed.push(r.url()));
      page.on('response', (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
        if (r.request().resourceType() === 'font') loaded.add(new URL(r.url()).pathname);
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/${name}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(failed, [], `${name}: downloads must succeed`);
      assert.ok(loaded.size > 0, `${name}: must load web fonts`);
      if (name === 'ours') {
        for (const family of Object.keys(regressions)) {
          const file = manifest.families[family].files.composition;
          if (file) assert.ok(loaded.has(`/fonts/${file.file}`), `${family}: composition file must load`);
        }
      }
      if (name === 'focus') await page.setViewportSize({ width: 1056, height: 800 });
      const png = await page.screenshot({ fullPage: true });
      fs.writeFileSync(path.join(output, `${name}.png`), png);
      if (name !== 'focus') shots[name] = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } finally { await context.close(); }
  }
  const { reference: a, ours: b } = shots;
  assert.deepEqual(a.info, b.info);
  const bad = [];
  cells.forEach((cell, n) => {
    const x0 = n % 27 * 96, y0 = Math.floor(n / 27) * 96;
    let pixels = 0;
    for (let y = y0; y < y0 + 96; y++) for (let x = x0; x < x0 + 96; x++) {
      const i = (y * a.info.width + x) * 4;
      if ([0, 1, 2, 3].some((c) => a.data[i + c] !== b.data[i + c])) pixels++;
    }
    if (pixels) bad.push({ ...cell, char: String.fromCodePoint(cell.cp), pixels });
  });
  const result = { browser: browser.version(), platform: process.platform, broadCount, focusedCount: cells.length - broadCount, bad };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  assert.equal(bad.length, 0, `Per-character rendering differs; see ${output}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
