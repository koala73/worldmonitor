import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXCLUDED_PREFIXES, shouldScanFile } from '../scripts/check-unicode-safety.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// U+200C ZERO WIDTH NON-JOINER, written as an escape so this test file itself
// stays clean under the very scanner it exercises.
const ZWNJ = String.fromCodePoint(0x200c);

describe('unicode safety scan scope', () => {
  it('does not scan locale data directories', () => {
    // Locale JSON is rendered as UI text, never parsed as code, and legitimately
    // carries ZWNJ/ZWJ (Persian, Devanagari) and bidi marks. src/locales/ has
    // been excluded for that reason since the scanner shipped; pro-test/src/
    // locales/ is the same kind of data and must be excluded too — otherwise
    // `--staged` (which matches by path prefix, not by SCAN_ROOTS) rejects any
    // commit that adds a correctly-typeset Persian or Hindi string.
    assert.equal(shouldScanFile('src/locales/fa.json'), false);
    assert.equal(shouldScanFile('pro-test/src/locales/fa.json'), false);
  });

  it('still scans executable files, including those under pro-test', () => {
    assert.equal(shouldScanFile('src/services/i18n.ts'), true);
    assert.equal(shouldScanFile('pro-test/src/i18n.ts'), true);
    assert.equal(shouldScanFile('scripts/translate-locales.mjs'), true);
  });

  it('excludes every locale data directory in the repo', () => {
    // Guard against the next locale root: adding one without an EXCLUDED_PREFIXES
    // entry silently breaks pre-commit for RTL and Indic translations, which is
    // exactly how pro-test/src/locales/ was missed.
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
        if (entry.name === 'locales') {
          const hasLocaleJson = readdirSync(child).some((name) => /^[a-z]{2}\.json$/.test(name));
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
        EXCLUDED_PREFIXES.includes(dir),
        dir + ' holds locale data but is not in EXCLUDED_PREFIXES — pre-commit will reject valid ZWNJ/bidi translations',
      );
    }
  });

  it('leaves locale files carrying zero-width characters unscanned', () => {
    // Behavioural counterpart to the prefix assertions: the real files on disk
    // do contain these characters, so a regression in scope is a hard failure,
    // not a theoretical one.
    const localeFiles = [];
    for (const dir of ['src/locales', 'pro-test/src/locales']) {
      const abs = join(ROOT, dir);
      if (!statSync(abs).isDirectory()) continue;
      for (const name of readdirSync(abs)) {
        if (name.endsWith('.json')) localeFiles.push(dir + '/' + name);
      }
    }
    const carriers = localeFiles.filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes(ZWNJ));
    assert.ok(carriers.length > 0, 'expected at least one locale file to use ZWNJ');
    for (const rel of carriers) {
      assert.equal(shouldScanFile(rel), false, rel + ' uses ZWNJ and must not be scanned');
    }
  });
});
