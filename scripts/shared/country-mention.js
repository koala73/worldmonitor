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
// - Weak names (AMBIGUOUS_COUNTRY_TERMS) count beside a co-term, or alone
//   when written as a proper noun that is not part of a person's name.
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

// Exclusions removed only as whole phrases. A prefix removal would let
// "niger state" swallow "Niger states it will reopen the border".
const WHOLE_WORD_EXCLUSIONS = {
  NE: ['niger state', 'niger delta'],
};

// Names that are also common words, people, US states or neighbours' names
// (#11189). Forecast subject matching (scripts/build-judged-subject-terms.mjs)
// counts a weak name only beside a co-term. Headlines name most countries
// without one ("Turkey arrests fund managers", "Jordan banks won't raise
// rates"), so here a weak name also counts alone when a mention of it is
// capitalized ("turkey farm" is not Turkey) and, for a name that is also a
// first name (`firstName`), does not sit next to another capitalized word
// ("Jordan Hawkins", "Chad Gable", "Jim Jordan"). The name-shape test is
// limited to first names because on Georgia and Niger it dropped more real
// stories than homonyms in the weekly pulse snapshots.
export const AMBIGUOUS_COUNTRY_TERMS = {
  GE: { weak: ['georgia', 'georgian'], co: ['tbilisi', 'caucasus', 'abkhazia', 'ossetia', 'georgian dream', 'kobakhidze', 'ivanishvili', 'batumi', 'kremlin', 'moscow', 'ukraine', 'crimea', 'eu', 'nato'] },
  JO: { firstName: true, weak: ['jordan'], co: ['amman', 'hashemite', 'king abdullah', 'israel', 'israeli', 'gaza', 'west bank', 'syria', 'iraq', 'middle east', 'palestinian'] },
  TD: { firstName: true, weak: ['chad'], co: ['ndjamena', 'n djamena', 'sahel', 'darfur', 'sudan', 'sudanese', 'deby', 'africa', 'african', 'nigeria', 'cameroon', 'lake chad'] },
  NE: { weak: ['niger'], co: ['niamey', 'sahel', 'tiani', 'junta', 'mali', 'burkina', 'ecowas', 'africa', 'african'] },
  TR: { weak: ['turkey'], co: ['ankara', 'erdogan', 'istanbul', 'kurdish', 'pkk', 'syria', 'nato', 'lira', 'turkiye'] },
  CG: { weak: ['congo'], co: ['brazzaville', 'sassou'] },
  CD: { weak: ['congo'], co: ['kinshasa', 'goma', 'kivu', 'ituri', 'm23', 'tshisekedi', 'ebola', 'drc', 'rwanda'] },
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

const CJK_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const KATAKANA_RUN = /[\p{Script=Katakana}ー]/u;

/**
 * Normalizes headline text for localized matching. Japanese and Chinese keep
 * every mark (stripping the prolonged sound mark turns スーダン into スタン,
 * which sits inside パキスタン); other scripts use normalizeMentionText.
 */
function normalizeLocalizedText(text) {
  const value = String(text || '');
  if (CJK_SCRIPT.test(value)) return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return normalizeMentionText(value);
}

function icuRegionNames(code, lang) {
  const names = new Set();
  for (const style of ['long', 'short']) {
    try {
      const name = new Intl.DisplayNames([lang], { type: 'region', style }).of(code);
      if (!name || name.toUpperCase() === code) continue;
      const text = normalizeLocalizedText(name);
      if (style === 'short' && [...text.replace(/\s/g, '')].length < (CJK_SCRIPT.test(text) ? 2 : 4)) continue;
      if (text) names.add(text);
    } catch {
      /* Intl.DisplayNames can be missing in constrained runtimes. */
    }
  }
  return [...names];
}

const regionNamesByLanguage = new Map();

/** Every ICU region name in one language, so a short name is never credited inside a longer one. */
function allRegionNames(lang) {
  if (!regionNamesByLanguage.has(lang)) {
    const names = new Set();
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        for (const name of icuRegionNames(String.fromCharCode(a, b), lang)) names.add(name);
      }
    }
    regionNamesByLanguage.set(lang, [...names]);
  }
  return regionNamesByLanguage.get(lang);
}

/**
 * The country's ICU names in one language, normalized, or [] for English
 * (covered by countryMentionTerms) and when ICU has no name. The short style
 * is kept only when it is a real name of 4+ letters (2+ characters in CJK):
 * ICU short forms are often abbreviations ("RU" for the United Kingdom in
 * Spanish) that would match unrelated words.
 */
export function localizedCountryNames(code, language) {
  const normalized = String(code || '').trim().toUpperCase();
  const lang = String(language || '').trim().toLowerCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !/^[a-z]{2,3}$/.test(lang) || lang === 'en') return [];
  return icuRegionNames(normalized, lang);
}

/**
 * True when the text names the country in its own language. A spaced-script
 * name must stand as a whole word; a Japanese name must not sit inside a
 * longer katakana run (タイ in タイトル); and in every script a match is
 * dropped when a longer region name covers it (南スーダン, Южный Судан,
 * 印度尼西亚 for 印度).
 */
