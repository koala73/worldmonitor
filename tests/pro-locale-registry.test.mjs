import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PRO_LOCALES_DIR = join(ROOT, 'pro-test', 'src', 'locales');

const EXPECTED_OG_LOCALE = {
  ar: 'ar_SA',
  bg: 'bg_BG',
  cs: 'cs_CZ',
  de: 'de_DE',
  el: 'el_GR',
  en: 'en_US',
  es: 'es_ES',
  fa: 'fa_IR',
  fr: 'fr_FR',
  hi: 'hi_IN',
  hr: 'hr_HR',
  hu: 'hu_HU',
  it: 'it_IT',
  ja: 'ja_JP',
  ko: 'ko_KR',
  nl: 'nl_NL',
  pl: 'pl_PL',
  pt: 'pt_BR',
  ro: 'ro_RO',
  ru: 'ru_RU',
  sv: 'sv_SE',
  th: 'th_TH',
  tr: 'tr_TR',
  vi: 'vi_VN',
  zh: 'zh_CN',
};

function parseStringArrayConst(source, name) {
  const match = source.match(new RegExp(String.raw`const\s+${name}\s*=\s*\[([^\]]+)\]`));
  assert.ok(match, 'expected ' + name + ' declaration');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function parseRecord(source, name) {
  const match = source.match(new RegExp(String.raw`const\s+${name}:\s*Record<string, string>\s*=\s*{([\s\S]*?)\n\s*};`));
  assert.ok(match, 'expected ' + name + ' declaration');
  return Object.fromEntries([...match[1].matchAll(/(?:^|[,{])\s*([a-z]{2}):\s*'([^']+)'/g)].map((entry) => [entry[1], entry[2]]));
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? prefix + '.' + key : key));
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

describe('pro locale registry', () => {
  const appI18n = readFileSync(join(ROOT, 'src', 'services', 'i18n.ts'), 'utf8');
  const app = readFileSync(join(ROOT, 'src', 'App.ts'), 'utf8');
  const proI18n = readFileSync(join(ROOT, 'pro-test', 'src', 'i18n.ts'), 'utf8');

  const canonicalLanguages = parseStringArrayConst(appI18n, 'SUPPORTED_LANGUAGES');
  const proLanguages = parseStringArrayConst(proI18n, 'SUPPORTED_LANGUAGES');

  it('registers the same languages as the main app in the same order', () => {
    assert.deepEqual(proLanguages, canonicalLanguages);
  });

  it('ships one parseable pro locale JSON file for every registered language', () => {
    const proLocaleFiles = readdirSync(PRO_LOCALES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();

    assert.deepEqual(proLocaleFiles, [...canonicalLanguages].sort());

    for (const language of canonicalLanguages) {
      assert.doesNotThrow(
        () => JSON.parse(readFileSync(join(PRO_LOCALES_DIR, language + '.json'), 'utf8')),
        language + '.json should parse as JSON',
      );
    }
  });

  it('keeps non-English pro locales on an accepted schema shape', () => {
    const localizedFiles = readdirSync(PRO_LOCALES_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'en.json')
      .sort();
    const [referenceFile, ...filesToCheck] = localizedFiles;
    assert.ok(referenceFile, 'expected at least one localized pro locale');

    const referenceKeys = flattenKeys(JSON.parse(readFileSync(join(PRO_LOCALES_DIR, referenceFile), 'utf8'))).sort();
    const englishKeys = flattenKeys(JSON.parse(readFileSync(join(PRO_LOCALES_DIR, 'en.json'), 'utf8'))).sort();

    for (const file of filesToCheck) {
      const keys = flattenKeys(JSON.parse(readFileSync(join(PRO_LOCALES_DIR, file), 'utf8'))).sort();
      assert.ok(
        sameList(keys, referenceKeys) || sameList(keys, englishKeys),
        file + ' should match either ' + referenceFile + ' schema or the complete English placeholder schema',
      );
    }
  });

  it('keeps pro and app Open Graph locale maps aligned with registered languages', () => {
    const appOgLocales = parseRecord(app, 'ogLocaleMap');
    const proOgLocales = parseRecord(proI18n, 'OG_LOCALE');
    const expectedOgLocales = Object.fromEntries(canonicalLanguages.map((language) => [language, EXPECTED_OG_LOCALE[language]]));

    assert.deepEqual(appOgLocales, expectedOgLocales);
    assert.deepEqual(proOgLocales, expectedOgLocales);
  });
});
