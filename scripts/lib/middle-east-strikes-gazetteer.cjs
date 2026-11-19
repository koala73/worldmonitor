'use strict';

// Place resolution for the Middle East strike feed (conflict:iran-events:v1).
//
// Base table: scripts/data/outbreak-places.json (GeoNames cities15000 + admin1,
// see scripts/build-outbreak-places.mjs), restricted to FOCUS_COUNTRIES. On top
// of it: Arabic/Persian names, spelling variants, and military/energy sites that
// GeoNames' 15k-population cut leaves out (Ras Tanura, Natanz, Al Udeid, ...).
//
// A place that cannot be resolved falls back to its country's centroid, never
// to another country's (the old manual seeder defaulted every miss to the Iran
// centroid, so a Jizan strike was plotted and scored in Iran).

const OUTBREAK_PLACES = require('../data/outbreak-places.json');

const FOCUS_COUNTRIES = Object.freeze(['SA', 'YE', 'IR', 'IQ', 'AE', 'IL', 'QA', 'KW', 'BH', 'OM', 'LB', 'SY', 'JO']);
const FOCUS_SET = new Set(FOCUS_COUNTRIES);

const COUNTRY_NAMES = Object.freeze({
  SA: 'Saudi Arabia', YE: 'Yemen', IR: 'Iran', IQ: 'Iraq', AE: 'United Arab Emirates', IL: 'Israel',
  QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', LB: 'Lebanon', SY: 'Syria', JO: 'Jordan',
});

// Interior points, each inside its own country (pinned by tests). Used only
// when a report names a country but no resolvable place.
const COUNTRY_CENTROIDS = Object.freeze({
  SA: [24.0, 45.0], YE: [15.5, 47.5], IR: [32.43, 53.69], IQ: [33.2, 43.7], AE: [23.9, 54.3],
  IL: [31.0, 34.85], QA: [25.29, 51.53], KW: [29.31, 47.48], BH: [26.07, 50.55], OM: [21.0, 57.0],
  LB: [33.89, 35.86], SY: [35.0, 38.5], JO: [31.24, 36.51],
});

// Where a post says something happened, in the languages the curated channels
// post in. Location terms only: actor names (Houthi, IRGC) are anchors, not places.
const COUNTRY_TERMS = Object.freeze({
  SA: ['saudi arabia', 'saudi', 'ksa', 'السعودية', 'السعودي', 'عربستان'],
  YE: ['yemen', 'yemeni', 'اليمن', 'اليمني', 'یمن'],
  IR: ['iran', 'iranian', 'إيران', 'ايران', 'ایران'],
  IQ: ['iraq', 'iraqi', 'العراق', 'عراق'],
  AE: ['uae', 'united arab emirates', 'emirates', 'emirati', 'الإمارات', 'الامارات', 'امارات'],
  IL: ['israel', 'israeli', 'إسرائيل', 'اسرائيل', 'اسرائیل'],
  QA: ['qatar', 'qatari', 'قطر'],
  KW: ['kuwait', 'kuwaiti', 'الكويت', 'کویت'],
  BH: ['bahrain', 'bahraini', 'البحرين', 'بحرین'],
  OM: ['oman', 'omani'],
  LB: ['lebanon', 'lebanese', 'لبنان'],
  SY: ['syria', 'syrian', 'سوريا', 'سورية', 'سوریه'],
  JO: ['jordan', 'jordanian', 'الأردن', 'الاردن', 'اردن'],
});

// Gazetteer names that are also ordinary English words. They resolve when a
// classifier names them as the place, but never from free-text scanning
// ("a hail of drones" is not Ha'il).
const FREE_TEXT_STOPWORDS = new Set(['hail', 'salt', 'as salt', 'duma', 'tyre']);