export function mentionsLocalizedCountry(rawText, names, language) {
  if (!names || names.length === 0) return false;
  const lang = String(language || '').trim().toLowerCase();
  const text = normalizeLocalizedText(rawText);
  const unspaced = ['zh', 'ja'].includes(lang);
  const wordChar = /[\p{L}\p{N}]/u;
  const longer = allRegionNames(lang)
    .filter((other) => !names.includes(other) && names.some((name) => other.length > name.length && other.includes(name)));
  const covered = (at, length) => longer.some((other) => {
    for (let start = text.indexOf(other); start !== -1; start = text.indexOf(other, start + 1)) {
      if (at >= start && at + length <= start + other.length) return true;
    }
    return false;
  });
  return names.some((name) => {
    if (!name) return false;
    for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
      const before = text[at - 1] || '';
      const after = text[at + name.length] || '';
      const bounded = !unspaced
        ? !wordChar.test(before) && !wordChar.test(after)
        : lang !== 'ja' || (!KATAKANA_RUN.test(before) && !KATAKANA_RUN.test(after));
      if (bounded && !covered(at, name.length)) return true;
    }
    return false;
  });
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
  const ambiguous = AMBIGUOUS_COUNTRY_TERMS[normalizedCode];
  return {
    code: normalizedCode,
    names: [...names],
    weakNames: [...names].filter((name) => ambiguous?.weak.includes(name)),
    weakFirstName: Boolean(ambiguous?.firstName),
    coTerms: [...(ambiguous?.co || [])],
    demonyms: [...(DEMONYMS[normalizedCode] || [])],
    exclusions: [...(NAME_EXCLUSIONS[normalizedCode] || [])],
    wordExclusions: [...(WHOLE_WORD_EXCLUSIONS[normalizedCode] || [])],
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
// blanks the start of "South Sudanese", and "guinea bissau" the start of
// "Guinea-Bissauan", which is the point. Whole-word exclusions are the
// exception and must end on a word boundary.
function scrubNormalizedExclusions(normalizedText, exclusions, wordExclusions = []) {
  let out = normalizedText;
  for (const phrase of exclusions) {
    if (phrase) out = out.split(phrase).join(' ');
  }
  for (const phrase of wordExclusions) {
    if (phrase) out = out.replace(new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}(?=$|[^a-z0-9])`, 'g'), '$1 ');
  }
  return out;
}

function scrubRawExclusions(rawText, exclusions, wordExclusions = []) {
  let out = rawText;
  const pattern = phrase => String(phrase || '').trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join('[\\s-]+');
  for (const phrase of exclusions) {
    const source = pattern(phrase);
    if (source) out = out.replace(new RegExp(source, 'gi'), ' ');
  }
  for (const phrase of wordExclusions) {
    const source = pattern(phrase);
    if (source) out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${source}(?=$|[^A-Za-z0-9])`, 'gi'), '$1 ');
  }
  return out;
}

/** True when the raw text (title + snippet) mentions the country described by `terms`. */
export function mentionsCountry(rawText, terms) {
  if (!terms) return false;
  const exclusions = terms.exclusions || [];
  const wordExclusions = terms.wordExclusions || [];
  const text = scrubRawExclusions(String(rawText || ''), exclusions, wordExclusions);
  if (!text.trim()) return false;
  const normalized = scrubNormalizedExclusions(normalizeMentionText(String(rawText || '')), exclusions, wordExclusions);
  const weakNames = terms.weakNames || [];
  for (const name of terms.names || []) {
    if (!name || weakNames.includes(name)) continue;
    if (matchesNormalizedWord(normalized, name)) return true;
  }
  for (const demonym of terms.demonyms || []) {
    if (demonym && matchesCasedToken(text, demonym)) return true;
  }
  if (CODE_TOKEN_ALLOWLIST.has(terms.code) && matchesCasedToken(text, terms.code)) return true;
  return weakNames.some((name) => matchesNormalizedWord(normalized, name)
    && ((terms.coTerms || []).some((term) => matchesNormalizedWord(normalized, term))
      || standsAlone(text, name, Boolean(terms.weakFirstName))));
}

const CAPITALIZED = /^\p{Lu}\p{Ll}/u;
const ALL_CAPS = /^\p{Lu}+$/u;

// One mention of the weak name, on diacritic-stripped raw text, is written as
// a proper noun and, for a first name, is not part of a two-word name. One is
// enough: a Jordan Times story ends "- Jordan Times". A possessive ends the
// name ("Jordan's Karak province"); punctuation between two words does too
// ("Qatar, Jordan, Egypt"). All caps counts only for a name that is not a
// first name: "TURKEY raises rates" is the country, "CHAD" is a token ticker.
function standsAlone(rawText, name, firstName) {
  const text = rawText.normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/\s+/gu, ' ');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(name)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(pattern)].some((match) => {
    const at = match.index + match[1].length;
    const word = match[2];
    if (!firstName) return CAPITALIZED.test(word) || ALL_CAPS.test(word);
    if (!CAPITALIZED.test(word)) return false;
    const previous = text.slice(0, at).match(/(\S+) $/)?.[1];
    if (previous && CAPITALIZED.test(previous) && /\p{L}$/u.test(previous)) return false;
    const after = text.slice(at + word.length);
    if (/^['’]s(?![\p{L}\p{N}])/u.test(after)) return true;
    const next = after.match(/^ (\S+)/)?.[1];
    return !(next && CAPITALIZED.test(next));
  });
}
