/**
 * Neighbouring countries, keyed by ISO 3166-1 alpha-2 (uppercase).
 *
 * Used by tab focus scopes (#10453): a scope on a few countries can widen to
 * their neighbours, so a travel-risk tab on Thailand also watches Laos,
 * Cambodia, Myanmar and Malaysia.
 *
 * Sources and licence:
 * - LAND_BORDER_PAIRS is compiled from the CIA World Factbook "Land boundaries"
 *   entries (US government work, public domain), cross-checked against the
 *   Natural Earth admin-0 boundary lines (public domain).
 * - SEA_NEIGHBOUR_PAIRS is a hand-reviewed editorial list. A pair qualifies
 *   when at least one holds: about 150 nautical miles or less of open water
 *   between the two territorial seas; a bridge, tunnel or ferry corridor with
 *   regular traffic; or a shared, contested maritime boundary where an
 *   incident on one side is routinely news on the other. Each pair carries a
 *   one-line reason. Keep the list short; add pairs only with a reason.
 *
 * Editorial choices:
 * - Every code must be a key of shared/iso2-to-iso3.json.
 * - Kosovo (XK) and Palestine (PS) are included with their land neighbours.
 * - Territories with their own code are included where they have a land
 *   border: HK and MO (CN), GI (ES), MF and SX (Saint Martin).
 * - Excluded: Antarctica (AQ) and uninhabited territories; French Guiana's
 *   borders with BR and SR (GF has no code here, and FR-BR would be
 *   misleading); the UK Sovereign Base Areas on Cyprus; the US base at
 *   Guantanamo Bay (CU-US is a sea pair instead); the Canada-Greenland line on
 *   Hans Island.
 *
 * Symmetry holds by construction: COUNTRY_ADJACENCY is derived from the
 * unordered pairs at module load. A pair appears in one list only.
 */

export type CountryPair = readonly [string, string];

