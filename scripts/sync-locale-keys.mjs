#!/usr/bin/env node
/**
 * Sync missing i18n keys from en.json into every other locale file.
 *
 * Existing translations are preserved. Missing keys are copied from English
 * so all locales share the same key structure (i18next still falls back to en).
 *
 * Generated catalogues are the exception. `zh-TW.json` is converted from
 * `zh.json` by scripts/convert-zh-tw.py, not translated from en.json, so an
 * English literal written here is both wrong for the file and temporary: the
 * next generator run overwrites it, and `convert-zh-tw.py --check` fails on it
 * in the meantime. Their key gaps are still reported and counted — they are
 * real, and the generator is what closes them.
 *
 * Usage:
 *   node scripts/sync-locale-keys.mjs          # write updates
 *   node scripts/sync-locale-keys.mjs --check    # exit 1 if any locale is out of sync
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenKeys, localePathTokens } from './_locale-keys.mjs';
// Imported rather than restated: this file would otherwise be a third place
// that has to be told zh-TW is generated, after translate-locales.mjs and the
// catalogue test.
import {
  GENERATED_LOCALES,
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
} from './translate-locales.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'locales');
const EN_PATH = join(LOCALES_DIR, 'en.json');
const CHECK_ONLY = process.argv.includes('--check');
const GENERATED_HINT = 'Run: npm run locales:zh-tw';
// Shell bundles (*.shell.json) are intentionally partial first-paint resources, not full locales.

/**
 * Merge en (template) into a locale, preserving the locale's EXISTING key order
 * and values. Missing keys are appended from en (English placeholder until
 * translated). Iterating the locale first keeps the diff to just the new keys
 * instead of rewriting every file into en's order.
 *
 * Brand-new pluralized keys use the locale's CLDR projection. Categories that
 * English does not carry (for example Arabic `_zero`, `_two`, `_few`, and
 * `_many`) start with the projected English fallback until translated.
 *
 * Leaf values (strings and arrays) prefer the locale's translation and fall
 * back to en; nested objects are merged key-by-key.
 *
 * @param {unknown} template
 * @param {unknown} locale
 */
export function syncFromTemplate(template, locale, expectedKeys, prefix = '') {
  if (typeof template === 'string') {
    return typeof locale === 'string' ? locale : template;
  }

  // Arrays are leaf values: keep the locale's translated array, fall back to en.
  if (Array.isArray(template)) {
    return Array.isArray(locale) ? locale : template;
  }

  if (template && typeof template === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    /** @type {Record<string, unknown>} */
    const templateObj = /** @type {Record<string, unknown>} */ (template);
    const localeObj =
      locale && typeof locale === 'object' && !Array.isArray(locale)
        ? /** @type {Record<string, unknown>} */ (locale)
        : {};
    const expectedKeyList = Object.keys(expectedKeys);

    // Keep the locale's own key order (and recurse to preserve nested order).
    // Locale-only keys (legacy / in-flight translations) are carried through.
    for (const [key, value] of Object.entries(localeObj)) {
      const keyPath = prefix ? `${prefix}.${key}` : key;
      out[key] = key in templateObj
        ? syncFromTemplate(templateObj[key], value, expectedKeys, keyPath)
        : value;
    }

    // Append keys present in en but missing from the locale, in en's order.
    for (const [key, value] of Object.entries(templateObj)) {
      if (!(key in out)) {
        const keyPath = prefix ? `${prefix}.${key}` : key;
        const isExpected = Object.hasOwn(expectedKeys, keyPath)
          || expectedKeyList.some((candidate) => candidate.startsWith(`${keyPath}.`));
        if (isExpected) {
          out[key] = syncFromTemplate(value, localeObj[key], expectedKeys, keyPath);
        }
      }
    }

    if (prefix === '') {
      for (const [keyPath, value] of Object.entries(expectedKeys)) {
        setMissingDottedPath(out, keyPath, value);
      }
    }

    return out;
  }

  return template;
}

function setMissingDottedPath(target, keyPath, value) {
  const segments = localePathTokens(keyPath).map((token) => token.value);
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const wantsArray = typeof segments[index + 1] === 'number';
    const existing = cursor[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) !== wantsArray) {
      cursor[segment] = wantsArray ? [] : {};
    }
    cursor = cursor[segment];
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined && !(leaf in cursor)) cursor[leaf] = value;
}

/**
 * Parse a JSON file, tagging parse errors with the file name for diagnosis.
 *
 * @param {string} path
 * @param {string} label
 */
function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function main() {
  const en = readJson(EN_PATH, 'en.json');
  const enFlat = flatten(en);
  const pluralBases = findPluralBases(enFlat);
  const localeFiles = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'en.json' && !name.endsWith('.shell.json'))
    .sort();

  let totalMissing = 0;
  let generatedMissing = 0;
  let outOfSync = false;

  for (const file of localeFiles) {
    const path = join(LOCALES_DIR, file);
    const localeCode = file.replace(/\.json$/, '');
    const locale = readJson(path, file);
    const localeKeys = new Set(flattenKeys(locale));
    const expectedKeys = expectedKeysForLocale(
      enFlat,
      pluralBases,
      getPluralCategories(localeCode),
    );
    const missing = Object.keys(expectedKeys).filter((key) => !localeKeys.has(key));

    if (missing.length === 0) {
      console.log(`${file}: up to date (${localeKeys.size} keys)`);
      continue;
    }

    outOfSync = true;
    totalMissing += missing.length;

    // Reported and counted, never written — see the header. Writing English
    // here would also make the failure self-inflicted: the next
    // `convert-zh-tw.py --check` compares against zh.json and finds the
    // placeholder, so the fix for a sync run would be another regeneration.
    if (GENERATED_LOCALES.has(localeCode)) {
      generatedMissing += missing.length;
      console.log(`${file}: missing ${missing.length} key(s) — generated, not written here (${GENERATED_HINT})`);
      continue;
    }

    console.log(`${file}: missing ${missing.length} key(s)`);

    if (!CHECK_ONLY) {
      const synced = syncFromTemplate(en, locale, expectedKeys);
      writeFileSync(path, `${JSON.stringify(synced, null, 2)}\n`, 'utf8');
    }
  }

  if (CHECK_ONLY) {
    if (outOfSync) {
      console.error(`\nLocale files are missing ${totalMissing} key(s) total. Run: npm run sync:locales`);
      if (generatedMissing > 0) {
        console.error(`${generatedMissing} of those are in generated catalogues, which that command does not write. ${GENERATED_HINT}`);
      }
      process.exit(1);
    }
    console.log(`All ${localeFiles.length} locale files match their CLDR projection of en.json.`);
    return;
  }

  if (totalMissing === 0) {
    console.log('All locale files already match their CLDR projection of en.json.');
    return;
  }

  console.log(
    `\nSynced ${totalMissing - generatedMissing} missing key(s) across ${localeFiles.length} locale files.`,
  );
  if (generatedMissing > 0) {
    console.log(`${generatedMissing} key(s) are in generated catalogues and were left alone. ${GENERATED_HINT}`);
  }
}

// Run only when invoked directly (importing this file must not read/write files).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