// Palestinian places are outside this feed. Without this, a classifier that
// files a Gaza strike under Israel would plot it at the Israel centroid.
const PALESTINE_TERMS = [
  'gaza', 'gaza city', 'gaza strip', 'khan yunis', 'khan younis', 'rafah', 'jabalia', 'jabalya', 'deir al balah',
  'deir el balah', 'nuseirat', 'beit lahia', 'beit hanoun', 'west bank', 'jenin', 'nablus', 'tulkarm', 'ramallah',
  'hebron', 'bethlehem', 'qalqilya', 'غزة', 'خان يونس', 'رفح', 'جباليا', 'دير البلح', 'النصيرات', 'الضفة الغربية', 'جنين', 'نابلس', 'طولكرم', 'رام الله',
];

// Anchor-only terms: they put a post in the theater but say nothing about where.
const THEATER_TERMS = Object.freeze([
  'houthi', 'houthis', 'ansar allah', 'ansarallah', 'irgc', 'hezbollah', 'red sea', 'gulf of aden',
  'persian gulf', 'arabian gulf', 'strait of hormuz', 'hormuz', 'bab el mandeb', 'bab al mandab',
  'الحوثي', 'الحوثيين', 'أنصار الله', 'انصار الله', 'حزب الله', 'البحر الأحمر', 'البحر الاحمر', 'سپاه',
]);

