/**
 * Static gazetteer for the dedup entity veto.
 *
 * Pure data, no network. Loaded once at module init. Small enough to
 * audit in a diff; drift is visible in `git log -- scripts/lib/entity-gazetteer.mjs`.
 *
 * Classification rule used by brief-dedup-embed:
 *   - token ∈ LOCATION_GAZETTEER → Location class
 *   - capitalized token ∉ LOCATION_GAZETTEER ∉ COMMON_CAPITALIZED → Actor class
 *
 * All entries are lowercase; the veto lowercases tokens before lookup.
 *
 * Known heuristic limitation: coreferential pairs (Iran/Tehran, US/Washington,
 * UK/London, Russia/Kremlin) are NOT collapsed — they'd need a name-normaliser
 * which is explicitly out of scope for v1. The resulting false-negative
 * ("same event in different capital-name vocabulary stays separate") is the
 * same class we already tolerate (see plan: "Documented failure classes").
 */

// ── Locations: countries, major cities, regions, bodies of water ───────

const COUNTRIES = [
  // ISO-3166 short names (lowercase). Not exhaustive — top ~80 by wire
  // frequency; add on demand. Full ISO list is cheap to drop in later
  // if we see gaps in the calibration data.
  'afghanistan', 'albania', 'algeria', 'argentina', 'armenia', 'australia',
  'austria', 'azerbaijan', 'bahrain', 'bangladesh', 'belarus', 'belgium',
  'bolivia', 'bosnia', 'brazil', 'bulgaria', 'cambodia', 'cameroon', 'canada',
  'chile', 'china', 'colombia', 'congo', 'croatia', 'cuba', 'cyprus', 'czechia',
  'denmark', 'ecuador', 'egypt', 'eritrea', 'estonia', 'ethiopia', 'finland',
  'france', 'georgia', 'germany', 'ghana', 'greece', 'guatemala', 'haiti',
  'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq',
  'ireland', 'israel', 'italy', 'japan', 'jordan', 'kazakhstan', 'kenya',
  'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'libya', 'lithuania',
  'luxembourg', 'malaysia', 'maldives', 'mali', 'malta', 'mexico', 'moldova',
  'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'nepal',
  'netherlands', 'nicaragua', 'niger', 'nigeria', 'norway', 'oman', 'pakistan',
  'panama', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar',
  'romania', 'russia', 'rwanda', 'serbia', 'singapore', 'slovakia', 'slovenia',
  'somalia', 'spain', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan',
  'tajikistan', 'tanzania', 'thailand', 'tunisia', 'turkey', 'turkmenistan',
  'uganda', 'ukraine', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam',
  'yemen', 'zambia', 'zimbabwe',
  // Common short forms / alternate spellings used in wire headlines.
  'us', 'usa', 'uk', 'uae', 'drc', 'prc', 'rok', 'dprk',
];