/** Land borders, one entry per unordered pair, sorted by first code. */
export const LAND_BORDER_PAIRS: readonly CountryPair[] = [
  ['AD', 'ES'], ['AD', 'FR'],
  ['AE', 'OM'], ['AE', 'SA'],
  ['AF', 'CN'], ['AF', 'IR'], ['AF', 'PK'], ['AF', 'TJ'], ['AF', 'TM'], ['AF', 'UZ'],
  ['AL', 'GR'], ['AL', 'ME'], ['AL', 'MK'], ['AL', 'XK'],
  ['AM', 'AZ'], ['AM', 'GE'], ['AM', 'IR'], ['AM', 'TR'],
  ['AO', 'CD'], ['AO', 'CG'], ['AO', 'NA'], ['AO', 'ZM'],
  ['AR', 'BO'], ['AR', 'BR'], ['AR', 'CL'], ['AR', 'PY'], ['AR', 'UY'],
  ['AT', 'CH'], ['AT', 'CZ'], ['AT', 'DE'], ['AT', 'HU'], ['AT', 'IT'], ['AT', 'LI'], ['AT', 'SI'], ['AT', 'SK'],
  ['AZ', 'GE'], ['AZ', 'IR'], ['AZ', 'RU'], ['AZ', 'TR'],
  ['BA', 'HR'], ['BA', 'ME'], ['BA', 'RS'],
  ['BD', 'IN'], ['BD', 'MM'],
  ['BE', 'DE'], ['BE', 'FR'], ['BE', 'LU'], ['BE', 'NL'],
  ['BF', 'BJ'], ['BF', 'CI'], ['BF', 'GH'], ['BF', 'ML'], ['BF', 'NE'], ['BF', 'TG'],
  ['BG', 'GR'], ['BG', 'MK'], ['BG', 'RO'], ['BG', 'RS'], ['BG', 'TR'],
  ['BI', 'CD'], ['BI', 'RW'], ['BI', 'TZ'],
  ['BJ', 'NE'], ['BJ', 'NG'], ['BJ', 'TG'],
  ['BN', 'MY'],
  ['BO', 'BR'], ['BO', 'CL'], ['BO', 'PE'], ['BO', 'PY'],
  ['BR', 'CO'], ['BR', 'GY'], ['BR', 'PE'], ['BR', 'PY'], ['BR', 'SR'], ['BR', 'UY'], ['BR', 'VE'],
  ['BT', 'CN'], ['BT', 'IN'],
  ['BW', 'NA'], ['BW', 'ZA'], ['BW', 'ZM'], ['BW', 'ZW'],
  ['BY', 'LT'], ['BY', 'LV'], ['BY', 'PL'], ['BY', 'RU'], ['BY', 'UA'],
  ['BZ', 'GT'], ['BZ', 'MX'],
  ['CA', 'US'],
  ['CD', 'CF'], ['CD', 'CG'], ['CD', 'RW'], ['CD', 'SS'], ['CD', 'TZ'], ['CD', 'UG'], ['CD', 'ZM'],
  ['CF', 'CG'], ['CF', 'CM'], ['CF', 'SD'], ['CF', 'SS'], ['CF', 'TD'],
  ['CG', 'CM'], ['CG', 'GA'],
  ['CH', 'DE'], ['CH', 'FR'], ['CH', 'IT'], ['CH', 'LI'],
  ['CI', 'GH'], ['CI', 'GN'], ['CI', 'LR'], ['CI', 'ML'],
  ['CL', 'PE'],
  ['CM', 'GA'], ['CM', 'GQ'], ['CM', 'NG'], ['CM', 'TD'],
  ['CN', 'HK'], ['CN', 'IN'], ['CN', 'KG'], ['CN', 'KP'], ['CN', 'KZ'], ['CN', 'LA'], ['CN', 'MM'], ['CN', 'MN'], ['CN', 'MO'], ['CN', 'NP'], ['CN', 'PK'], ['CN', 'RU'], ['CN', 'TJ'], ['CN', 'VN'],
  ['CO', 'EC'], ['CO', 'PA'], ['CO', 'PE'], ['CO', 'VE'],
  ['CR', 'NI'], ['CR', 'PA'],
  ['CZ', 'DE'], ['CZ', 'PL'], ['CZ', 'SK'],
  ['DE', 'DK'], ['DE', 'FR'], ['DE', 'LU'], ['DE', 'NL'], ['DE', 'PL'],
  ['DJ', 'ER'], ['DJ', 'ET'], ['DJ', 'SO'],
  ['DO', 'HT'],
  ['DZ', 'EH'], ['DZ', 'LY'], ['DZ', 'MA'], ['DZ', 'ML'], ['DZ', 'MR'], ['DZ', 'NE'], ['DZ', 'TN'],
  ['EC', 'PE'],
  ['EE', 'LV'], ['EE', 'RU'],
  ['EG', 'IL'], ['EG', 'LY'], ['EG', 'PS'], ['EG', 'SD'],
  ['EH', 'MA'], ['EH', 'MR'],
  ['ER', 'ET'], ['ER', 'SD'],
  ['ES', 'FR'], ['ES', 'GI'], ['ES', 'MA'], ['ES', 'PT'],
  ['ET', 'KE'], ['ET', 'SD'], ['ET', 'SO'], ['ET', 'SS'],
  ['FI', 'NO'], ['FI', 'RU'], ['FI', 'SE'],
  ['FR', 'IT'], ['FR', 'LU'], ['FR', 'MC'],
  ['GA', 'GQ'],
  ['GB', 'IE'],
  ['GE', 'RU'], ['GE', 'TR'],
  ['GH', 'TG'],
  ['GM', 'SN'],
  ['GN', 'GW'], ['GN', 'LR'], ['GN', 'ML'], ['GN', 'SL'], ['GN', 'SN'],
  ['GR', 'MK'], ['GR', 'TR'],
  ['GT', 'HN'], ['GT', 'MX'], ['GT', 'SV'],
  ['GW', 'SN'],
  ['GY', 'SR'], ['GY', 'VE'],
  ['HN', 'NI'], ['HN', 'SV'],
  ['HR', 'HU'], ['HR', 'ME'], ['HR', 'RS'], ['HR', 'SI'],
  ['HU', 'RO'], ['HU', 'RS'], ['HU', 'SI'], ['HU', 'SK'], ['HU', 'UA'],
  ['ID', 'MY'], ['ID', 'PG'], ['ID', 'TL'],
  ['IL', 'JO'], ['IL', 'LB'], ['IL', 'PS'], ['IL', 'SY'],
  ['IN', 'MM'], ['IN', 'NP'], ['IN', 'PK'],
  ['IQ', 'IR'], ['IQ', 'JO'], ['IQ', 'KW'], ['IQ', 'SA'], ['IQ', 'SY'], ['IQ', 'TR'],
  ['IR', 'PK'], ['IR', 'TM'], ['IR', 'TR'],
  ['IT', 'SI'], ['IT', 'SM'], ['IT', 'VA'],
  ['JO', 'PS'], ['JO', 'SA'], ['JO', 'SY'],
  ['KE', 'SO'], ['KE', 'SS'], ['KE', 'TZ'], ['KE', 'UG'],
  ['KG', 'KZ'], ['KG', 'TJ'], ['KG', 'UZ'],
  ['KH', 'LA'], ['KH', 'TH'], ['KH', 'VN'],
  ['KP', 'KR'], ['KP', 'RU'],
  ['KW', 'SA'],
  ['KZ', 'RU'], ['KZ', 'TM'], ['KZ', 'UZ'],
  ['LA', 'MM'], ['LA', 'TH'], ['LA', 'VN'],
  ['LB', 'SY'],
  ['LR', 'SL'],
  ['LS', 'ZA'],
  ['LT', 'LV'], ['LT', 'PL'], ['LT', 'RU'],
  ['LV', 'RU'],
  ['LY', 'NE'], ['LY', 'SD'], ['LY', 'TD'], ['LY', 'TN'],
  ['MD', 'RO'], ['MD', 'UA'],
  ['ME', 'RS'], ['ME', 'XK'],
  ['MF', 'SX'],
  ['MK', 'RS'], ['MK', 'XK'],
  ['ML', 'MR'], ['ML', 'NE'], ['ML', 'SN'],
  ['MM', 'TH'],
  ['MN', 'RU'],
  ['MR', 'SN'],
  ['MW', 'MZ'], ['MW', 'TZ'], ['MW', 'ZM'],
  ['MX', 'US'],
  ['MY', 'TH'],
  ['MZ', 'SZ'], ['MZ', 'TZ'], ['MZ', 'ZA'], ['MZ', 'ZM'], ['MZ', 'ZW'],
  ['NA', 'ZA'], ['NA', 'ZM'],
  ['NE', 'NG'], ['NE', 'TD'],
  ['NG', 'TD'],
  ['NO', 'RU'], ['NO', 'SE'],
  ['OM', 'SA'], ['OM', 'YE'],
  ['PL', 'RU'], ['PL', 'SK'], ['PL', 'UA'],
  ['QA', 'SA'],
  ['RO', 'RS'], ['RO', 'UA'],
  ['RS', 'XK'],
  ['RU', 'UA'],
  ['RW', 'TZ'], ['RW', 'UG'],
  ['SA', 'YE'],
  ['SD', 'SS'], ['SD', 'TD'],
  ['SK', 'UA'],
  ['SS', 'UG'],
  ['SY', 'TR'],
  ['SZ', 'ZA'],
  ['TJ', 'UZ'],
  ['TM', 'UZ'],
  ['TZ', 'UG'], ['TZ', 'ZM'],
  ['ZA', 'ZW'],
  ['ZM', 'ZW'],];