// [iso2, canonical English name, lat|null, lon|null, ...aliases]. lat/lon null
// means "same coordinates as the base-table row with that canonical name".
const SUPPLEMENT = [
  ['SA', 'Riyadh', null, null, 'ar riyad', 'الرياض'],
  ['SA', 'Jeddah', null, null, 'jiddah', 'jedda', 'جدة'],
  ['SA', 'Dammam', null, null, 'الدمام'],
  ['SA', 'Dhahran', 26.29, 50.11, 'الظهران'],
  ['SA', 'Khobar', null, null, 'al khobar', 'الخبر'],
  ['SA', 'Ras Tanura', 26.64, 50.16, 'رأس تنورة', 'راس تنورة'],
  ['SA', 'Abqaiq', 25.94, 49.67, 'buqayq', 'بقيق'],
  ['SA', 'Al Jubayl', null, null, 'jubail', 'الجبيل'],
  ['SA', 'Jizan', null, null, 'jazan', 'gizan', 'جازان', 'جيزان'],
  ['SA', 'Najran', null, null, 'نجران'],
  ['SA', 'Abha', null, null, 'أبها', 'ابها'],
  ['SA', 'Khamis Mushait', null, null, 'khamis mushayt', 'خميس مشيط'],
  ['SA', 'Yanbu', null, null, 'yanbu al bahr', 'ينبع'],
  ['SA', 'Ta\'if', null, null, 'taif', 'الطائف'],
  ['SA', 'Mecca', null, null, 'makkah', 'مكة'],
  ['SA', 'Medina', null, null, 'المدينة المنورة'],
  ['SA', 'Tabuk', null, null, 'تبوك'],
  ['SA', 'Hafar Al-Batin', null, null, 'hafr al batin', 'حفر الباطن'],
  ['SA', 'Sabya', null, null, 'صبيا'],
  ['SA', 'Samtah', 16.6, 42.94, 'صامطة'],
  ['SA', 'Abu Arish', 16.97, 42.83, 'أبو عريش', 'ابو عريش'],
  ['SA', 'Dhahran al-Janub', 17.67, 43.51, 'ظهران الجنوب'],
  ['SA', 'Sharurah', 17.47, 47.11, 'sharourah', 'شرورة'],
  ['SA', 'Prince Sultan Air Base', 24.06, 47.58, 'prince sultan airbase'],
  ['SA', 'King Khalid Military City', 27.9, 45.53],
  ['YE', 'Sanaa', null, null, 'صنعاء'],
  ['YE', 'Al Hudaydah', null, null, 'hodeidah', 'hudaydah', 'hodeida', 'الحديدة'],
  ['YE', 'Ma\'rib', null, null, 'مأرب', 'مارب'],
  ['YE', 'Aden', null, null, 'عدن'],
  ['YE', 'Sa\'dah', null, null, 'saada', 'saadah', 'صعدة'],
  ['YE', 'Ta\'izz', null, null, 'تعز'],
  ['YE', 'Hajjah', null, null, 'حجة'],
  ['YE', 'Mukalla', null, null, 'المكلا'],
  ['YE', 'Dhamar', null, null, 'ذمار'],
  ['YE', 'Omran', null, null, 'amran', 'عمران'],
  ['YE', 'Ras Isa', 15.24, 42.61, 'ras issa', 'رأس عيسى'],
  ['YE', 'Mocha', 13.32, 43.25, 'mokha', 'al mukha', 'المخا'],
  ['IR', 'Tehran', null, null, 'teheran', 'طهران', 'تهران'],
  ['IR', 'Isfahan', null, null, 'esfahan', 'أصفهان', 'اصفهان'],
  ['IR', 'Natanz', 33.72, 51.73, 'نطنز'],
  ['IR', 'Fordow', 34.88, 50.99, 'fordo', 'فردو'],
  ['IR', 'Kharg Island', 29.26, 50.33, 'kharg', 'خارك', 'خارگ'],
  ['IR', 'Bushehr', null, null, 'بوشهر'],
  ['IR', 'Bandar Abbas', null, null, 'بندر عباس'],
  ['IR', 'Shiraz', null, null, 'شيراز', 'شیراز'],
  ['IR', 'Tabriz', null, null, 'تبريز', 'تبریز'],
  ['IR', 'Qom', 34.64, 50.88, 'قم'],
  ['IR', 'Arak', 34.09, 49.69, 'أراك', 'اراک'],
  ['IR', 'Parchin', 35.52, 51.77, 'پارچین'],
  ['IR', 'Ahvaz', null, null, 'ahwaz', 'الأهواز', 'اهواز'],
  // Maritime and coastal points: tanker and mine incidents otherwise fall back
  // to the inland country centroid. The strait is filed under Iran because
  // that is where the CII bbox lookup attributes its coordinates.
  ['IR', 'Strait of Hormuz', 26.57, 56.25, 'hormuz strait', 'مضيق هرمز', 'تنگه هرمز'],
  ['IR', 'Sirik', 26.52, 57.1, 'سیریک'],
  ['IR', 'Kuhestak', 26.8, 57.03],
  ['IR', 'Jask', 25.64, 57.77, 'جاسک'],
  ['IR', 'Bandar Lengeh', 26.56, 54.88],
  ['YE', 'Shabwah', null, null, 'shabwa', 'شبوة'],
  ['YE', 'Ibb', 13.97, 44.18, 'إب'],
  ['IQ', 'Baghdad', null, null, 'بغداد'],
  ['IQ', 'Erbil', null, null, 'arbil', 'أربيل', 'اربيل'],
  ['IQ', 'Ain al-Asad Air Base', 33.8, 42.44, 'ain al asad', 'al asad air base', 'عين الأسد'],
  ['IQ', 'Kirkuk', null, null, 'كركوك'],
  ['IL', 'Tel Aviv', null, null, 'تل أبيب', 'تل ابيب'],
  ['IL', 'Haifa', null, null, 'حيفا'],
  ['IL', 'Eilat', 29.56, 34.95, 'إيلات', 'ايلات', 'أم الرشراش'],
  ['IL', 'Dimona', 31.07, 35.03, 'ديمونا'],
  ['IL', 'Nevatim Air Base', 31.21, 35.01, 'nevatim'],
  ['IL', 'Beersheba', null, null, 'beer sheva', 'بئر السبع'],
  ['IL', 'Ashkelon', null, null, 'عسقلان'],
  ['IL', 'Ashdod', null, null, 'أسدود', 'اسدود'],
  ['IL', 'Ben Gurion Airport', 32.0, 34.88, 'ben gurion'],
  ['LB', 'Beirut', null, null, 'بيروت'],
  ['LB', 'Dahiyeh', 33.85, 35.51, 'dahieh', 'dahiya', 'الضاحية'],
  ['LB', 'Sidon', null, null, 'saida', 'صيدا'],
  ['LB', 'Nabatieh', null, null, 'النبطية'],
  ['LB', 'Baalbek', 34.0, 36.21, 'بعلبك'],
  ['LB', 'Bint Jbeil', 33.12, 35.43, 'بنت جبيل'],
  ['SY', 'Damascus', null, null, 'دمشق'],
  ['SY', 'Aleppo', null, null, 'حلب'],
  ['SY', 'Homs', null, null, 'حمص'],
  ['SY', 'Latakia', null, null, 'اللاذقية'],
  ['SY', 'Tartus', null, null, 'طرطوس'],
  ['SY', 'Deir ez-Zor', null, null, 'deir ezzor', 'دير الزور'],
  ['SY', 'Palmyra', 34.56, 38.28, 'tadmur', 'تدمر'],
  ['AE', 'Abu Dhabi', null, null, 'أبوظبي', 'ابوظبي', 'أبو ظبي'],
  ['AE', 'Dubai', null, null, 'دبي'],
  ['AE', 'Fujairah', null, null, 'الفجيرة'],
  ['AE', 'Sharjah', null, null, 'الشارقة'],
  ['AE', 'Al Dhafra Air Base', 24.25, 54.55, 'al dhafra'],
  ['AE', 'Ruwais', 24.11, 52.73, 'الرويس'],
  ['QA', 'Doha', null, null, 'الدوحة'],
  ['QA', 'Al Udeid Air Base', 25.12, 51.32, 'al udeid', 'العديد'],
  ['QA', 'Ras Laffan', 25.91, 51.55, 'راس لفان', 'رأس لفان'],
  ['KW', 'Kuwait City', 29.37, 47.98, 'مدينة الكويت'],
  ['KW', 'Camp Arifjan', 28.93, 48.1, 'arifjan'],
  ['KW', 'Ali Al Salem Air Base', 29.35, 47.52, 'ali al salem'],
  ['BH', 'Manama', null, null, 'المنامة'],
  ['BH', 'Juffair', 26.21, 50.6],
  ['BH', 'Sitra', 26.15, 50.62],
  ['OM', 'Muscat', null, null, 'مسقط'],
  ['OM', 'Duqm', 19.66, 57.7, 'الدقم'],
  ['JO', 'Amman', null, null],
  ['JO', 'Aqaba', null, null, 'العقبة'],
  ['JO', 'Muwaffaq Salti Air Base', 31.83, 36.79],
];

