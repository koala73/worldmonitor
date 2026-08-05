import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXCLUDED_PREFIXES,
  LOCALE_DATA_PREFIXES,
  SCAN_ROOTS,
  isLocaleData,
  scanText,
  shouldScanFile,
} from '../scripts/check-unicode-safety.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Written as escapes so this file stays clean under the scanner it exercises.
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const RLO = String.fromCodePoint(0x202e); // RIGHT-TO-LEFT OVERRIDE — Trojan Source
const ZWSP = String.fromCodePoint(0x200b);

describe('unicode safety scan scope', () => {
  // Both lists are pinned by value, not by spot checks. A scope guard that only
  // asserts what is EXCLUDED stays green when someone empties SCAN_ROOTS or adds
  // a blanket 'api/' exclusion — the scanner then covers nothing and the tests
  // still pass. Changing either list should be a deliberate, reviewed edit.
  it('pins the scanned roots', () => {
    assert.deepEqual(SCAN_ROOTS, [
      'src',
      'server',
      'api',
      'scripts',
      'tests',
      'e2e',
      'pro-test',
      '.github',
      '.husky',
    ]);
  });

  it('pins the excluded prefixes', () => {
    assert.deepEqual(EXCLUDED_PREFIXES, [
      '.git/',
      'node_modules/',
      'src/generated/',
      'docs/',
      'blog-site/',
      'public/blog/',
      'public/pro/',
      'scripts/data/',
      'scripts/node_modules/',
    ]);
  });

  it('scans a representative file under every scan root', () => {
    // The positive direction, pinned as hard as the negative one: if any root is
    // later blanket-excluded, exactly one of these flips.
    for (const path of [
      'src/services/i18n.ts',
      'server/handler.js',
      'api/product-catalog.js',
      'scripts/translate-locales.mjs',
      'tests/locale-staleness.test.mjs',
      'e2e/pricing.spec.ts',
      'pro-test/src/i18n.ts',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
    ]) {
      assert.equal(shouldScanFile(path), true, path + ' must stay in scope');
    }
  });

  it('never scans dependencies, at any depth', () => {
    assert.equal(shouldScanFile('node_modules/pkg/index.js'), false);
    assert.equal(shouldScanFile('scripts/node_modules/pkg/index.js'), false);
    assert.equal(shouldScanFile('pro-test/node_modules/pkg/dist/app.js'), false);
    // Segment match, not substring — a first-party dir merely containing the
    // word stays covered.
    assert.equal(shouldScanFile('src/node_modules_helper/a.ts'), true);
  });

  it('does not scan the built /pro bundle', () => {
    // pro-test/ compiles into public/pro/ and every locale becomes its own hashed
    // chunk, so the joiners allowed in locale data reappear verbatim in the
    // output. Asserted on a .js path: '.html' is not a scanned extension, so an
    // index.html assertion would pass with the exclusion removed and pin nothing.
    assert.equal(shouldScanFile('public/pro/assets/fa-DbM9A4cI.js'), false);
    assert.equal(shouldScanFile('public/pro/assets/index-Dg2LO6WS.js'), false);
    assert.equal(shouldScanFile('public/blog/whatever.js'), false);
  });
});

describe('unicode safety locale allowance', () => {
  it('still scans locale data', () => {
    // Locale files are NOT skipped — the carve-out is per code point, below.
    // Skipping the path would disable Trojan Source detection on strings that
    // render as prices and licence terms on a public page.
    for (const prefix of LOCALE_DATA_PREFIXES) {
      assert.equal(shouldScanFile(prefix + 'fa.json'), true);
      assert.equal(isLocaleData(prefix + 'fa.json'), true);
    }
    assert.equal(isLocaleData('src/services/i18n.ts'), false);
  });

  it('allows the joiners Persian and Devanagari require', () => {
    const persian = 'MCP ' + ZWNJ + ' SDK';
    assert.deepEqual(scanText('pro-test/src/locales/fa.json', persian), []);
    assert.deepEqual(scanText('src/locales/hi.json', 'a' + ZWJ + 'b'), []);
  });

  it('still rejects bidi controls inside locale data', () => {
    // The whole point of the narrow allowance. A bidi override in an RTL locale
    // reverses a rendered digit run, so "$39.99" can display as something else
    // while the JSON a reviewer reads looks correct.
    const spoofed = '$39.99' + RLO + '/mo';
    const found = scanText('pro-test/src/locales/fa.json', spoofed);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'bidi-control');
  });

  it('still rejects other invisible characters inside locale data', () => {
    const found = scanText('src/locales/fa.json', 'price' + ZWSP + 'tag');
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'zero-width');
  });

  it('rejects the joiners outside locale data', () => {
    // The allowance is scoped to locale paths — source code gets no exemption.
    assert.equal(scanText('src/services/i18n.ts', 'a' + ZWNJ + 'b').length, 1);
  });
});

describe('unicode safety real tree', () => {
  it('accepts every locale file currently committed', () => {
    // Behavioural counterpart: the real files use these characters, so a
    // regression in the allowance is a hard failure rather than a theory.
    let carriers = 0;
    for (const dir of LOCALE_DATA_PREFIXES) {
      const abs = join(ROOT, dir);
      if (!statSync(abs).isDirectory()) continue;
      for (const name of readdirSync(abs)) {
        if (!name.endsWith('.json')) continue;
        const rel = dir + name;
        const text = readFileSync(join(ROOT, rel), 'utf8');
        if (text.includes(ZWNJ) || text.includes(ZWJ) || text.includes(ZWSP)) carriers++;
        assert.deepEqual(scanText(rel, text), [], rel + ' must pass the scan as committed');
      }
    }
    assert.ok(carriers > 0, 'expected at least one locale file to use a joiner');
  });

  it('keeps every locale data directory in the repo covered by the allowance', () => {
    // Guard against the next locale root. Matches BCP-47 filenames (zh-CN.json,
    // pt-BR.json) and the usual directory names, so a widget or TV package
    // adding one is caught rather than silently blocking its translators.
    const localeDirs = [];
    const walk = (abs) => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const child = join(abs, entry.name);
        const rel = relative(ROOT, child).replace(/\\/g, '/') + '/';
        if (['locales', 'locale', 'i18n', 'lang', 'translations'].includes(entry.name)) {
          const hasLocaleJson = readdirSync(child).some((name) =>
            /^[a-z]{2}(-[A-Za-z0-9]{2,8})*\.json$/.test(name),
          );
          if (hasLocaleJson) localeDirs.push(rel);
          continue;
        }
        walk(child);
      }
    };
    walk(ROOT);

    assert.ok(localeDirs.length >= 2, 'expected to find the app and pro-test locale directories');
    for (const dir of localeDirs) {
      assert.ok(
        LOCALE_DATA_PREFIXES.includes(dir) || EXCLUDED_PREFIXES.includes(dir),
        dir + ' holds locale data but gets no joiner allowance — pre-commit will reject valid ZWNJ/ZWJ translations',
      );
    }
  });
});