/** Close sea neighbours (editorial; see header for the criterion). */
export const SEA_NEIGHBOUR_PAIRS: readonly CountryPair[] = [
  // Southeast Asia
  ['ID', 'SG'], // Singapore Strait; Batam and Bintan ferries
  ['MY', 'SG'], // Johor Causeway and Second Link bridges
  ['MY', 'PH'], // Sulu Sea between Sabah and Tawi-Tawi
  ['ID', 'PH'], // Celebes Sea between Sangihe and Mindanao
  ['AU', 'ID'], // Timor and Arafura Seas; Ashmore Reef lies off Rote
  ['AU', 'PG'], // Torres Strait
  ['PH', 'TW'], // Luzon Strait between Batanes and Orchid Island
  ['PH', 'VN'], // South China Sea; overlapping Spratly claims
  ['CN', 'PH'], // South China Sea; Scarborough Shoal and Spratly confrontations
  ['CN', 'TW'], // Taiwan Strait
  ['JP', 'TW'], // Yonaguni lies about 60 nm off Taiwan
  // Northeast Asia and the Pacific rim
  ['JP', 'KR'], // Korea (Tsushima) Strait; Busan-Fukuoka ferries
  ['JP', 'RU'], // La Perouse Strait and the Kuril Islands dispute
  ['CN', 'KR'], // Yellow Sea; Shandong-Incheon ferries
  ['RU', 'US'], // Bering Strait
  // South Asia
  ['IN', 'LK'], // Palk Strait
  // Gulf and Red Sea
  ['CN', 'JP'], // East China Sea; contested maritime boundary (Senkaku/Diaoyu)
  ['IR', 'KW'], // Northern Gulf; contested Durra/Arash gas field boundary
  ['AE', 'IR'], // Strait of Hormuz; Dubai-Bandar Abbas ferries
  ['IR', 'OM'], // Strait of Hormuz at Musandam
  ['IR', 'QA'], // shared South Pars / North Dome gas field boundary
  ['BH', 'SA'], // King Fahd Causeway
  ['BH', 'QA'], // about 25 km apart; Hawar Islands
  ['EG', 'SA'], // Strait of Tiran
  ['EG', 'JO'], // Gulf of Aqaba; Nuweiba-Aqaba ferry
  ['SA', 'SD'], // Red Sea; Jeddah-Port Sudan ferry
  ['DJ', 'YE'], // Bab-el-Mandeb
  ['ER', 'YE'], // southern Red Sea; Hanish Islands
  ['SO', 'YE'], // Gulf of Aden
  // Caspian
  ['AZ', 'KZ'], // Baku-Aktau ferry
  ['AZ', 'TM'], // Baku-Turkmenbashi ferry
  // Mediterranean and Europe
  ['CY', 'TR'], // about 40 nm
  ['CY', 'SY'], // about 60 nm
  ['CY', 'LB'], // about 100 nm; Larnaca evacuation corridor
  ['IT', 'MT'], // Malta-Sicily ferry
  ['LY', 'MT'], // central Mediterranean; delimited continental shelf boundary
  ['IT', 'TN'], // Strait of Sicily; Pantelleria and Lampedusa
  ['AL', 'IT'], // Strait of Otranto ferries
  ['GR', 'IT'], // Ionian ferries
  ['DZ', 'ES'], // Almeria-Oran ferries
  ['GI', 'MA'], // Strait of Gibraltar
  ['FR', 'GB'], // Channel Tunnel and Dover Strait
  ['DK', 'SE'], // Oresund Bridge
  ['DK', 'NO'], // Skagerrak ferries
  ['EE', 'FI'], // Tallinn-Helsinki ferries
  // Africa (Atlantic)
  ['GQ', 'NG'], // Bioko (Equatorial Guinea) is within ~150 nm of the Niger Delta coast
  // Caribbean
  ['CU', 'US'], // Florida Straits
  ['BS', 'US'], // Bimini lies about 50 nm off Florida
  ['BS', 'CU'], // Old Bahama Channel
  ['BS', 'TC'], // same archipelago
  ['CU', 'MX'], // Yucatan Channel
  ['CU', 'JM'], // Cayman Trench crossing, about 80 nm
  ['CU', 'HT'], // Windward Passage
  ['DO', 'PR'], // Mona Passage
  ['PR', 'VI'], // Virgin Passage
  ['VG', 'VI'], // Sir Francis Drake Channel
  ['AI', 'MF'], // Anguilla Channel ferries
  ['AG', 'KN'], // about 50 nm
  ['LC', 'VC'], // Saint Vincent Passage
  ['GD', 'VC'], // Grenadines ferries
  ['GD', 'TT'], // about 80 nm
  ['TT', 'VE'], // Gulf of Paria, about 7 nm
  ['AW', 'VE'], // about 15 nm
  ['CW', 'VE'], // about 40 nm
];

function buildAdjacency(): Readonly<Record<string, readonly string[]>> {
  const sets = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = sets.get(a);
    if (!set) sets.set(a, (set = new Set()));
    set.add(b);
  };
  for (const [a, b] of [...LAND_BORDER_PAIRS, ...SEA_NEIGHBOUR_PAIRS]) {
    if (a === b) continue;
    link(a, b);
    link(b, a);
  }
  const out: Record<string, readonly string[]> = {};
  for (const code of [...sets.keys()].sort()) {
    out[code] = Object.freeze([...sets.get(code)!].sort());
  }
  return Object.freeze(out);
}

/** Symmetric neighbour table (land and sea), sorted, no self-pairs. */
export const COUNTRY_ADJACENCY: Readonly<Record<string, readonly string[]>> = buildAdjacency();

const EMPTY: readonly string[] = Object.freeze([]);

/** Land and sea neighbours of a country; [] for unknown or isolated codes. */
export function neighboursOf(iso2: string): readonly string[] {
  const code = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
  return Object.prototype.hasOwnProperty.call(COUNTRY_ADJACENCY, code) ? COUNTRY_ADJACENCY[code]! : EMPTY;
}