// Latin names shorter than this are kept for exact lookups (an LLM-named
// "Ibb") but never used to anchor free text, where they collide with words.
const MIN_LATIN_ANCHOR_CHARS = 4;
const LATIN_LEADING_ARTICLE = /^(?:al|el|ar|as|ad|an|az|ash|at|adh|ad) /;

function normalizePlaceName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟٕٔ]/g, '')
    .toLowerCase()
    .replace(/[یى]/g, 'ي') // Persian yeh / alef maksura -> Arabic yeh
    .replace(/ک/g, 'ك') // Persian kaf -> Arabic kaf
    .replace(/[آأإ]/g, 'ا') // alef variants (when not decomposed)
    .replace(/['`‘’ʻʼʾʿ′]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Latin only. Arabic names keep their article: bare stems are common words
// (الخبر Khobar -> خبر "news", العديد Al Udeid -> عديد "numerous").
function stripArticle(normalized) {
  return normalized.replace(LATIN_LEADING_ARTICLE, '');
}

const ADMIN_AREA_RE = /\b(?:region|province|governorate|district|municipality|county)\b|^muhafazat\b/i;

// GeoNames lists a city and its admin area at the same point ("Jazan Region",
// "Jazan", "Jizan"), so rows sharing a point in one country are one place
// under a city name. Supplement rows without coordinates rename that place to
// the canonical English spelling and add aliases.
function buildIndex() {
  const byCountry = new Map(FOCUS_COUNTRIES.map((iso2) => [iso2, new Map()]));
  const byPoint = new Map();
  const places = [];
  const register = (place, terms) => {
    const index = byCountry.get(place.iso2);
    for (const term of terms) {
      const normalized = normalizePlaceName(term);
      if (!normalized) continue;
      for (const variant of new Set([normalized, stripArticle(normalized)])) {
        if (variant && !index.has(variant)) index.set(variant, place);
      }
    }
  };
  for (const iso2 of FOCUS_COUNTRIES) {
    for (const [name, lat, lon] of OUTBREAK_PLACES[iso2] || []) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const pointKey = `${iso2}:${lat.toFixed(2)},${lon.toFixed(2)}`;
      let place = byPoint.get(pointKey);
      if (!place) {
        place = { iso2, name: null, adminName: name, lat, lon };
        byPoint.set(pointKey, place);
        places.push(place);
      }
      // Shortest non-admin name: a city shares its point with an unsuffixed
      // province row ("Nineveh" for Mosul, "Northern Borders" for Arar).
      if (!ADMIN_AREA_RE.test(name) && (!place.name || name.length < place.name.length)) place.name = name;
      register(place, [name]);
    }
  }
  for (const place of places) place.name = place.name || place.adminName;
  for (const [iso2, name, lat, lon, ...aliases] of SUPPLEMENT) {
    if (lat == null) {
      const existing = byCountry.get(iso2).get(normalizePlaceName(name));
      if (!existing) throw new Error(`gazetteer supplement ${iso2}:${name} has no base-table row`);
      existing.name = name;
      register(existing, [name, ...aliases]);
    } else {
      const place = { iso2, name, lat, lon };
      places.push(place);
      register(place, [name, ...aliases]);
    }
  }
  const usedKeys = new Set();
  for (const place of places) {
    delete place.adminName;
    const base = `${place.iso2}:${normalizePlaceName(place.name).replace(/ /g, '-')}`;
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
    usedKeys.add(key);
    place.key = key;
  }
  return { byCountry, places };
}

const INDEX = buildIndex();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One alternation per country, longest names first, so "Khamis Mushait" wins
// over a shorter overlapping name. Both scripts match on word edges; Arabic
// also allows the one- or two-letter proclitics that attach to a name
// (بالرياض = ب + الرياض, والحديدة = و + الحديدة).
function buildMatcher(terms) {
  const latin = [];
  const arabic = [];
  for (const term of [...new Set(terms)].sort((a, b) => b.length - a.length)) {
    if (/^[a-z0-9 ]+$/.test(term)) {
      if (term.length >= MIN_LATIN_ANCHOR_CHARS || /^(ksa|uae)$/.test(term)) latin.push(escapeRegExp(term));
    } else {
      arabic.push(escapeRegExp(term));
    }
  }
  const parts = [];
  if (latin.length) parts.push(`(?<![\\p{L}\\p{N}])(?<l>${latin.join('|')})(?![\\p{L}\\p{N}])`);
  if (arabic.length) parts.push(`(?<![\\p{L}\\p{N}])[وفبلك]{0,2}(?<a>${arabic.join('|')})(?![\\p{L}\\p{N}])`);
  return parts.length ? new RegExp(parts.join('|'), 'gu') : null;
}

const PLACE_MATCHERS = new Map(FOCUS_COUNTRIES.map((iso2) => [
  iso2,
  buildMatcher([...INDEX.byCountry.get(iso2).keys()].filter((term) => !FREE_TEXT_STOPWORDS.has(term))),
]));
const PALESTINE_MATCHER = buildMatcher(PALESTINE_TERMS.map(normalizePlaceName));

function namesPalestinianPlace(text) {
  const normalized = normalizePlaceName(text);
  return Boolean(normalized && firstMatch(PALESTINE_MATCHER, normalized));
}
const COUNTRY_MATCHERS = new Map(FOCUS_COUNTRIES.map((iso2) => [
  iso2,
  buildMatcher(COUNTRY_TERMS[iso2].map(normalizePlaceName)),
]));
const THEATER_MATCHER = buildMatcher(THEATER_TERMS.map(normalizePlaceName));

// Earliest mention: { term, index }. matchAll returns matches left to right,
// and the length-sorted alternation already prefers the longest name at a position.
function firstMatch(matcher, text) {
  if (!matcher) return null;
  for (const match of text.matchAll(matcher)) {
    const term = match.groups.l ?? match.groups.a;
    return { term, index: match.index };
  }
  return null;
}

/** Earliest place mention in `text`, optionally limited to one country. */
function findPlaceInText(text, iso2 = null) {
  const normalized = normalizePlaceName(text);
  if (!normalized) return null;
  let best = null;
  for (const code of iso2 ? [iso2] : FOCUS_COUNTRIES) {
    if (!FOCUS_SET.has(code)) continue;
    const match = firstMatch(PLACE_MATCHERS.get(code), normalized);
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, place: INDEX.byCountry.get(code).get(match.term) };
    }
  }
  return best ? best.place : null;
}

