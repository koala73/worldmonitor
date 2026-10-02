// One country-mention matcher for every surface that grounds a country brief
// on the news digest: the server's shared anonymous grounding
// (server/worldmonitor/intelligence/v1/_country-brief-context.ts), the MCP
// get_country_brief tool (api/mcp/registry/rpc-tools.ts) and the crawlable
// corpus freeze (scripts/freeze-crawlable-live-pulse.mjs).
//
// Why one module (#7748): three hand-copied matchers drifted, and the copy
// that publishes to crawlers was the loosest. Bare ISO-code tokens grounded
// Australia's brief on "African Union (AU)", Ethiopia's on an outage timed
// "2pm ET", Togo's and Bolivia's on unrelated stories, and the MCP copy still
// matched the code case-insensitively ("rally in Europe" -> India). Display
// names alone miss most of the corpus: ICU renders "Myanmar (Burma)",
// "Congo - Kinshasa" and "Côte d'Ivoire", none of which appear verbatim in a
// headline, and news leans on demonyms ("Kazakh elections", "Lithuanian
// parliament") that a name match never sees.
//
// Rules:
// - Display names, aliases and exclusions match on NORMALIZED text (NFKD,
//   diacritics stripped, lowercased, punctuation collapsed) on word
//   boundaries, so "Côte d'Ivoire", "Cote d'Ivoire" and "Ivory Coast" all
//   reach CI.
// - Demonyms match CASE-SENSITIVELY on the raw text: "Polish" is a country,
//   "polish" is a verb; "Thai" is a country, "thai" is a cuisine.
// - Bare ISO codes match only for CODE_TOKEN_ALLOWLIST, as uppercase tokens.
//   Every other two-letter code is either an English word (IN, NO, IT, BE) or
//   an acronym in someone else's story (AU, CM, GM, TV, ET, EC).
// - Exclusion phrases are removed before the name match so "South Sudan"
//   never grounds Sudan, "Papua New Guinea" never grounds Guinea and
//   "Northern Ireland" never grounds Ireland.
//
// Plain ESM JavaScript on purpose: the freeze runs under bare `node` with no
// TypeScript loader, and the server bundles this into an edge function.

/** ISO codes that appear as bare uppercase tokens in ordinary English news. */
export const CODE_TOKEN_ALLOWLIST = new Set(['US']);

// Names ICU renders in a form no headline uses, replaced wholesale.
const NAME_OVERRIDES = {
  AG: ['antigua and barbuda', 'antigua'],
  BA: ['bosnia and herzegovina', 'bosnia'],
  CD: ['democratic republic of the congo', 'democratic republic of congo', 'dr congo', 'drc', 'congo kinshasa'],
  CG: ['republic of the congo', 'republic of congo', 'congo brazzaville'],
  HK: ['hong kong'],
  KN: ['saint kitts and nevis', 'st kitts and nevis', 'saint kitts', 'st kitts'],
  LC: ['saint lucia', 'st lucia'],
  MM: ['myanmar', 'burma'],
  MO: ['macao', 'macau'],
  PS: ['palestinian territories', 'palestine', 'gaza', 'west bank'],
  ST: ['sao tome and principe', 'sao tome'],
  TT: ['trinidad and tobago', 'trinidad'],
  VA: ['vatican city', 'vatican', 'holy see'],
  VC: ['saint vincent and the grenadines', 'st vincent and the grenadines', 'saint vincent', 'st vincent'],
};

// Aliases added to the display name. Normalized form (lowercase, no
// diacritics, punctuation as spaces) — see normalizeMentionText.
const NAME_ALIASES = {
  AE: ['uae', 'emirates'],
  BN: ['brunei darussalam'],
  CI: ['ivory coast'],
  CV: ['cabo verde'],
  CZ: ['czech republic'],
  FM: ['federated states of micronesia'],
  GB: ['uk', 'britain', 'great britain'],
  KP: ['dprk', 'democratic people s republic of korea'],
  KR: ['republic of korea'],
  NL: ['holland'],
  RU: ['russian federation'],
  SZ: ['swaziland'],
  TC: ['turks and caicos'],
  TL: ['east timor', 'timor leste'],
  TR: ['turkey', 'turkiye'],
  US: ['usa', 'u s', 'united states of america'],
};