const CITIES = [
  // Top ~120 cities by wire-headline frequency. Ordered roughly by
  // region for diff-readability, not alphabetical.
  // North America
  'washington', 'new york', 'los angeles', 'chicago', 'houston', 'miami',
  'atlanta', 'boston', 'seattle', 'philadelphia', 'detroit', 'dallas',
  'ottawa', 'toronto', 'montreal', 'vancouver', 'mexico city', 'havana',
  // Europe
  'london', 'paris', 'berlin', 'brussels', 'amsterdam', 'rome', 'madrid',
  'lisbon', 'dublin', 'vienna', 'prague', 'warsaw', 'budapest', 'athens',
  'stockholm', 'copenhagen', 'oslo', 'helsinki', 'zurich', 'geneva', 'bern',
  'milan', 'naples', 'barcelona', 'munich', 'frankfurt', 'hamburg',
  'edinburgh', 'glasgow', 'manchester', 'belfast',
  // Eastern Europe / Russia
  'moscow', 'st petersburg', 'kyiv', 'kiev', 'odesa', 'odessa', 'kharkiv',
  'lviv', 'mariupol', 'donetsk', 'luhansk', 'minsk', 'chisinau', 'tbilisi',
  'yerevan', 'baku', 'bucharest', 'sofia', 'belgrade', 'zagreb', 'sarajevo',
  'pristina', 'skopje', 'tirana', 'vilnius', 'riga', 'tallinn',
  // Middle East / North Africa
  'tehran', 'baghdad', 'damascus', 'beirut', 'amman', 'riyadh', 'doha',
  'dubai', 'abu dhabi', 'kuwait city', 'muscat', 'manama', 'sanaa', 'aden',
  'jerusalem', 'tel aviv', 'gaza', 'ramallah', 'cairo', 'alexandria',
  'tripoli', 'benghazi', 'tunis', 'algiers', 'casablanca', 'rabat',
  'ankara', 'istanbul', 'izmir',
  // Africa (sub-Saharan)
  'lagos', 'abuja', 'accra', 'nairobi', 'addis ababa', 'khartoum', 'juba',
  'kampala', 'kigali', 'dakar', 'bamako', 'ouagadougou', 'niamey',
  'johannesburg', 'cape town', 'pretoria', 'harare', 'lusaka', 'maputo',
  'kinshasa', 'brazzaville', 'luanda', 'antananarivo', 'mogadishu',
  // Asia
  'beijing', 'shanghai', 'hong kong', 'taipei', 'tokyo', 'osaka', 'kyoto',
  'seoul', 'pyongyang', 'delhi', 'new delhi', 'mumbai', 'kolkata', 'chennai',
  'bengaluru', 'hyderabad', 'islamabad', 'karachi', 'lahore', 'kabul',
  'dhaka', 'colombo', 'kathmandu', 'rangoon', 'yangon', 'naypyidaw',
  'bangkok', 'phnom penh', 'hanoi', 'ho chi minh city', 'saigon',
  'vientiane', 'kuala lumpur', 'jakarta', 'manila', 'singapore',
  // Oceania
  'canberra', 'sydney', 'melbourne', 'auckland', 'wellington',
  // Latin America (south)
  'brasilia', 'rio de janeiro', 'sao paulo', 'buenos aires', 'santiago',
  'lima', 'bogota', 'caracas', 'quito', 'la paz', 'asuncion', 'montevideo',
];

const REGIONS = [
  // Geopolitical / geographic regions that travel as wire headline entities.
  'middle east', 'north africa', 'sub-saharan africa', 'horn of africa',
  'west bank', 'gaza strip', 'sinai',
  'balkans', 'caucasus', 'central asia', 'south asia', 'southeast asia',
  'east asia', 'latin america', 'caribbean', 'scandinavia', 'baltics',
  'eu', 'nato', 'asean', 'gulf',
  // Bodies of water / straits that name-drive news events.
  'hormuz', 'strait of hormuz', 'bab el-mandeb', 'red sea', 'black sea',
  'south china sea', 'east china sea', 'baltic sea', 'mediterranean',
  'persian gulf', 'arabian gulf', 'gulf of aden', 'gulf of oman',
  'taiwan strait', 'english channel',
  // Commonly-named disputed / conflict zones.
  'donbas', 'donbass', 'crimea', 'kashmir', 'tibet', 'xinjiang',
  'nagorno-karabakh', 'transnistria',
];

// Country names are INTENTIONALLY NOT in LOCATION_GAZETTEER — in news
// headlines the country is usually the political actor ("Iran closes
// Hormuz") not the venue, so the veto classifies country tokens as
// actors. The COUNTRIES array is still exported below so a caller
// that needs the list (e.g. a future NER pass) can consume it.
export const LOCATION_GAZETTEER = new Set([
  ...CITIES,
  ...REGIONS,
]);

export const COUNTRY_NAMES = new Set(COUNTRIES);

// ── Common capitalized English words that are NOT entities ─────────────
// Sentence-initial capitalisation and a few idiom-openers that the
// veto would otherwise pick up as proper nouns.

export const COMMON_CAPITALIZED = new Set([
  // Articles / determiners / pronouns
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any',
  'all', 'every', 'each', 'no', 'none', 'other', 'another',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his',
  'her', 'its', 'our', 'their',
  // Prepositions / conjunctions / common sentence starters
  'in', 'on', 'at', 'by', 'to', 'for', 'of', 'with', 'from', 'up',
  'down', 'out', 'into', 'onto', 'over', 'under', 'after', 'before',
  'during', 'since', 'until', 'as', 'than', 'then', 'so', 'but', 'and',
  'or', 'nor', 'yet', 'if', 'because', 'while', 'when', 'where',
  'why', 'how', 'who', 'what', 'which', 'whose',
  // Common news-headline sentence starters
  'breaking', 'report', 'reports', 'new', 'latest', 'today', 'yesterday',
  'now', 'live', 'updates', 'update', 'analysis', 'opinion', 'exclusive',
  'video', 'watch', 'listen', 'read',
  // Auxiliary / modal verbs that may lead a headline
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must',
]);
