#!/usr/bin/env node
/**
 * Builds shared/country-names-ar.json (and its scripts/shared/ mirror): Arabic names for every country code the
 * MCP country resolver accepts (shared/country-code-resolve.ts).
 *
 *   node scripts/build-country-names-ar.mjs           write the file
 *   node scripts/build-country-names-ar.mjs --check   exit 1 when it is stale
 *
 * Source: CLDR via Intl.DisplayNames('ar'), long and short styles, plus the
 * common short and official forms below that CLDR does not carry ("السعودية"
 * for "المملكة العربية السعودية"). Names are stored as written; the resolver
 * normalizes them (shared/country-code-resolve-arabic.ts). The CLDR release
 * that produced the file is recorded so the sync test only compares against
 * the same release (tests/mcp-country-args-arabic.test.mts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// scripts/shared/ mirrors every shared/*.json byte for byte
// (tests/edge-functions.test.mjs), so both copies are written.
const OUTPUTS = [
  new URL('../shared/country-names-ar.json', import.meta.url),
  new URL('./shared/country-names-ar.json', import.meta.url),
];
const ISO3_TO_ISO2 = JSON.parse(readFileSync(new URL('../shared/iso3-to-iso2.json', import.meta.url), 'utf8'));

// Mirrors ASSIGNED_ISO2_OUTSIDE_GEOJSON in shared/country-code-resolve.ts. The
// test asserts this file covers exactly the codes isAssignedCountryCode accepts.
const ASSIGNED_OUTSIDE_GEOJSON = ['BQ', 'BV', 'CC', 'CX', 'GF', 'GP', 'MQ', 'RE', 'SJ', 'TK', 'YT'];

/**
 * Common names and official long forms. A name that could mean two countries
 * stays out: "كوريا" (Korea) has no entry. "الكونغو" follows the English map,
 * where bare "congo" is the Republic of the Congo (CG).
 */
export const ARABIC_ALIASES = Object.freeze({
  AE: ['الإمارات', 'دولة الإمارات', 'دولة الإمارات العربية المتحدة'],
  BH: ['مملكة البحرين'],
  BY: ['بيلاروسيا', 'روسيا البيضاء'],
  CD: ['الكونغو الديمقراطية', 'جمهورية الكونغو الديمقراطية'],
  CG: ['الكونغو', 'جمهورية الكونغو'],
  CI: ['كوت ديفوار'],
  CN: ['جمهورية الصين الشعبية'],
  CV: ['كابو فيردي'],
  CZ: ['جمهورية التشيك', 'تشيكيا'],
  DJ: ['جمهورية جيبوتي'],
  DK: ['الدنمارك'],
  DZ: ['الجمهورية الجزائرية'],
  EG: ['جمهورية مصر العربية'],
  GB: ['بريطانيا', 'بريطانيا العظمى'],
  HK: ['هونج كونج'],
  HU: ['المجر'],
  IL: ['دولة إسرائيل'],
  IQ: ['جمهورية العراق'],
  IR: ['جمهورية إيران الإسلامية'],
  JO: ['المملكة الأردنية الهاشمية'],
  KG: ['قرغيزستان'],
  KM: ['جمهورية جزر القمر'],
  KP: ['جمهورية كوريا الديمقراطية الشعبية'],
  KR: ['جمهورية كوريا'],
  KW: ['دولة الكويت'],
  LB: ['الجمهورية اللبنانية'],
  LY: ['دولة ليبيا'],
  MA: ['المملكة المغربية'],
  MK: ['مقدونيا'],
  MM: ['ميانمار', 'بورما'],
  MR: ['الجمهورية الإسلامية الموريتانية'],
  OM: ['سلطنة عمان'],
  PS: ['دولة فلسطين', 'غزة', 'قطاع غزة', 'الضفة الغربية'],
  QA: ['دولة قطر'],
  RU: ['روسيا الاتحادية', 'الاتحاد الروسي'],
  SA: ['السعودية', 'المملكة السعودية'],
  SD: ['جمهورية السودان'],
  SO: ['جمهورية الصومال'],
  SY: ['سورية', 'الجمهورية العربية السورية'],
  SZ: ['سوازيلاند'],
  TL: ['تيمور الشرقية'],
  TN: ['الجمهورية التونسية'],
  TR: ['الجمهورية التركية'],
  US: ['الولايات المتحدة الأمريكية', 'أمريكا'],
  VA: ['دولة الفاتيكان'],
  YE: ['الجمهورية اليمنية'],
});

export function assignedCountryCodes() {
  return [...new Set([...Object.values(ISO3_TO_ISO2), ...ASSIGNED_OUTSIDE_GEOJSON])].sort();
}

export function buildArabicCountryNames() {
  const long = new Intl.DisplayNames(['ar'], { type: 'region' });
  const short = new Intl.DisplayNames(['ar'], { type: 'region', style: 'short' });
  const names = {};
  for (const code of assignedCountryCodes()) {
    const list = [long.of(code), short.of(code), ...(ARABIC_ALIASES[code] ?? [])]
      .filter((name) => typeof name === 'string' && name && name !== code);
    names[code] = [...new Set(list)];
  }
  return { cldr: process.versions.cldr, names };
}

function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = serialize(buildArabicCountryNames());
  if (process.argv.includes('--check')) {
    const stale = OUTPUTS.filter((output) => readFileSync(output, 'utf8') !== next);
    if (stale.length) {
      console.error('country-names-ar.json is stale. Run: node scripts/build-country-names-ar.mjs');
      process.exit(1);
    }
    console.log('country-names-ar.json is current.');
  } else {
    for (const output of OUTPUTS) writeFileSync(output, next);
    console.log('Wrote shared/country-names-ar.json and scripts/shared/country-names-ar.json');
  }
}
