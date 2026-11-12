// The brief magazine's fonts are self-hosted subsets cut by hand (`npm run brief-fonts:subset`),
// one file set per rendering platform. This test says when that has to be rerun (the renderer's
// font CSS or languages changed) and checks the committed output is complete and consistent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { briefFontInputs } from '../scripts/brief-fonts/inputs.mjs';
import { BRIEF_FONTS } from '../server/_shared/brief-fonts.generated.js';
import { briefFontPlatform } from '../server/_shared/brief-font-platform.js';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontDir = path.join(root, 'public/assets/brief-fonts');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/brief-fonts/manifest.json'), 'utf8'));
const current = briefFontInputs(root);
const RERUN = 'Run `npm run brief-fonts:subset` and commit public/assets/brief-fonts, server/_shared/brief-fonts.generated.js and scripts/brief-fonts/manifest.json.';
const PLATFORMS = ['apple-woff2', 'apple-woff', 'hinted', 'plain'];

function parseRanges(list) {
  const cps = [];
  for (const part of list.split(',')) {
    const [a, b = a] = part.trim().replace(/^U\+/i, '').split('-');
    for (let cp = parseInt(a, 16); cp <= parseInt(b, 16); cp += 1) cps.push(cp);
  }
  return cps;
}

function fontFaces(css) {
  return [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(([, body]) => ({
    family: body.match(/font-family:'([^']+)'/)?.[1],
    style: body.match(/font-style:(\w+)/)?.[1],
    weight: Number(body.match(/font-weight:(\d+)/)?.[1]),
    file: body.match(/url\(\/assets\/brief-fonts\/([^)]+)\)/)?.[1],
    range: body.match(/unicode-range:([^;}]+)/)?.[1],
  }));
}

