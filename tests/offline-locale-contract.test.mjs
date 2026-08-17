import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseLocaleList(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`));
  assert.ok(match, `expected ${name} declaration`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function decodeInlineString(value) {
  return JSON.parse(`"${value}"`);
}

function parseOfflineTable(source) {
  const table = {};
  // A code carrying a region subtag (zh-TW) is not a bare JS identifier, so the
  // generator quotes it. Accept both `zh:` and `'zh-TW':` — matching only
  // `[a-z]{2}` skips the quoted row and reports it as missing from the table.
  const rowPattern = /^\s{8}'?([a-z]{2}(?:-[A-Za-z]{2,4})?)'?: \{ title: "((?:\\\\.|[^"\\\\])*)", msg: "((?:\\\\.|[^"\\\\])*)", retry: "((?:\\\\.|[^"\\\\])*)" \}(?:,)?$/gm;
  for (const match of source.matchAll(rowPattern)) {
    table[match[1]] = {
      title: decodeInlineString(match[2]),
      msg: decodeInlineString(match[3]),
      retry: decodeInlineString(match[4]),
    };
  }
  return table;
}

describe('offline locale contract', () => {
  const appI18n = readFileSync(join(ROOT, 'src/services/i18n.ts'), 'utf8');
  const offlineScript = readFileSync(join(ROOT, 'scripts/sync-offline-translations.mjs'), 'utf8');
  const offlineHtml = readFileSync(join(ROOT, 'public/offline.html'), 'utf8');
  const supportedLanguages = parseLocaleList(appI18n, 'SUPPORTED_LANGUAGES');
  const generatedLocales = parseLocaleList(offlineScript, 'LOCALES');
  const table = parseOfflineTable(offlineHtml);

  it('keeps the generator locale list aligned with the app registry', () => {
    assert.deepEqual([...generatedLocales].sort(), [...supportedLanguages].sort());
  });

  it('keeps the committed offline table aligned with source locale values', () => {
    assert.deepEqual(Object.keys(table).sort(), [...supportedLanguages].sort());

    for (const locale of supportedLanguages) {
      const source = JSON.parse(readFileSync(join(ROOT, 'src/locales', `${locale}.json`), 'utf8'));
      assert.deepEqual(table[locale], {
        title: source.shell.offlineTitle,
        msg: source.shell.offlineMessage,
        retry: source.shell.offlineRetry,
      }, `${locale} offline strings drifted from its source locale`);
    }
  });
});
