import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assignedCountryCodes, buildArabicCountryNames } from './build-country-names-ar.mjs';
import ENGLISH_NAMES from '../shared/country-names.json' with { type: 'json' };
import ISO3_TO_ISO2 from '../shared/iso3-to-iso2.json' with { type: 'json' };

const OUTPUTS = [
  new URL('../shared/country-names-localized.json', import.meta.url),
  new URL('./shared/country-names-localized.json', import.meta.url),
];

// Vietnamese "Nga" conflicts with Nigeria's case-insensitive alpha-3 code NGA.
const LOCALIZED_ALIASES = { vi: { RU: ['Liên bang Nga'] } };

export function supportedCountryLocales() {
  const source = readFileSync(new URL('../src/services/i18n.ts', import.meta.url), 'utf8');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\] as const/);
  if (!declaration) throw new Error('Cannot read SUPPORTED_LANGUAGES from src/services/i18n.ts');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

export function buildLocalizedCountryNames() {
  const locales = {};
  for (const locale of supportedCountryLocales()) {
    if (locale === 'ar') {
      locales[locale] = buildArabicCountryNames().names;
      continue;
    }
    const displayNames = ['long', 'short'].map((style) => new Intl.DisplayNames([locale], {
      type: 'region', style, fallback: 'none',
    }));
    locales[locale] = Object.fromEntries(assignedCountryCodes().map((code) => [code,
      [...new Set([...displayNames.map((display) => display.of(code)),
        ...(LOCALIZED_ALIASES[locale]?.[code] ?? [])].filter((name) => {
        if (!name) return false;
        if (!/^[a-z]{2,3}$/i.test(name)) return true;
        const reserved = ENGLISH_NAMES[name.toLowerCase()]
          ?? (name.length === 2 ? name.toUpperCase() : ISO3_TO_ISO2[name.toUpperCase()]);
        return !reserved || reserved === code;
      }))],
    ]));
  }
  return { cldr: process.versions.cldr, locales };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = `${JSON.stringify(buildLocalizedCountryNames(), null, 2).replace(/\u200c/g, '\\u200c')}\n`;
  if (process.argv.includes('--check')) {
    if (OUTPUTS.some((output) => readFileSync(output, 'utf8') !== next)) {
      console.error('country-names-localized.json is stale. Run: node scripts/build-country-names-localized.mjs');
      process.exitCode = 1;
    }
  } else {
    for (const output of OUTPUTS) writeFileSync(output, next);
  }
}