/** Countries named as locations in `text`, in order of first mention. */
function findCountriesInText(text) {
  const normalized = normalizePlaceName(text);
  const hits = [];
  for (const iso2 of FOCUS_COUNTRIES) {
    const match = firstMatch(COUNTRY_MATCHERS.get(iso2), normalized);
    if (match) hits.push({ iso2, index: match.index });
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.iso2);
}

/** True when the text names a focus country, place, or theater actor/waterway. */
function mentionsTheater(text) {
  const normalized = normalizePlaceName(text);
  if (!normalized) return false;
  if (firstMatch(THEATER_MATCHER, normalized)) return true;
  return FOCUS_COUNTRIES.some((iso2) => firstMatch(COUNTRY_MATCHERS.get(iso2), normalized)
    || firstMatch(PLACE_MATCHERS.get(iso2), normalized));
}

function lookupExact(name, iso2) {
  const normalized = normalizePlaceName(name);
  if (!normalized) return null;
  const index = INDEX.byCountry.get(iso2);
  return index.get(normalized) || index.get(stripArticle(normalized)) || null;
}

function countryPlace(iso2) {
  const [lat, lon] = COUNTRY_CENTROIDS[iso2];
  return { iso2, name: COUNTRY_NAMES[iso2], key: `${iso2}:*`, lat, lon, countryLevel: true };
}