// Phrases that contain a country name or demonym but belong to someone else.
// Scrubbed from the text (case-insensitively, as a prefix) before that
// country's names and demonyms are tested, so "South Sudanese" never reaches
// Sudan's "Sudanese" and "Northern Irish" never reaches Ireland's "Irish".
const NAME_EXCLUSIONS = {
  CG: ['democratic republic of the congo', 'democratic republic of congo'],
  FR: ['french open', 'french polynesia', 'french guiana'],
  GB: ['british columbia', 'british virgin islands'],
  GN: ['equatorial guinea', 'papua new guinea', 'guinea bissau'],
  IE: ['northern ireland', 'northern irish'],
  IN: ['indian ocean'],
  KR: ['democratic people s republic of korea'],
  MX: ['new mexico'],
  NL: ['holland america'],
  SD: ['south sudan'],
  TR: ['turks and caicos'],
  WS: ['american samoa'],
};

// Demonyms as they are written: capitalized, matched case-sensitively.
// Ambiguous ones are deliberately absent — "American" (Latin American),
// "Congolese" (CD or CG), "Dominican" (DM or DO), "Guinean" (four states),
// "Korean" (KR or KP), "Georgian" (GE or the US state), "Macedonian".
const DEMONYMS = {
  AF: ['Afghan', 'Afghans'], AL: ['Albanian', 'Albanians'], DZ: ['Algerian', 'Algerians'], AD: ['Andorran'],
  AO: ['Angolan', 'Angolans'], AR: ['Argentine', 'Argentinian', 'Argentinians'], AM: ['Armenian', 'Armenians'],
  AU: ['Australian', 'Australians'], AT: ['Austrian', 'Austrians'], AZ: ['Azerbaijani', 'Azeri'], BS: ['Bahamian'],
  BH: ['Bahraini'], BD: ['Bangladeshi', 'Bangladeshis'], BB: ['Barbadian'], BY: ['Belarusian', 'Belarusians'],
  BE: ['Belgian', 'Belgians'], BZ: ['Belizean'], BJ: ['Beninese'], BT: ['Bhutanese'], BO: ['Bolivian', 'Bolivians'],
  BA: ['Bosnian', 'Bosnians'], BW: ['Botswanan', 'Batswana', 'Motswana'], BR: ['Brazilian', 'Brazilians'],
  BN: ['Bruneian'], BG: ['Bulgarian', 'Bulgarians'], BF: ['Burkinabe', 'Burkinabè'], BI: ['Burundian', 'Burundians'],
  KH: ['Cambodian', 'Cambodians'], CM: ['Cameroonian', 'Cameroonians'], CA: ['Canadian', 'Canadians'],
  CV: ['Cape Verdean'], TD: ['Chadian', 'Chadians'], CL: ['Chilean', 'Chileans'], CN: ['Chinese'],
  CO: ['Colombian', 'Colombians'], KM: ['Comorian', 'Comoran'], CR: ['Costa Rican', 'Costa Ricans'],
  CI: ['Ivorian', 'Ivorians'], HR: ['Croatian', 'Croatians', 'Croat', 'Croats'], CU: ['Cuban', 'Cubans'],
  CY: ['Cypriot', 'Cypriots'], CZ: ['Czech', 'Czechs'], DK: ['Danish', 'Dane', 'Danes'], DJ: ['Djiboutian'],
  EC: ['Ecuadorian', 'Ecuadorean', 'Ecuadorians'], EG: ['Egyptian', 'Egyptians'],
  SV: ['Salvadoran', 'Salvadorean', 'Salvadorans'], GQ: ['Equatoguinean', 'Equatorial Guinean'],
  ER: ['Eritrean', 'Eritreans'], EE: ['Estonian', 'Estonians'], SZ: ['Swazi'], ET: ['Ethiopian', 'Ethiopians'],
  FJ: ['Fijian', 'Fijians'], FI: ['Finnish', 'Finn', 'Finns'], FR: ['French'], GA: ['Gabonese'],
  GM: ['Gambian', 'Gambians'], DE: ['German', 'Germans'], GH: ['Ghanaian', 'Ghanaians'], GR: ['Greek', 'Greeks'],
  GD: ['Grenadian'], GT: ['Guatemalan', 'Guatemalans'], GY: ['Guyanese'], HT: ['Haitian', 'Haitians'],
  HN: ['Honduran', 'Hondurans'], HU: ['Hungarian', 'Hungarians'], IS: ['Icelandic', 'Icelander', 'Icelanders'],
  IN: ['Indian', 'Indians'], ID: ['Indonesian', 'Indonesians'], IR: ['Iranian', 'Iranians'], IQ: ['Iraqi', 'Iraqis'],
  IE: ['Irish'], IL: ['Israeli', 'Israelis'], IT: ['Italian', 'Italians'], JM: ['Jamaican', 'Jamaicans'],
  JP: ['Japanese'], JO: ['Jordanian', 'Jordanians'], KZ: ['Kazakh', 'Kazakhs', 'Kazakhstani'],
  KE: ['Kenyan', 'Kenyans'], KP: ['North Korean', 'North Koreans'], KR: ['South Korean', 'South Koreans'],
  KW: ['Kuwaiti', 'Kuwaitis'], KG: ['Kyrgyz'], LA: ['Laotian', 'Laotians'], LV: ['Latvian', 'Latvians'],
  LB: ['Lebanese'], LS: ['Basotho', 'Mosotho'], LR: ['Liberian', 'Liberians'], LY: ['Libyan', 'Libyans'],
  LI: ['Liechtensteiner'], LT: ['Lithuanian', 'Lithuanians'], LU: ['Luxembourgish', 'Luxembourger', 'Luxembourgers'],
  MG: ['Malagasy'], MW: ['Malawian', 'Malawians'], MY: ['Malaysian', 'Malaysians'], MV: ['Maldivian', 'Maldivians'],
  ML: ['Malian', 'Malians'], MT: ['Maltese'], MH: ['Marshallese'], MR: ['Mauritanian', 'Mauritanians'],
  MU: ['Mauritian', 'Mauritians'], MX: ['Mexican', 'Mexicans'], MD: ['Moldovan', 'Moldovans'],
  MC: ['Monegasque', 'Monacan'], MN: ['Mongolian', 'Mongolians'], ME: ['Montenegrin', 'Montenegrins'],
  MA: ['Moroccan', 'Moroccans'], MZ: ['Mozambican', 'Mozambicans'], MM: ['Burmese'], NA: ['Namibian', 'Namibians'],
  NR: ['Nauruan'], NP: ['Nepali', 'Nepalese', 'Nepalis'], NL: ['Dutch'], NZ: ['New Zealander', 'New Zealanders'],
  NI: ['Nicaraguan', 'Nicaraguans'], NE: ['Nigerien', 'Nigeriens'], NG: ['Nigerian', 'Nigerians'],
  NO: ['Norwegian', 'Norwegians'], OM: ['Omani', 'Omanis'], PK: ['Pakistani', 'Pakistanis'], PW: ['Palauan'],
  PA: ['Panamanian', 'Panamanians'], PG: ['Papua New Guinean'], PY: ['Paraguayan', 'Paraguayans'],
  PE: ['Peruvian', 'Peruvians'], PH: ['Filipino', 'Filipinos', 'Philippine'], PL: ['Polish'], PT: ['Portuguese'],
  QA: ['Qatari', 'Qataris'], RO: ['Romanian', 'Romanians'], RU: ['Russian', 'Russians'], RW: ['Rwandan', 'Rwandans'],
  WS: ['Samoan', 'Samoans'], SA: ['Saudi', 'Saudis'], SN: ['Senegalese'], RS: ['Serbian', 'Serbians', 'Serb', 'Serbs'],
  SC: ['Seychellois'], SL: ['Sierra Leonean', 'Sierra Leoneans'], SG: ['Singaporean', 'Singaporeans'],
  SK: ['Slovak', 'Slovaks'], SI: ['Slovenian', 'Slovenians', 'Slovene', 'Slovenes'], SB: ['Solomon Islander'],
  SO: ['Somali', 'Somalis'], ZA: ['South African', 'South Africans'], SS: ['South Sudanese'],
  ES: ['Spanish', 'Spaniard', 'Spaniards'], LK: ['Sri Lankan', 'Sri Lankans'], SD: ['Sudanese'],
  SR: ['Surinamese'], SE: ['Swedish', 'Swede', 'Swedes'], CH: ['Swiss'], SY: ['Syrian', 'Syrians'],
  TW: ['Taiwanese'], TJ: ['Tajik', 'Tajiks'], TZ: ['Tanzanian', 'Tanzanians'], TH: ['Thai', 'Thais'],
  TL: ['Timorese'], TG: ['Togolese'], TO: ['Tongan', 'Tongans'], TT: ['Trinidadian', 'Trinidadians'],
  TN: ['Tunisian', 'Tunisians'], TR: ['Turkish', 'Turk', 'Turks'], TM: ['Turkmen'], TV: ['Tuvaluan'],
  UG: ['Ugandan', 'Ugandans'], UA: ['Ukrainian', 'Ukrainians'], AE: ['Emirati', 'Emiratis'],
  GB: ['British', 'Briton', 'Britons'], UY: ['Uruguayan', 'Uruguayans'], UZ: ['Uzbek', 'Uzbeks'],
  VE: ['Venezuelan', 'Venezuelans'], VN: ['Vietnamese'], YE: ['Yemeni', 'Yemenis'], ZM: ['Zambian', 'Zambians'],
  ZW: ['Zimbabwean', 'Zimbabweans'], XK: ['Kosovar', 'Kosovars', 'Kosovan'], PS: ['Palestinian', 'Palestinians'],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mirrors normalizeCountryToken in shared/country-code-resolve.ts so a
 * headline and an alias land in the same token space: NFKD, diacritics
 * stripped, lowercased, `&` spelled out, the punctuation that splits names
 * (apostrophes, hyphens, dots, parentheses, slashes) turned into spaces.
 */
export function normalizeMentionText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''‘’`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** English display name for an ISO-3166 alpha-2 code, or '' when ICU only echoes the code. */
export function countryDisplayName(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(normalized);
    if (!name || name.toUpperCase() === normalized || name.toLowerCase() === 'unknown region') return '';
    return name;
  } catch {
    /* Intl.DisplayNames can be missing in constrained runtimes. */
    return '';
  }
}

/**
 * Terms one country is recognised by. `names` and `exclusions` are normalized
 * (compare against normalizeMentionText output); `demonyms` are raw-cased.
 */
export function countryMentionTerms(code) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  const names = new Set();
  if (NAME_OVERRIDES[normalizedCode]) {
    for (const name of NAME_OVERRIDES[normalizedCode]) names.add(name);
  } else {
    const display = normalizeMentionText(countryDisplayName(normalizedCode));
    if (display) names.add(display);
  }
  for (const alias of NAME_ALIASES[normalizedCode] || []) names.add(alias);
  return {
    code: normalizedCode,
    names: [...names],
    demonyms: [...(DEMONYMS[normalizedCode] || [])],
    exclusions: [...(NAME_EXCLUSIONS[normalizedCode] || [])],
  };
}

function matchesNormalizedWord(normalizedText, term) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}(?=$|[^a-z0-9])`).test(normalizedText);
}

