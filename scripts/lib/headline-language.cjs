'use strict';

// Is this headline written in a language other than English?
//
// The catalog's language tag is per feed and can be missing or wrong (an
// untagged Norwegian feed alerted English subscribers), and one feed can mix
// languages. This is the per-headline backstop for the alert path.
//
// It answers yes only on positive evidence of another language: mostly
// non-Latin letters, or at least two function words of another language
// outnumbering the English ones. A terse headline with no function words is
// never called foreign, so an English alert is not lost to a guess.

// Lowercase function words that are not English words, English abbreviations
// or name particles ("de", "la", "van", "al", "bin" are deliberately absent:
// "Rio de Janeiro", "Lula da Silva", "al-Shabaab" are English headlines).
const OTHER_LANGUAGE_WORDS = new Set([
  // Spanish, Portuguese
  'los', 'las', 'una', 'por', 'para', 'que', 'según', 'tras', 'sobre', 'entre', 'desde', 'hasta', 'está', 'fue',
  'sus', 'como', 'más', 'pero', 'este', 'esta', 'también', 'ante', 'y', 'uma', 'não', 'com', 'são', 'mais', 'após',
  'diz', 'ao', 'pela', 'pelo', 'nas', 'seu', 'sua', 'foi', 'tem', 'em', 'num', 'numa', 'aos', 'às',
  // French
  'les', 'des', 'une', 'est', 'dans', 'pour', 'sur', 'avec', 'qui', 'aux', 'ses', 'sont', 'après', 'contre', 'selon',
  'mais', 'cette', 'être', 'leur', 'où', 'au', 'et', 'ce', 'ont', 'été',
  // German, Dutch
  'der', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'dem', 'ein', 'eine', 'einer', 'zu', 'nach', 'bei', 'gegen',
  'über', 'wird', 'sich', 'auch', 'als', 'aus', 'vor', 'sind', 'wie', 'im', 'zum', 'zur', 'noch', 'nur', 'oder',
  'het', 'een', 'niet', 'voor', 'zijn', 'naar', 'ook', 'bij', 'uit', 'aan', 'maar', 'wordt', 'werd', 'tegen', 'op',
  // Italian
  'il', 'gli', 'che', 'della', 'delle', 'degli', 'nel', 'nella', 'sono', 'più', 'anche', 'dopo', 'alla', 'dei', 'è',
  'tra', 'sul', 'dal', 'dalla',
  // Norwegian, Danish, Swedish, Finnish
  'og', 'av', 'på', 'til', 'er', 'som', 'har', 'ikke', 'med', 'fra', 'etter', 'efter', 'mot', 'ved', 'kan', 'skal',
  'och', 'att', 'för', 'är', 'inte', 'från', 'till', 'om', 'det', 'ett', 'blir', 'ble', 'blev', 'vil', 'seg', 'sig',
  'än', 'när', 'mod', 'af', 'hos', 'å', 'i', 'ja', 'ei', 'että', 'oli',
  // Polish, Czech, Slovak, South Slavic (Latin script), Romanian, Hungarian
  'się', 'nie', 'na', 'że', 'jest', 'przez', 'dla', 'jak', 'od', 'po', 'czy', 'oraz', 'przed', 'pod', 'już', 'tylko',
  'są', 'ze', 'za', 'w', 'z', 'o', 'se', 'je', 'při', 'podle', 'jako', 'nebo', 'proti', 'kod', 'zbog', 'nakon', 'și',
  'în', 'din', 'pentru', 'către', 'este', 'după', 'sau', 'és', 'hogy', 'nem', 'egy', 'az', 'már', 'csak',
  // Turkish, Indonesian, Malay, Vietnamese, Swahili
  've', 'bir', 'için', 'ile', 'bu', 'olarak', 'daha', 'çok', 'gibi', 'sonra', 'kadar', 'ancak', 'yang', 'dan',
  'dari', 'untuk', 'dengan', 'pada', 'dalam', 'ini', 'itu', 'tidak', 'akan', 'oleh', 'juga', 'telah', 'của', 'và',
  'là', 'có', 'được', 'cho', 'với', 'không', 'tại', 'trong', 'ya', 'wa', 'kwa', 'katika',
]);