describe('brief magazine fonts', () => {
  it('were cut for the current font CSS', () => {
    // Each entry is "selector | declaration": changing, moving or removing a declaration can
    // change which faces, weights and features the magazine needs.
    const added = current.declarations.filter((d) => !manifest.inputs.declarations.includes(d));
    const removed = manifest.inputs.declarations.filter((d) => !current.declarations.includes(d));
    assert.deepEqual({ added, removed }, { added: [], removed: [] }, `Font-related CSS in brief-render.js changed. ${RERUN}`);
  });

  it('were cut for the current page languages', () => {
    assert.deepEqual(current.langs, manifest.inputs.langs, `A lang attribute changed; the subsets drop locl and assume these languages. ${RERUN}`);
  });

  it('were checked against the Google-served files', () => {
    assert.equal(manifest.google_parity_checked, true, `Generated with --skip-google-parity. ${RERUN}`);
  });

  it('ship one CSS and preload set per platform, matching the manifest', () => {
    assert.deepEqual(Object.keys(BRIEF_FONTS).sort(), [...PLATFORMS].sort());
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [...PLATFORMS].sort());
    for (const platform of PLATFORMS) {
      const faces = fontFaces(BRIEF_FONTS[platform].css);
      const expected = manifest.platforms[platform].faces.flatMap((face) =>
        face.files.map((f) => ({ family: face.family, style: face.style, weight: face.weight, file: f.file, range: f.unicode_range })));
      const key = (f) => `${f.family}|${f.style}|${f.weight}|${f.file}|${f.range}`;
      assert.deepEqual(faces.map(key).sort(), expected.map(key).sort(), `${platform}: @font-face rules match the manifest`);
    }
  });

  it('give each character a face draws to exactly one file', () => {
    // Characters no file of the face has keep Google's ranges, which can overlap.
    for (const platform of PLATFORMS) {
      for (const face of manifest.platforms[platform].faces) {
        const inNoFile = new Set(face.in_no_file_range ? parseRanges(face.in_no_file_range) : []);
        const owner = new Map();
        for (const file of face.files) {
          for (const cp of parseRanges(file.unicode_range)) {
            if (inNoFile.has(cp)) continue;
            assert.ok(!owner.has(cp), `${platform}: U+${cp.toString(16)} of ${face.family} ${face.weight} is in ${owner.get(cp)} and ${file.file}`);
            owner.set(cp, file.file);
          }
        }
      }
    }
  });

  it('commit every referenced file, named by its content hash, and nothing else', () => {
    const referenced = new Set();
    for (const platform of PLATFORMS) {
      for (const face of fontFaces(BRIEF_FONTS[platform].css)) referenced.add(face.file);
      for (const p of BRIEF_FONTS[platform].preload) {
        const file = p.href.replace('/assets/brief-fonts/', '');
        assert.ok(referenced.has(file), `${platform}: preload ${file} has an @font-face`);
        assert.equal(p.type, file.endsWith('.woff2') ? 'font/woff2' : 'font/woff');
      }
    }
    const onDisk = fs.readdirSync(fontDir).filter((f) => /\.woff2?$/.test(f));
    assert.deepEqual(onDisk.sort(), [...referenced].sort(), `Font files on disk and in the CSS differ. ${RERUN}`);
    for (const file of onDisk) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(fontDir, file))).digest('hex').slice(0, 10);
      assert.equal(file.match(/\.([0-9a-f]{10})\.woff2?$/)?.[1], hash, `${file} content does not match its name`);
    }
    for (const license of ['ibm-plex-mono-OFL.txt', 'playfair-display-OFL.txt', 'source-serif-4-OFL.txt']) {
      assert.ok(fs.existsSync(path.join(fontDir, license)), `${license} ships with the fonts`);
    }
  });

  it('render with the platform\'s fonts and no Google Fonts request', () => {
    const envelope = {
      version: BRIEF_ENVELOPE_VERSION,
      issuedAt: 1_700_000_000_000,
      data: {
        user: { name: 'Reader', tz: 'UTC' }, issue: '27.05', date: '2026-05-27', dateLong: '27 May 2026',
        digest: { greeting: 'Good evening.', lead: 'Lead.', numbers: { clusters: 1, multiSource: 1, surfaced: 1 }, threads: [{ tag: 'Energy', teaser: 'Teaser.' }], signals: ['Signal.'] },
        stories: [{ category: 'Energy', country: 'IR', threatLevel: 'high', headline: 'Headline.', description: 'Description.', source: 'Wire', sourceUrl: 'https://example.com/a', clusterId: 'c1', whyMatters: 'Why.' }],
      },
    };
    for (const platform of [...PLATFORMS, undefined, 'unknown', 'toString', '__proto__', 'constructor']) {
      const html = renderBriefMagazine(envelope, { fontPlatform: platform });
      const fonts = BRIEF_FONTS[PLATFORMS.includes(platform) ? platform : 'plain'];
      assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
      assert.ok(html.includes(`<style>${fonts.css}</style>`), `${platform}: inlines the platform's @font-face rules`);
      for (const p of fonts.preload) assert.ok(html.includes(`<link rel="preload" as="font" type="${p.type}" href="${p.href}" crossorigin>`), `${platform}: preloads ${p.href}`);
    }
  });
});

// User-Agents probed against fonts.googleapis.com, with the file set Google served each.
const GOOGLE_PROBED = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'apple-woff2'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36', 'apple-woff2'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Safari/537.36', 'apple-woff'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'apple-woff'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0', 'apple-woff'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'apple-woff'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0', 'apple-woff'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'hinted'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', 'hinted'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'hinted'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'hinted'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'hinted'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'plain'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36', 'plain'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'plain'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15', 'plain'],
  ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'plain'],
  ['', 'plain'],
  ['curl/8.7.1', 'plain'],
];

describe('briefFontPlatform', () => {
  for (const [ua, expected] of GOOGLE_PROBED) {
    it(`${expected} for ${ua || '(no user agent)'}`, () => assert.equal(briefFontPlatform(ua), expected));
  }
});
