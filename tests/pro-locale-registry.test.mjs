import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PRO_LOCALES_DIR = join(ROOT, 'pro-test', 'src', 'locales');

function parseStringArrayConst(source, name) {
  const match = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\[([^\\]]+)\\]'));
  assert.ok(match, 'expected ' + name + ' declaration');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function parseRecordKeys(source, name) {
  const match = source.match(new RegExp('const\\s+' + name + ':\\s*Record<string, string>\\s*=\\s*{([\\s\\S]*?)\\n\\s*};'));
  assert.ok(match, 'expected ' + name + ' declaration');
  return [...match[1].matchAll(/(?:^|[,{])\s*([a-z]{2}):\s*'/g)].map((entry) => entry[1]).sort();
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

  it('ships one pro locale JSON file for every registered language', () => {
    const proLocaleFiles = readdirSync(PRO_LOCALES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();

    assert.deepEqual(proLocaleFiles, [...canonicalLanguages].sort());
  });

  it('keeps pro and app Open Graph locale maps aligned with registered languages', () => {
    const appOgLocales = parseRecordKeys(app, 'ogLocaleMap');
    const proOgLocales = parseRecordKeys(proI18n, 'OG_LOCALE');
    const sortedCanonical = [...canonicalLanguages].sort();

    assert.deepEqual(appOgLocales, sortedCanonical);
    assert.deepEqual(proOgLocales, sortedCanonical);
  });
});