function matchesCasedToken(rawText, token) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(token)}(?=$|[^A-Za-z0-9])`).test(rawText);
}

// Exclusion phrases are stored normalized, so the name path scrubs them from
// the NORMALIZED text (where "Guinea-Bissau" is already "guinea bissau"), and
// the demonym path scrubs them from the raw text with hyphens and whitespace
// treated alike. Both are prefix matches on purpose: "south sudan" also
// blanks the start of "South Sudanese", which is the point.
function scrubNormalizedExclusions(normalizedText, exclusions) {
  let out = normalizedText;
  for (const phrase of exclusions) {
    if (phrase) out = out.split(phrase).join(' ');
  }
  return out;
}

function scrubRawExclusions(rawText, exclusions) {
  let out = rawText;
  for (const phrase of exclusions) {
    const pattern = String(phrase || '').trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join('[\\s-]+');
    if (pattern) out = out.replace(new RegExp(pattern, 'gi'), ' ');
  }
  return out;
}

/** True when the raw text (title + snippet) mentions the country described by `terms`. */
export function mentionsCountry(rawText, terms) {
  if (!terms) return false;
  const exclusions = terms.exclusions || [];
  const text = scrubRawExclusions(String(rawText || ''), exclusions);
  if (!text.trim()) return false;
  const normalized = scrubNormalizedExclusions(normalizeMentionText(String(rawText || '')), exclusions);
  for (const name of terms.names || []) {
    if (name && matchesNormalizedWord(normalized, name)) return true;
  }
  for (const demonym of terms.demonyms || []) {
    if (demonym && matchesCasedToken(text, demonym)) return true;
  }
  if (CODE_TOKEN_ALLOWLIST.has(terms.code) && matchesCasedToken(text, terms.code)) return true;
  return false;
}