/**
 * Resolve a reported place to coordinates.
 *   1. exact name in the reported country, then any place named inside the string;
 *   2. the same in another focus country when exactly one has it (the classifier
 *      named the attacker's country, say);
 *   3. the post text, scanned for the reported country's places;
 *   4. the reported country's centroid.
 * Returns null when nothing ties the report to a focus country, or when the
 * place is Palestinian (out of scope) rather than a fallback centroid.
 */
function resolvePlace({ place, iso2, text } = {}) {
  const country = FOCUS_SET.has(iso2) ? iso2 : null;
  // A valid country code outside the theater means the impact was located
  // there ("Tripoli, LY"); it is not a hint to search the theater for the name.
  if (!country && typeof iso2 === 'string' && /^[A-Z]{2}$/.test(iso2)) return null;
  if (place && namesPalestinianPlace(place)) return null;
  if (place) {
    if (country) {
      const hit = lookupExact(place, country) || findPlaceInText(place, country);
      if (hit) return hit;
    }
    const elsewhere = FOCUS_COUNTRIES
      .filter((code) => code !== country)
      .map((code) => lookupExact(place, code))
      .filter(Boolean);
    if (elsewhere.length === 1) return elsewhere[0];
  }
  if (country && text) {
    const hit = findPlaceInText(text, country);
    if (hit) return hit;
  }
  // Nothing in the theater was named; a Palestinian place in the post means
  // the classifier filed a Gaza or West Bank strike under a neighbour.
  if (text && namesPalestinianPlace(text)) return null;
  return country ? countryPlace(country) : null;
}

const EARTH_RADIUS_KM = 6371;
function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest gazetteer place in `iso2` within `maxKm`, else null. */
function nearestPlace(lat, lon, iso2, maxKm) {
  let best = null;
  for (const place of INDEX.places) {
    if (place.iso2 !== iso2) continue;
    const km = distanceKm(lat, lon, place.lat, place.lon);
    if (km <= maxKm && (!best || km < best.km)) best = { km, place };
  }
  return best ? best.place : null;
}

module.exports = {
  FOCUS_COUNTRIES,
  COUNTRY_NAMES,
  COUNTRY_CENTROIDS,
  normalizePlaceName,
  findPlaceInText,
  findCountriesInText,
  mentionsTheater,
  resolvePlace,
  countryPlace,
  nearestPlace,
  distanceKm,
  gazetteerPlaces: () => INDEX.places.slice(),
};