// Hausa function words. None is an English word or name particle ("da", "a"
// and "ga" are left out). Hausa outlets title-case headlines, so the words
// that are not also names count capitalized too; "Amma", "Wanda", "Bayan",
// "Inda", "Wata", "Wani", "Domin" and "Tare" are names in English headlines.
const HAUSA_TITLE_CASE_WORDS = new Set([
  'cikin', 'kuma', 'daga', 'saboda', 'yadda', 'zai', 'za', 'ta', 'suka', 'wadda', 'kafin',
]);
const HAUSA_WORDS = new Set([
  ...HAUSA_TITLE_CASE_WORDS, 'amma', 'wani', 'wata', 'bayan', 'domin', 'tare', 'wanda', 'inda',
]);

const ENGLISH_WORDS = new Set([
  'the', 'of', 'and', 'to', 'in', 'for', 'on', 'with', 'as', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'after',
  'over', 'says', 'say', 'his', 'her', 'its', 'their', 'has', 'have', 'had', 'will', 'not', 'that', 'this', 'be',
  'an', 'a', 'into', 'amid', 'against', 'who', 'what', 'how', 'why', 'new', 'more', 'than', 'but', 'or', 'it',
  'about', 'out', 'up', 'no', 'can', 'could', 'would', 'may', 'been', 'he', 'she', 'they', 'we', 'you', 'us',
]);

// Hausa's hooked letters are Latin script, so the non-Latin share misses them,
// and English spells the names that carry them without the hook ("Dangote").
const HAUSA_HOOKED_WORD = /[ɓɗƙƴƁƊƘƳ]/u;

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
// An apostrophe stays inside its word: "I've" must not yield Turkish "ve",
// nor "'em" Portuguese "em".
const WORD_BREAK = /[^\p{L}\p{M}'\u2019]+/u;
const WHITESPACE = /\s+/u;
// "Mining.com.au" is a name, not Portuguese "com" and French "au". Tested per
// token, so one long unbroken title costs one linear scan.
const DOTTED_NAME = /\.\p{L}{2}/u;

/**
 * @param {unknown} title
 * @returns {boolean} true only when the headline shows another language.
 */
function headlineInOtherLanguage(title) {
  if (typeof title !== 'string') return false;
  // NFKC folds styled letters (mathematical bold) back to the plain ones.
  const text = title.normalize('NFKC');
  let letters = 0;
  let nonLatin = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters++;
    if (!LATIN.test(char)) nonLatin++;
  }
  if (letters === 0) return false;
  if (nonLatin / letters > 0.5) return true;

  const other = new Set();
  let english = 0;
  // Distinct words, so a name repeated in one headline is one piece of evidence.
  const hooked = new Set();
  const words = text.split(WHITESPACE).flatMap(token => (DOTTED_NAME.test(token) ? [] : token.split(WORD_BREAK)));
  for (const word of words) {
    const lower = word.toLowerCase();
    if (HAUSA_HOOKED_WORD.test(word)) hooked.add(lower);
    if (HAUSA_WORDS.has(word) || HAUSA_TITLE_CASE_WORDS.has(lower)) other.add(lower);
    // Case matters: "I" is English and "i" is Norwegian or Polish; "De" opens a name.
    else if (OTHER_LANGUAGE_WORDS.has(word)) other.add(word);
    else if (ENGLISH_WORDS.has(word.toLowerCase())) english++;
  }
  // One hooked word can be a name; two are a Hausa sentence.
  if (hooked.size >= 2) return true;
  return other.size >= 2 && other.size > english;
}

module.exports = { headlineInOtherLanguage };
