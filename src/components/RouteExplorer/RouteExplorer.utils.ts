/**
 * Pure builders + data helpers for the Route Explorer modal.
 *
 * Kept in a sibling -utils file so node:test can import it without pulling
 * in the @/services/i18n dependency chain (per
 * `feedback_panel_utils_split_for_node_test.md`).
 */

import COUNTRY_PORT_CLUSTERS from '../../../scripts/shared/country-port-clusters.json';
import { toFlagEmoji } from '../../utils/country-flag';

// ─── Country list ───────────────────────────────────────────────────────────

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export interface CountryListEntry {
  iso2: string;
  name: string;
  flag: string;
  searchKey: string; // lowercase, no diacritics, used for typeahead matching
}

function isIso2Key(key: string): boolean {
  return /^[A-Z]{2}$/.test(key);
}

function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let cachedCountries: CountryListEntry[] | null = null;

/**
 * Get all 197 port-clustered countries with display names + flags. Cached.
 * Sorted alphabetically by display name.
 */
export function getAllCountries(): CountryListEntry[] {
  if (cachedCountries) return cachedCountries;
  const out: CountryListEntry[] = [];
  for (const key of Object.keys(COUNTRY_PORT_CLUSTERS as Record<string, unknown>)) {
    if (!isIso2Key(key)) continue;
    const name = regionNames?.of(key) ?? key;
    out.push({
      iso2: key,
      name,
      flag: toFlagEmoji(key),
      searchKey: `${normalizeForSearch(name)} ${key.toLowerCase()}`,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  cachedCountries = out;
  return out;
}

/**
 * Filter the country list by a typeahead query. Empty query returns the
 * full list. Matches against display name + ISO2.
 */
export function filterCountries(
  query: string,
  list: CountryListEntry[] = getAllCountries(),
): CountryListEntry[] {
  const q = normalizeForSearch(query);
  if (!q) return list;
  return list.filter((c) => c.searchKey.includes(q));
}

// ─── HS2 list ───────────────────────────────────────────────────────────────

export interface Hs2Entry {
  hs2: string; // numeric, may be 1 or 2 chars
  label: string;
  searchKey: string;
}

/**
 * The HS2 sectors the Route Explorer surfaces. Kept in sync with the
 * server-side `HS2_LABELS` table in get-sector-dependency.ts so users only
 * see codes the backend can actually compute against.
 */
const HS2_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['1', 'Live Animals'],
  ['2', 'Meat'],
  ['3', 'Fish & Seafood'],
  ['4', 'Dairy'],
  ['6', 'Plants & Flowers'],
  ['7', 'Vegetables'],
  ['8', 'Fruit & Nuts'],
  ['10', 'Cereals'],
  ['11', 'Milling Products'],
  ['12', 'Oilseeds'],
  ['15', 'Animal & Vegetable Fats'],
  ['16', 'Meat Preparations'],
  ['17', 'Sugar'],
  ['18', 'Cocoa'],
  ['19', 'Food Preparations'],
  ['22', 'Beverages & Spirits'],
  ['23', 'Residues & Animal Feed'],
  ['24', 'Tobacco'],
  ['25', 'Salt & Cement'],
  ['26', 'Ores, Slag & Ash'],
  ['27', 'Mineral Fuels & Energy'],
  ['28', 'Inorganic Chemicals'],
  ['29', 'Organic Chemicals'],
  ['30', 'Pharmaceuticals'],
  ['31', 'Fertilizers'],
  ['38', 'Chemical Products'],
  ['39', 'Plastics'],
  ['40', 'Rubber'],
  ['44', 'Wood'],
  ['47', 'Pulp & Paper'],
  ['48', 'Paper & Paperboard'],
  ['52', 'Cotton'],
  ['61', 'Clothing (Knitted)'],
  ['62', 'Clothing (Woven)'],
  ['71', 'Precious Metals & Gems'],
  ['72', 'Iron & Steel'],
  ['73', 'Iron & Steel Articles'],
  ['74', 'Copper'],
  ['76', 'Aluminium'],
  ['79', 'Zinc'],
  ['80', 'Tin'],
  ['84', 'Machinery & Mechanical Appliances'],
  ['85', 'Electrical & Electronic Equipment'],
  ['86', 'Railway'],
  ['87', 'Vehicles'],
  ['88', 'Aircraft'],
  ['89', 'Ships & Boats'],
  ['90', 'Optical & Medical Instruments'],
  ['93', 'Arms & Ammunition'],
];

let cachedHs2: Hs2Entry[] | null = null;

export function getAllHs2(): Hs2Entry[] {
  if (cachedHs2) return cachedHs2;
  cachedHs2 = HS2_LABELS.map(([hs2, label]) => ({
    hs2,
    label,
    searchKey: `${normalizeForSearch(label)} hs${hs2} ${hs2}`,
  }));
  return cachedHs2;
}

export function filterHs2(query: string, list: Hs2Entry[] = getAllHs2()): Hs2Entry[] {
  const q = normalizeForSearch(query);
  if (!q) return list;
  return list.filter((e) => e.searchKey.includes(q));
}

// ─── Cargo type inference ──────────────────────────────────────────────────

export type ExplorerCargo = 'container' | 'tanker' | 'bulk' | 'roro';

/**
 * Auto-infer a cargo type from the selected HS2 chapter. Returns 'container'
 * as a sensible default for codes not in the explicit map.
 */
export function inferCargoFromHs2(hs2: string | null): ExplorerCargo {
  if (!hs2) return 'container';
  const code = hs2.replace(/\D/g, '');
  if (code === '27') return 'tanker';
  if (['10', '11', '12', '15', '26'].includes(code)) return 'bulk';
  if (['87', '89'].includes(code)) return 'roro';
  // Container default covers 84/85/90/61/62/etc.
  return 'container';
}
